# 11. Deterministic Runtime Tests

This chapter explains why the agent runtime needs deterministic tests that do
not depend on a real model. Provider calls are useful for integration checks,
but they should not be the only proof of runtime semantics.

After reading this chapter, you should understand:

- why a fake model gateway is testing infrastructure
- which loop behaviors need real coverage
- why tests should assert history, tool calls, and final responses
- what fake-gateway tests and real-tool integration tests prove separately

## Background

Agent behavior is hard to test if every test calls a real model.

The runtime needed tests that prove the loop contract without depending on:

- network availability
- provider behavior
- model randomness
- API keys

## Fake Gateway

`tests/agent-sampling-loop.test.ts` creates a fake `AgentModelGateway`.

The fake gateway returns scripted `AgentModelStreamEvent[]` rounds.

This lets tests assert the exact history produced by:

- no-tool final answers
- tool calls
- tool outputs
- malformed provider streams
- recoverable tool errors
- repeated-call guardrails

## What The Tests Prove

Important cases:

```text
no tool call
  -> assistant message becomes final_response

tool call
  -> assistant message becomes working_message
  -> function_call is written
  -> function_call_output is written
  -> later no-tool message becomes final_response

text_delta without assistant_message_done
  -> protocol error

tool_call_delta without tool_call_committed
  -> protocol error
```

## Why This Matters

These tests are not unit tests of helper functions. They are contract tests for
the runtime's most important invariant:

```text
provider stream -> sampling round result -> model-visible history
```

## Real Tool Integration

After real read-only tools were added, the sampling-loop tests were updated so
the fake model can request `read`, and the real tool runtime executes it.

That proves the chain:

```text
fake model tool call
  -> permission/runtime boundary
  -> concrete built-in tool
  -> function_call_output history
```

## Git Evidence

Relevant commit:

```text
f8652ee Add deterministic sampling loop tests
```

## Testing Philosophy

The project avoids fake tests that can never fail. Tests should pin concrete
history shapes and error messages. When a runtime bug is found, the first step
should be a reproducing test.

## Common Misunderstandings

### Misunderstanding 1: Agent Behavior Cannot Be Tested Deterministically

Model intelligence is variable, but runtime contracts are testable. Once the
fake gateway fixes model events, loop behavior, history, tool execution, and
final response classification can be asserted.

### Misunderstanding 2: Real Provider Tests Are More Reliable

Real provider tests depend on network, quota, model versions, and gateways. They
are useful smoke tests, but not the main proof of runtime semantics.

### Misunderstanding 3: Only Successful Paths Need Tests

The risky behavior is often in failure paths: tool errors, aborts, repeated
calls, missing committed messages, and invalid schemas all need coverage.

## Chapter Summary

This chapter builds the testing foundation: fake gateways fix model behavior,
real tools prove integration, and assertions prove loop semantics rather than
model quality.
