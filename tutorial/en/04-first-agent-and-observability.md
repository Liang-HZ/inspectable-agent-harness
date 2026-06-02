# 04. First Agent And Observability

This chapter explains how the project moves from a normal chat API to the first
inspectable agent endpoint. The focus is not agent intelligence yet; the focus
is making each step representable, loggable, and verifiable.

After reading this chapter, you should understand:

- how `/api/agent` differs from `/api/chat`
- why `AgentStep` appears first as a teaching structure
- how structured logs help locate a run
- why the toy tool is only temporary scaffolding

## Background

After `/api/chat`, the next question was: what is the smallest agent-like
backend path?

The first answer was not a full loop. It was a small inspectable agent service:

- build a prompt
- ask the model
- optionally call a local tool
- ask for or return an answer
- show steps

This was deliberately a scaffold.

## Files Introduced

```text
app/api/agent/route.ts
lib/agent-input.ts
lib/agent-api-types.ts
lib/agent.ts
lib/agent-log.ts
lib/agent-tools.ts
```

The route followed the same pattern as `/api/chat`: parse input, read config,
call service, return JSON.

## AgentStep

The early display contract was `AgentStep`:

```ts
type AgentStep = {
  order: number;
  title: string;
  detail: string;
  output?: unknown;
};
```

Steps made the first agent inspectable. They were never meant to be the final
runtime truth.

Later, `AgentResponseItem`, Debug Console, and JSONL sessions became the deeper
truth surfaces. `AgentStep` remained as a display summary.

## Structured Logs

To make every agent step traceable, the project added structured JSON logs with
a `runId`.

Logs were expanded to include:

- parsed input
- prompt text
- step output
- final answer
- model id
- usage presence

The important rule: logs may expose runtime behavior, but should not expose
secrets.

## Temporary Toy Tool

The earliest tool was a toy text-inspection tool. It helped prove the sequence:

```text
model requests tool
runtime executes tool
tool result goes back to model
model answers
```

Later, this toy tool was removed when real file exploration tools existed. That
removal was important: keeping a toy tool would keep the system anchored to a
fake capability.

## Tradeoff

The first agent was intentionally not production-shaped. It gave the project a
working artifact that could be criticized.

Those criticisms drove later changes:

- stop doing extra final-answer model calls
- make model-visible history explicit
- separate provider events from round results
- move tools behind runtime boundaries
- split frontend Debug and Agent views

## Verification

At this stage, verification was mainly:

```bash
curl -s -X POST http://localhost:3000/api/agent ...
npm run typecheck
npm run build
```

Later chapters add deterministic tests that prove the runtime without real
provider calls.

## Common Misunderstandings

### Misunderstanding 1: The First Agent Must Already Edit Code

The first agent only needs to establish an observable chain. Model output, tool
steps, and structured results are enough to prepare the slot for real tools.

### Misunderstanding 2: Steps Are The Final Architecture

`AgentStep` is an early teaching structure. Later chapters replace it with
response items, runtime events, and debug projection.

### Misunderstanding 3: The Toy Tool Can Stay Forever

A toy tool proves the chain, but it does not represent production capability.
Once real tools exist, the toy should be removed so the model does not learn a
fake capability surface.

## Chapter Summary

This chapter creates the first observable agent loop: input enters `/api/agent`,
the runtime emits steps, logs include `runId`, and the frontend can see what the
agent did.
