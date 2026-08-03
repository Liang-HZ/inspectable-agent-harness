← Previous: [03 · Two graphs, not one](03-two-graphs.md) · [Chapter index](README.md) · Next: [05 · An exit that binds no vendor](05-export-without-a-vendor.md)

# 04 · The subagent runs in another file

Chapter 23's gap map lists `Subagent` as *none*, with the reasoning that
"introducing it while the single loop is still being polished would only dilute
the main thread".

The single loop is stable now. And subagents happen to be the first real test of
the trace structure from the last section.

## Why a subagent needs its own file

The entire point of a subagent is an **independent context window**: the main
conversation does not want to be flooded with the intermediate output of a broad
survey, so it delegates and keeps only the conclusion.

Where does that history go?

Interleaved into the same JSONL, Chapter 20's session replay breaks. Replay
works by re-applying `response_item` records in order; a subagent's messages
mixed in would corrupt the parent's history and replay a conversation that never
happened.

So: **its own file.** Which is what Claude Code does:

```
rollout-<ts>-<id>.jsonl
rollout-<ts>-<id>/
  subagents/agent-<agentId>.jsonl        # the child's full transcript
  subagents/agent-<agentId>.meta.json    # a much smaller index
```

The `.meta.json` duplicates what is already in the transcript's first record.
**Deliberately**: enumerating a run's children is then a directory listing and a
few hundred-byte reads, instead of opening transcripts that can be megabytes.

## The seam: a location you have to find first

The `task` tool needs to spawn an entire run. But a tool's execution signature is:

```ts
execute: (
  argumentsJson: string,
  signal: AbortSignal | undefined,
  runtime: AgentToolRuntimeContext,
) => AgentToolResult | Promise<AgentToolResult>;
```

No `AgentRunContext`, no `callbacks`, no model gateway, no session handle.

The only place in the repository holding all of those at once is the few lines in
`agent-tool-runtime.ts` that build the runtime context:

```ts
toolDefinition.execute(
  toolCall.argumentsJson,
  toolAbortController.signal,
  {
    pathAccess: resolveAgentPathAccessForRunPolicy(...),
    sandboxMode: context.policy.sandboxMode,
    spawnSubagent: bindSubagentSpawner(context, toolCall, toolSpan),  // new
  },
)
```

So `AgentToolDefinition` needs **no change at all**, and the other six tools are
none the wiser.

`bindSubagentSpawner` does exactly one thing — **close over this call's id and
span**:

```ts
return (request) =>
  spawnSubagent({
    ...request,
    toolCallId: toolCall.id,
    parentSpan: toolSpan,
  });
```

The `task` tool never learns its own call id or span. It asks for a subagent and
gets an answer. **Parent/child correctness is a runtime invariant, not the
tool's responsibility** — a buggy tool cannot mis-link it.

## What holds the chain across files

Two threads, both required.

**On disk**, `toolCallId`:

```json
{"agentType":"general-purpose","description":"...","toolCallId":"toolu_01BYZ...","spawnDepth":1}
```

The same foreign key Claude Code uses — the child's meta records which tool call
spawned it.

**On the span axis**, an inherited trace id:

```ts
span: createChildSpanContext(request.parentSpan),
```

`createChildSpanContext` inherits `traceId` and mints a new `spanId`. So the
child's root span and every span of the parent run are **in one trace**, despite
living in two files.

Export needs no stitching: the backend sees a shared trace id and assembles the
tree itself.

## Inherited, and deliberately not

This table is the thing to remember from this section:

| | Subagent | Why |
| --- | --- | --- |
| policy / sandboxMode | **inherited** | a child must not be more permissive than its parent, or spawning becomes privilege escalation |
| abort signal | **inherited** | cancelling the parent must stop the child, or you leave an orphan run burning tokens |
| model config | inherited | switching models per subagent is not supported yet |
| `toolState.readFilePaths` | **not inherited — fresh** | see below |
| conversation history | **not inherited** | the independent context window is the whole point |

The `readFilePaths` row is worth expanding. Chapter 12 established that `edit`
requires a prior `read`, tracked in `context.toolState.readFilePaths`.

Inherit it and this becomes possible: the parent read `lib/agent.ts`, the child
did not, and the child can edit it anyway. **A safety interlock bypassed by
delegating.**

So the child starts with an empty set. The reason is pinned at the construction
site:

```ts
toolState: {
  // Deliberately not inherited by a subagent: read-before-edit state is a
  // safety interlock, and a derived run has to earn it by reading the file
  // itself.
  readFilePaths: new Set<string>(),
},
```

## Preventing a fork bomb

Subagents can spawn subagents. Unbounded, a model stuck in a loop can fill the
machine.

The limit is 2, but **how it is enforced matters more than the number**:

```ts
if (toolDefinition.name === 'task') {
  return (
    (visibility.canSpawnSubagents ?? false) &&
    (visibility.spawnDepth ?? 0) < MAX_SUBAGENT_SPAWN_DEPTH
  );
}
```

This is a **tool visibility** decision, not a runtime error. At the depth limit,
`task` simply is not in the model's tool list.

Why not "return an error when called": **a tool the model cannot see is a
boundary it cannot spend a round arguing with.** Return an error and the model
will likely rephrase and try again, burning a round — when the answer is always
no.

The same reasoning covers runs with no spawner wired: `task` does not appear,
rather than appearing and always failing.

## Do not forget the bill

A subagent's tokens are real money. It runs as its own run, so its usage lands on
its own ledger:

```ts
} finally {
  // Roll the child's model calls into the parent's total. Without this a run
  // that delegates most of its work would report a token bill far smaller than
  // the one that actually arrives.
  spawnerInput.parentModelCallUsages.push(...modelCallUsages);
}
```

In `finally`: a subagent that failed still spent what it spent.

## A trap in the storage layer

Adding child session files breaks the session list endpoint.

`listAgentSessionPathsFromDirectory` recurses for every `*.jsonl`, and
`createAgentSessionSummary` throws when the first record is not `session_meta`.
Child transcripts sit under the scanned tree, get treated as top-level sessions,
and the whole listing dies.

The fix is an explicit skip:

```ts
if (entry.name === SUBAGENTS_DIRECTORY) {
  continue;
}
```

The comment says why:

> Never descend into a `subagents/` sidecar. Those transcripts are real session
> files, so without this they would be listed as if they were top-level runs —
> and a subagent has no business appearing as a sibling of the run that spawned
> it. Children are reached deliberately, through `listSubagentSessionSummaries`.

These traps share a shape: **when you add a new kind of file, ask who is already
scanning that directory.**

---

← Previous: [03 · Two graphs, not one](03-two-graphs.md) · [Chapter index](README.md) · Next: [05 · An exit that binds no vendor](05-export-without-a-vendor.md)
