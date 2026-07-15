# 13. Tool Output And Strict OpenAI Schema

This chapter explains how tool results serve the model, frontend debug, and
runtime telemetry at the same time. The core rule is: the model sees text, while
the runtime keeps structured metadata.

After reading this chapter, you should understand:

- why internal tool output and model-visible content are separate
- why recoverable errors enter history but fatal errors stop the run
- how timeout and abort enter the unified output path
- why OpenAI strict schema changes optional parameter representation

## Background

Real tools raised two practical problems:

1. What exactly should a tool return internally?
2. What schema should OpenAI strict function calling receive?

Both problems affect production behavior.

## Tool Output Contract

The project introduced:

```text
lib/agent-tool-output.ts
```

The internal output shape is:

```ts
type AgentToolOutput =
  | { type: 'success'; contentText: string; details?: unknown; notice?: string; truncated?: boolean }
  | { type: 'respond_to_model'; error: AgentToolError; details?: unknown }
  | { type: 'fatal'; error: AgentToolError; details?: unknown };
```

## Model-Visible Serialization

The model does not receive this envelope.

The model receives plain text:

```text
success:
  contentText
  [optional notice]

respond_to_model:
  Error [CODE]: message

fatal:
  no function_call_output; stop the run
```

This keeps model input readable while preserving structured details for logs,
debug UI, and future telemetry.

## Timeout And Abort

The runtime converts timeout and abort into recoverable model-visible tool
outputs:

```text
Error [TIMEOUT]: ...
Error [ABORTED]: ...
```

That lets the model understand that a tool did not complete.

## OpenAI Strict Schema Problem

The first browser run with real tools hit an upstream error:

```text
Invalid schema for function 'read': ... 'required' is required ...
```

OpenAI strict tools require every property to appear in `required`. Optional
fields must be represented by allowing `null`.

## Correct Boundary For The Fix

The fix belongs in:

```text
lib/openai-tool-schema.ts
```

not in the agent-owned tool contract.

The agent tool can say:

```text
path required
offset optional
limit optional
```

The OpenAI adapter compiles it to:

```text
required: ['path', 'offset', 'limit']
offset.type = ['number', 'null']
limit.type = ['number', 'null']
```

The runtime Zod parser accepts `null` for strict-mode optional fields and
normalizes it to `undefined`.

## Git Evidence

Relevant commit:

```text
ec40dc3 Add structured tool output contract
```

The strict schema fix and tests grew out of the first real frontend run after
that layer.

## Tests

Relevant tests:

```text
tests/openai-tool-schema.test.ts
tests/agent-builtins.test.ts
tests/agent-sampling-loop.test.ts
```

## Common Misunderstandings

### Misunderstanding 1: Tools Should Send JSON Envelopes To The Model

Models usually benefit from concise text. `ok`, metadata, duration, and
truncation details are useful to runtime and debug surfaces, not always to model
context.

### Misunderstanding 2: All Errors Should Be Fatal

Recoverable errors should become tool outputs the model can see, such as path
not found or validation failure. Fatal errors are for runtime states that cannot
continue.

### Misunderstanding 3: OpenAI Strict Schema Is A Minor Provider Detail

Strict schema affects how tool parameters are declared. The internal contract
can express optional fields, while the OpenAI wire schema may need required +
nullable fields.

## Chapter Summary

This chapter splits tool output into model-visible text and runtime/debug
metadata. It also fixes timeout, abort, error serialization, and OpenAI strict
schema boundaries.

## Chapter Checkpoint

The strict-schema compilation rule and the runtime's acceptance of `null`
each have a key-free verification path:

```bash
npx tsx --test tests/openai-tool-schema.test.ts
```

Measured output:

```text
✔ OpenAI strict tool schema marks every property as required (0.853791ms)
✔ OpenAI strict tool schema represents optional properties with null type (0.106375ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

These two cases pin the fix boundary of this chapter: optional parameters are
compiled into required + nullable, not omitted from `required`. Then verify
that the runtime side really accepts strict-mode `null`:

```bash
npx tsx --test --test-name-pattern "strict" tests/agent-builtins.test.ts
```

The measured output is `✔ read accepts OpenAI strict-mode null optional
arguments` — both sides of the contract, wire schema and Zod parser, are
nailed down by tests.
