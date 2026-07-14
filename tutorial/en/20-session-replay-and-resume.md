# 20. Session Replay And Resume

This chapter explains how the harness turns "one JSONL session holds exactly
one turn" into "the same session can be continued repeatedly, becoming a real
multi-turn conversation." This is the first time the JSONL session store
introduced in chapter 7 is actually used for replay.

After reading this chapter, you should understand:

- why "session" and "run" have to be two separate identities
- how resume reconstructs model-visible history from JSONL
- why a mid-turn crash breaks the function_call/function_call_output pairing
  invariant, and how that gets fixed
- why resume only appends new content instead of rewriting the whole history
- how the frontend turns "continue this session" into a single click

## Background

Chapter 7 created a JSONL file for every `/api/agent/stream` call, but from
then until now, `session.id` and `context.runId` have always been the same
value — every call created a brand-new session containing exactly one turn.
That meant the JSONL session store was effectively just a single-turn run
audit log, not yet a conversation that could actually continue.

Researching Codex CLI and Claude Code (see
[`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))
showed both separate these two identities:

- In Codex's rollout file, `SessionMeta` is written once at the start of a
  session, while `TurnContext` is written once per turn; `codex resume`
  reconstructs history by scanning backward from the most recent `Compacted`
  checkpoint.
- Claude Code's `--continue`/`--resume` restores the entire message history,
  and `--fork-session` can branch a new session from a point in history.

This project makes the same separation at teaching size: one
`resumeAgentSession` function, one normalization step, and one boundary that
decides what to *append* rather than what to *rewrite*.

## Design Choice

### Session identity and run identity are separate

Before:

```text
session.id === context.runId === the unique identifier for a turn
```

Now:

```text
sessionId   stable across turns, identifies "this conversation", equals the first turn's runId
runId       generated fresh on every /api/agent/stream call, identifies "this turn"
```

`AgentInput` gained an optional `sessionId` field. Omitting it behaves
exactly as before (a fresh session is created, `sessionId = runId`).
Providing it makes the runtime reopen the existing session file and append
this turn's new conversation to it.

This change is surfaced through the `run_started` event:

```ts
{ type: 'run_started', runId, sessionId, resumed: boolean, policy }
```

`runId` keeps being used for everything that is turn-scoped: event
correlation, the approval registry key, and so on. `sessionId` is the
identity the browser's Session panel uses to locate the JSONL file, and the
one the sidebar should use to highlight "the current conversation."

### Reconstructing history: read from JSONL, not from memory

`lib/agent-session-store.ts` gained `resumeAgentSession(sessionId)`:

```text
1. Find the JSONL file path by sessionId (reuses chapter 7's findAgentSessionPathById)
2. Read every response_item record and rebuild AgentResponseItem[] in write order
3. Run normalization (see next section)
4. Return { session, history, synthesizedItems }
```

There is no in-memory cache here — every resume re-reads from disk. That is
deliberate: a process restart, a different machine, or even a different
deployment instance should all be able to resume as long as the JSONL file
still exists. This matches the Codex/Claude Code model: session state lives
in a file, not in a process (the opposite tradeoff, on purpose, from last
chapter's approval pending state, which had to live in a process because it
corresponds to a promise that is actually running).

### Normalization: repairing an interrupted tool call

The research noted that Codex's `context_manager/normalize.rs` does two
things: drops orphan outputs that can't find their call, and inserts a
synthetic output for orphan calls that can't find their output. This project
only needs the second case — the order in which the runtime commits response
items guarantees an output can never appear before its call, so the only
possible orphan is "a call with no output."

What `normalizeAgentResponseItemHistory` does:

```text
Scan every function_call in the history
For each function_call, check whether a matching function_call_output follows it
If not, insert a synthesized function_call_output right after it:
  isError: true
  output: "Error [SESSION_RESUME_INTERRUPTED]: This tool call did not
           finish before the previous run on this session ended..."
```

This invariant isn't a preference of this project — it is a hard requirement
of the provider protocols. Both the OpenAI Chat Completions and Responses
APIs require every tool call to have a matching tool response, or the whole
request is rejected. Without this step, resuming a session that was killed
mid-tool-call would make the very next model request fail outright instead
of continuing gracefully.

The synthesized item reuses the original `callId` rather than generating a
random one — so if prompt caching is added later, the same callId stays
stable in cache-key computation. That is the same motivation the research
found behind Codex deriving synthetic ids with a stable UUIDv5 (this project
keeps it simpler by reusing the original callId directly, since a call can
only ever have one output).

### Append only what's new, never rewrite the whole history

This is the step that is easiest to get wrong. The `history` returned by
`resumeAgentSession` is the complete history (everything from the first turn
to now), and that complete history is what gets sent to the model. But
**writing back to JSONL must never re-append the whole history** — that
would make the file grow linearly and blow up on every resume.

`lib/agent.ts`'s `initializeAgentSessionForStream` keeps these two things
separate:

```ts
type AgentSessionInitResult = {
  session: AgentSession;
  history: AgentResponseItem[];        // the full history sent to the model
  sessionId: string;
  resumed: boolean;
  newItemsToPersist: AgentResponseItem[]; // only the new part actually written to disk
};
```

For a fresh session, `history === newItemsToPersist` (both are the same
system+user pair, exactly like before). For a resumed session:

```text
history            = reconstructed history + synthesizedItems (already produced by normalize) + the new user message
newItemsToPersist   = synthesizedItems + the new user message
```

`synthesizedItems` get written back to disk, so the next time this session is
resumed, normalization doesn't need to re-infer anything — it is already part
of the recorded true history. This is an idempotency choice: the same
interruption point only ever needs to be normalized once.

### Why a failed resume throws instead of silently starting fresh

If `sessionId` points at a session that doesn't exist,
`initializeAgentSessionForStream` throws outright instead of silently
falling back to "create a new session." This choice exists so that "the user
thinks they're continuing a conversation but actually started a new one" —
a silent data-loss failure mode — can never happen. The error is caught by
`/api/agent/stream`'s try/catch and turned into an SSE `error` event, and the
frontend shows the failure text as usual.

## Frontend

The Session panel (the JSONL browser introduced in chapter 14) now has a
**Continue this session** button. Clicking it writes the currently viewed
session id into the Agent form's `sessionId` field, and a banner appears at
the top of the composer:

```text
Continuing session 4786ba7e          Start new session
```

Clicking "Start new session" clears `sessionId`, returning to the default
"start a new conversation" behavior.

The sidebar's "Current run" card also gained a `continuing session ...`
marker, and `SessionRail`'s highlighting switched from "highlight by runId"
to "highlight by sessionId" — so after a resume, the sidebar still highlights
the same session instead of a new one every turn.

## Permission And Data-Flow Matrix

| Scenario | sessionId input | Session file behavior | History source |
| --- | --- | --- | --- |
| Fresh conversation | not provided | created, writes `session_meta` | `system + user` pair |
| Continue an existing conversation | an existing id | reused, appends `turn_context` + new content | reconstructed history + normalize + new user message |
| Continue a nonexistent id | a nonexistent id | no file created | throws, SSE returns an `error` event |
| Non-streaming `/api/agent` | provided or not, same result | no session involved (this route never persisted) | always a fresh prompt |

## What Is Still Missing

- **The non-streaming `/api/agent` route does not support resume.** That
  route has never had a session concept since chapter 4, and this chapter
  doesn't add one — resume is a streaming-route capability, for the same
  reason approval pause needs SSE to surface a request to the user: a
  non-streaming call is inherently stateless.
- **No context compaction.** Resume currently means "send the entire history
  to the model verbatim," so token usage grows linearly as turns accumulate
  until it hits a limit. That is exactly what the next chapter addresses.
- **No "fork from a point in history."** Codex's `fork` can branch a new
  session from a mid-history record; this project can only continue from the
  latest state.
- **The Session panel still shows a single flat JSONL stream** without
  visually separating turns — seeing the multi-turn structure clearly
  requires reading the order of `turn_context` records yourself.

## Which Tests Prove It

- [`tests/agent-session-store.test.ts`](../../tests/agent-session-store.test.ts):
  pairing/orphan/mixed scenarios for `normalizeAgentResponseItemHistory`, and
  `resumeAgentSession`'s not-found, empty-history, clean-reconstruction, and
  orphan-tool-call-reconstruction cases
- [`tests/agent-session-resume-init.test.ts`](../../tests/agent-session-resume-init.test.ts):
  `initializeAgentSessionForStream`'s fresh path, resume path (appends only
  new content, never rewrites history), mid-turn-interrupted resume, and the
  unknown-session-id error
- Manual verification through the real HTTP route: `POST /api/agent/stream`
  with an existing `sessionId` confirmed `turn_context` is appended rather
  than overwritten, the `model_requested` event's `messages` array grew from
  2 messages (turn 1) to 3 (turn 2, containing both turns' user messages),
  and the JSONL record count grew correctly from 8 to 14 records rather than
  doubling

## Chapter Summary

Session resume's core work isn't a new persistence system — chapter 7's
JSONL store was already enough. The real work is three separations: session
identity from run identity, reconstruction from appending, and "the full
history sent to the model" from "only new content written to disk." Those
three separations turn "continue a conversation" from a concept into a real
capability that a single button click can trigger.
