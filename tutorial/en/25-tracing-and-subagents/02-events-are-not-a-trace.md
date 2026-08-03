← Previous: [01 · The question you cannot answer](01-the-question-you-cant-answer.md) · [Chapter index](README.md) · Next: [03 · Two graphs, not one](03-two-graphs.md)

# 02 · An event stream is not a trace

The last section ended on a conclusion: what is missing is each piece of work
having an identity, and knowing whose it is.

This section adds both. The change is almost embarrassingly small — which is
itself evidence that the event design from the earlier chapters was right.

## What one piece of work needs

A span is "a stretch of work with a beginning and an end". To be useful it needs
three things:

| It needs | To answer |
| --- | --- |
| An id of its own | "which `tool_started` does this `tool_finished` close" |
| A parent id | "which round of decision-making did this call happen under" |
| Start and end | "how long did it take" |

The third one **already existed**. Open `lib/agent-tool-runtime.ts`, second line
of `executeAgentToolCall`:

```ts
const startedAt = Date.now();
```

Every return path computes `Date.now() - startedAt` and puts it in
`AgentToolExecution.durationMs`. Duration was always being measured; it just
never left the function.

So only the first two are actually new.

## What an id looks like: a five-minute decision that lasts for years

Fix the id format first. Changing it now is free; changing it later is a data
migration.

```ts
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export function createTraceId(): string {
  return randomBytes(TRACE_ID_BYTES).toString('hex');
}
```

Trace id 16 bytes, span id 8, lowercase hex.

**Why those sizes**: it is what OpenTelemetry requires on the wire. This chapter
does not pull in any OTel code, but shaping ids the way it expects costs
nothing — and when you do want to export a run (Section 05), that becomes a
field rename instead of "regenerate every id you have ever written".

`randomUUID()` would work fine until that day. UUIDs are 36 characters with
hyphens; OTLP will not take them. You would end up maintaining a mapping table,
or accepting that historical runs cannot be exported.

**Timestamps go the other way** — OTel wants Unix nanoseconds, we keep ISO
strings:

```ts
export function createSpanTiming(startedAtMs: number, endedAtMs: number) {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
  };
}
```

Because the JSONL is meant to be read by a human with `less`.
`"2026-07-29T03:14:07.238Z"` reads at a glance; `1785294847238000000` does not.
Export multiplies by `1_000_000` and moves on. **The conversion the machine
saves is not worth the zeros a human has to count.**

## Where it hangs: no new parameters

A span has to reach the whole call chain. Something already reaches the whole
call chain: `AgentRunContext`.

```ts
export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
  policy: AgentRunPolicy;
  approvalMode: AgentApprovalMode;
  toolState: AgentRunToolState;
  span: AgentSpanContext;      // new
  spawnDepth: number;          // new, used in Section 04
};
```

Three levels of span now have obvious birthplaces:

- **the run's root span** — created in `createAgentRunContext`, one per run
- **model spans** — created in the `runSamplingLoop` body, one per round
- **tool spans** — created in `executeAgentToolCall`, one per call

The model span needs care. `model_requested` is emitted inside
`runSamplingRound`; `model_completed` is emitted by the outer `runSamplingLoop`
— **two different functions**. For both to carry the same span id, the span has
to be created in the outer one and passed down:

```ts
const modelSpan = createChildSpanContext(context.span);
const modelStartedAt = Date.now();

const roundResult = await runSamplingRound(
  modelGateway, input, context, history, round, emitAgentEvent,
  modelSpan, modelStartedAt,
);
```

Two extra parameters, in exchange for a pair of ids that actually match. That is
the fix for "nothing pairs up" from the previous section.

## Optional fields: an honesty question

Adding span fields to events poses a choice: required or optional?

Required gets you compile-time coverage — no emitter can forget.

But **old session files have no spans**. And the read path is this:

```ts
.map((line) => JSON.parse(line) as AgentSessionRecord)
```

An unchecked `as`. Old files come back with `span === undefined` at runtime, and
a type that claims otherwise is lying — to the person writing the UI a few
months later, who then crashes on old data.

So: optional.

```ts
export type AgentEventSpanFields = {
  span?: AgentSpanContext;
};
```

**The type describes what can be in the file, not what you wish were there.**
Emitter completeness is a job for tests, not for bending the type.

## A trap worth the detour: do not add fields to old data

Events reach the browser through a projection
(`lib/agent-stream-projection.ts`) that re-lists fields explicitly:

```ts
case 'tool_started':
  return {
    type: 'debug',
    event: {
      type: 'toolStarted',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argumentsJson: event.argumentsJson,
    },
  };
```

Adding `span: event.span, startedAt: event.startedAt` looks obviously correct.
Four projection tests went red.

The reason: for **events that have no span**, that spelling produces a
`span: undefined` key. `assert.deepEqual` — strict, under `node:assert/strict` —
says `{a:1}` and `{a:1, b:undefined}` differ. It is right: **the contract did
change.** Every downstream consumer would now have to learn to ignore a key that
is always undefined.

Spread only the fields that are actually set:

```ts
function definedTraceFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
```

Those four tests **went green again without a single character changed**.

Worth remembering: **when a test goes red, the first move is not to edit the
test.** It was telling you that a change you believed to be backward-compatible
was not. Editing the expectation would have silenced exactly that signal.

## One thing done right in passing

`tool_finished` is also emitted on paths where the tool **never ran** — unknown
tool, permission denial, approval denial. Those carry a full span too:

```ts
/**
 * Note that `tool_finished` is also emitted on paths where the tool never ran.
 * Those still carry a well-formed span: a span is a single record with both
 * ends, so a rejected call shows up in the waterfall as a short bar rather than
 * vanishing.
 */
```

Why bother: **"why is there nothing here?" is the hardest question to answer
from a trace.** A `write` stopped by the path policy that leaves no mark reads
as "the model never tried to write" — when the truth is "it tried, and was
stopped".

---

← Previous: [01 · The question you cannot answer](01-the-question-you-cant-answer.md) · [Chapter index](README.md) · Next: [03 · Two graphs, not one](03-two-graphs.md)
