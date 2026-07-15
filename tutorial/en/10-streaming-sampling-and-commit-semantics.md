# 10. Streaming Sampling And Commit Semantics

This chapter explains one of the easiest layers to confuse in an agent loop:
model text can stream as it is generated, but the runtime cannot know whether
that text is a working message or the final answer until the current model call
has finished.

After reading this chapter, you should understand:

- what `sampling round` and `sampling loop` mean
- why streamed text cannot be labeled as final immediately
- why provider-level `final_answer` metadata is not the same as agent finality
- why the frontend first renders live text and then reclassifies it after commit

## Background

The previous runtime spine already handled the logical loop: the model can
request tools, the runtime executes those tools, tool outputs are written back
to history, and another model call can begin.

The new problem appears in streaming output.

The frontend wants to show model text as soon as it arrives. But later in the
same response, the model may request a tool. In that case, the text that already
streamed is not the final answer. It is a working message before tool use.

So the runtime must distinguish two moments:

```text
stream time  -> text is arriving and can be displayed
commit time  -> the model call is complete and its meaning can be decided
```

## Vocabulary

This project uses two terms:

```text
sampling round = one model generation call
sampling loop  = repeated model generation calls + tool execution
```

That means:

- one `sampling round` maps to one provider API call
- one `sampling loop` can contain many rounds
- an agent run contains the sampling loop, plus input parsing, event projection,
  session writes, cancellation, and final response assembly

The word "sampling" comes from model generation: the system samples output from
the model distribution. In this project, it specifically means one model
generation step.

## Core Events

Provider streaming protocols differ. The runtime does not consume raw provider
events directly. A dialect first converts them into internal events:

```text
text_delta
assistant_message_done
tool_call_delta
tool_call_committed
completed
```

Each event has a different job:

```text
text_delta              -> provisional text delta, safe for live display
assistant_message_done  -> assistant message is complete and committed
tool_call_delta         -> tool arguments are still being assembled
tool_call_committed     -> tool call is complete and executable
completed               -> provider response has finished, including usage
```

The key distinction is this: `text_delta` is provisional. `assistant_message_done`
and `tool_call_committed` are commit points.

## Data Flow

One sampling round follows this shape:

```text
provider stream
  -> dialect converts provider events
  -> runtime emits assistant_delta for live UI
  -> dialect commits assistant message / tool calls
  -> sampling round completes
  -> runtime decides whether tools are needed
```

The decision rule is:

```text
if committed tool calls for this round are not empty:
  assistant text = working message
  tool calls are written to model-visible history
  tools execute
  tool outputs are written to model-visible history
  the next sampling round begins
else:
  assistant text = final response
  agent run completes
```

This is the core "stream first, classify after commit" rule.

## OpenAI Chat And Responses

OpenAI Chat Completions roughly maps like this:

```text
delta.content                   -> text_delta
stream end                      -> assistant_message_done
delta.tool_calls reconstruction -> tool_call_committed
```

OpenAI Responses roughly maps like this:

```text
response.output_text.delta               -> text_delta
response.output_item.done(message)       -> assistant_message_done
response.output_item.done(function_call) -> tool_call_committed
response.completed                       -> completed
```

The two provider modes have different wire formats, but the runtime sees the
same internal event set. The agent loop does not need to know whether the
current model came through Chat Completions or Responses.

## Provider Finality Is Not Agent Finality

Responses may include metadata such as `phase: final_answer`. That can describe
how the provider classifies a single message, but it cannot decide whether the
whole agent run is complete.

The agent-level stop condition is simpler and more stable:

```text
the model call completed and committed no tool calls
```

Agent finality belongs to runtime semantics, not to the wire-format semantics
of a single provider message.

A provider may mark a message as final, but if the same round or surrounding
runtime state still involves tools, history repair, or runtime errors, the
agent still follows its own loop rules.

## Frontend Display Semantics

The frontend needs to support two stages:

```text
live stage:
  append assistant_delta

commit stage:
  classify the text as working message or final response based on tools
```

This explains why an early UI could feel like text appeared and then got
replaced or rearranged. The problem was not streaming itself. The UI was
rebuilding the display from internal round structure.

The Agent page later moved toward a user-facing flow:

```text
assistant text
tool batch
assistant final answer
```

The Debug page can still show rounds, requests, responses, and usage because it
is for developers.

## Git Evidence

Relevant commit:

```text
34e2d5c Add streaming agent sampling loop
```

It moved the agent loop to a truly streaming sampling structure: text deltas are
projected to the frontend immediately, assistant messages and tool calls commit
after the round finishes, and the final answer is determined by the completed
round that requested no tools.

## Common Misunderstandings

### Misunderstanding 1: Any Assistant Message Without Tools Is Final

In this project's agent loop, termination is indeed based on a completed round
with no tool calls. But the runtime must look at the committed result of the
round, not at an arbitrary partial message.

### Misunderstanding 2: Provider `final_answer` Is The Agent Final Answer

Provider `final_answer` is message-level metadata. Agent final answer is a
runtime-loop result. They may line up, but they are not the same concept.

### Misunderstanding 3: Streaming Can Know Final Meaning Immediately

It cannot. At the start of a stream, the runtime only knows that the model is
emitting text. It does not know whether the model will request tools later. The
final meaning has to wait for round commit.

## Chapter Summary

This chapter establishes the core rule for real agent streaming:

- `text_delta` powers the live UI
- committed assistant messages are what enter history
- committed tool calls are what trigger tool execution
- a completed round with no tool calls produces the final response
- provider dialects handle format conversion, while the agent loop handles
  semantic decisions

This design allows process text to stream for real while preserving
deterministic tool execution and final-answer detection.

## Chapter Checkpoint

Verify the two commit-semantics rules: a delta without a commit point is a
protocol error, and only a completed round with no tool calls produces the
final answer. No key is required for any of these.

1. Protocol error cases — deltas missing their commit must fail:

```bash
npx tsx --test --test-name-pattern "commit|deltas" tests/agent-sampling-loop.test.ts
```

Measured output:

```text
✔ rejects streamed text without an assistant message commit
✔ rejects tool argument deltas without a completed tool call
ℹ pass 2
```

2. Final-answer detection — a no-tool completed round is the final response:

```bash
npx tsx --test --test-name-pattern "no-tool" tests/agent-sampling-loop.test.ts
```

Measured: `✔ uses a no-tool assistant message as the final response`, `pass 1`.

These three cases map onto this chapter's commit points
(`assistant_message_done` / `tool_call_committed`) and the agent finality rule.
