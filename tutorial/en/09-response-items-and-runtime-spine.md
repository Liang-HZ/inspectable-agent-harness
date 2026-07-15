# 09. Response Items And Runtime Spine

This chapter explains how the agent loop moves from frontend teaching steps to
real model-visible history. `AgentResponseItem` becomes the core data structure
of the runtime spine.

After reading this chapter, you should understand:

- why response items are more fundamental than UI steps
- how the runtime spine organizes model -> tool -> model cycles
- why the scheduler is a separate module
- how assistant runtime roles distinguish working text from final output

## Background

The early agent had steps and logs, but it still lacked a precise
model-visible history.

A real tool loop needs the model to see:

```text
assistant requested tool
tool returned output
assistant continues from that output
```

UI steps are not enough for that. The runtime needs history items.

## AgentResponseItem

The key file is:

```text
lib/agent-response-items.ts
```

The core union is:

```ts
type AgentResponseItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { type: 'function_call_output'; callId: string; toolName: string; output: string; isError: boolean };
```

This is the teaching-simplified version: the real `message` branch also
carries optional `providerPhase` and `runtimeRole` fields, introduced in
later chapters. The full shape lives in `lib/agent-response-items.ts`.

This is the model-visible history, independent of frontend display.

## Runtime Spine

The fixed teaching flow was replaced by:

```text
initialize history
call model with history and tools
commit assistant message / function calls
execute tool batch
append function_call_output
repeat until no tool calls
```

The main file is:

```text
lib/agent.ts
```

## Scheduler

The scheduler lives in:

```text
lib/agent-tool-scheduler.ts
```

It chooses:

```text
all tools parallel-capable -> Promise.all
otherwise                 -> sequential
```

It does not infer data dependencies. If the model needs tool B to depend on
tool A, it should request B in a later sampling round after A's output is in
history.

## Assistant Runtime Roles

Assistant messages can become:

```text
working_message
final_response
```

This is an agent-level classification. It is not the same as provider phase
metadata.

## Git Evidence

Relevant commit:

```text
e6ff55e Add agent runtime spine
```

## Why This Was A Turning Point

This phase made the system feel like an agent runtime rather than a service
with a tool call. The source of truth moved from display steps to model-visible
history.

## Common Misunderstandings

### Misunderstanding 1: UI Steps Can Be Model History

UI steps are presentation objects. Model history is protocol state. They have
different jobs and should not be mixed.

### Misunderstanding 2: The Runtime Spine Is The Entire Agent Run

The runtime spine is the loop skeleton. A full run also includes input parsing,
events, sessions, cancellation, debug, and final response assembly.

### Misunderstanding 3: Assistant Text Does Not Need Roles

The same assistant text can be a working message before tools or a final
response when no tools are requested. Runtime roles let UI and debug surfaces
express that difference.

## Chapter Summary

This chapter moves the agent from step-driven to history-driven: model-visible
response items become the source of truth, the scheduler controls tool batches,
and the runtime spine connects model calls with tool execution.
