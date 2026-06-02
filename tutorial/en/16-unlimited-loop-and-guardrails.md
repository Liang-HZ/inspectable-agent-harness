# 16. Unlimited Loop And Guardrails

This chapter explains why a fixed maximum round count is the wrong boundary for
a production-style agent, and how the runtime still guards against repeated
tool loops after removing that cap.

After reading this chapter, you should understand:

- why `maximum tool rounds: 5` can fail valid tasks
- why an unlimited loop still needs stop conditions
- how repeated call signatures detect loops
- why visible output commits before a fatal stop

## Background

During real use, the agent hit:

```text
Agent exceeded maximum tool rounds: 5.
```

That was the wrong failure. Five rounds can be a normal coding-agent task.

The project removed the fixed round cap, but still needed a guard against
hallucinated infinite tool loops.

## Design Choice

Remove the global round cap.

Add a narrow repeated-tool-call guard.

The loop now stops when:

- a completed sampling round has no tool calls
- the end user aborts
- a fatal runtime error occurs
- the same tool call with the same output repeats too many times

## Repeated Call Signature

The guard does not use a hash.

It compares:

```text
tool name
normalized JSON arguments
model-visible tool output
```

Arguments are normalized by parsing `argumentsJson` and stable-stringifying
objects with sorted keys.

These are treated as the same:

```json
{"path":"a.ts","limit":20}
{"limit":20,"path":"a.ts"}
```

## Input/Output Matching

The guard matches tool requests to tool executions by `toolCallId`, not by array
position.

That means parallel tool execution does not break matching.

## Output Commit Before Fatal Stop

If the repeated-call guard fires, the runtime first appends the current
`function_call_output` to history, then stops.

This preserves the invariant:

```text
function_call -> function_call_output
```

That invariant matters for future resume/replay.

## Self-Inspection

The current read tool can read the file that defines it:

```text
lib/agent-builtins.ts
```

This is not reflection. It is normal file access through the current project
path policy. It means the agent can inspect runtime source code, which is a
useful diagnostic capability.

## Tests

`tests/agent-sampling-loop.test.ts` verifies:

- more than five tool rounds can complete
- repeated identical `read` calls stop with `REPEATED_TOOL_CALL`
- tool output is still committed before fatal stop

## Current Status

This layer is in the current working tree and should be committed with the
surrounding runtime changes.

## Common Misunderstandings

### Misunderstanding 1: Unlimited Means No Protection

Unlimited only removes the artificial round cap. The runtime still has abort,
fatal errors, no-tool completion, and repeated-call guards.

### Misunderstanding 2: Repetition Can Be Detected By Tool Name Alone

It cannot. The signature needs tool name, input, and output. Otherwise the same
tool operating on different files would be misclassified.

### Misunderstanding 3: The Last Tool Output Can Be Dropped When The Guard Fires

It should not be dropped. The model and debug surfaces need to see the last tool
result before the runtime reports fatal stop.

## Chapter Summary

This chapter moves the agent loop beyond a teaching limit: tasks are no longer
cut off by a fixed round count, while semantic stop conditions and repeated-call
guards still control runaway loops.
