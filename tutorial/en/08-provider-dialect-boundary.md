# 08. Provider Dialect Boundary

This chapter explains why the agent runtime should not bind itself directly to
OpenAI Chat or Responses wire formats. Provider dialects convert external
protocols into stable internal model structures.

After reading this chapter, you should understand:

- what the Model IR is
- how the dialect contract isolates provider differences
- why tool schemas should compile from the agent-owned tool contract
- why Anthropic support can be deferred while the boundary exists now

## Background

The runtime originally leaned toward OpenAI Chat Completions shapes. That would
not survive multiple wire APIs.

OpenAI Chat Completions, OpenAI Responses, and future Anthropic APIs differ in:

- request body shape
- tool schema shape
- streaming event names
- tool-call delta format
- usage fields
- assistant message commit points

The agent loop should not know those differences.

## Model IR

The project introduced provider-neutral model types:

```text
AgentModelMessage
AgentModelToolDefinition
AgentModelToolCall
AgentModelRequest
AgentModelResponse
AgentModelStreamEvent
AgentModelUsageSnapshot
```

They live in:

```text
lib/agent-model-types.ts
```

## Dialect Contract

The dialect interface lives in:

```text
lib/model-provider-dialect.ts
```

Implemented dialects:

```text
lib/openai-chat-completions-dialect.ts
lib/openai-responses-dialect.ts
```

The gateway chooses a dialect:

```text
lib/model-gateway.ts
```

## Database Analogy

The design mirrors SQL dialects:

```text
Runtime IR -> Dialect -> Provider wire format
```

The agent loop is like a query planner. The dialect is like the SQL compiler.
Provider quirks stay behind the compiler.

## Tool Schema Boundary

Agent tools use provider-neutral `inputSchema` and `schemaStrict`.

OpenAI dialects compile that to their required wire schema. Later Anthropic
dialects should do their own conversion.

## Important Rule

`lib/agent.ts` should not import provider SDK wire types such as:

```text
ChatCompletionMessage
ResponseStreamEvent
```

If those types appear in the agent loop, the dialect boundary has leaked.

## Git Evidence

Relevant commit:

```text
837f89f Add provider dialect architecture
```

## Why Anthropic Was Deferred

The architecture is prepared for Anthropic, but the runtime needed to become
stronger first:

- model-visible history
- streaming commit semantics
- real tools
- debug visibility
- tests

Adding another provider before these were stable would multiply uncertainty.

## Common Misunderstandings

### Misunderstanding 1: A Dialect Is Unnecessary Until Non-OpenAI Providers

Even inside OpenAI, Chat Completions and Responses are different protocols. The
dialect exists so the agent loop does not care about wire format.

### Misunderstanding 2: OpenAI Schema Can Be The Internal Tool Contract

OpenAI strict schema has provider-specific constraints. The internal tool
contract should express runtime semantics, then the OpenAI dialect compiles it
for OpenAI.

### Misunderstanding 3: Adding A Provider Is Just Changing The URL

Messages, tool calls, stream events, usage, and stop reasons can all differ.
The extensibility point is the dialect boundary, not only `baseURL`.

## Chapter Summary

This chapter isolates provider differences in dialects: the runtime uses a
stable IR, while dialects compile requests, parse streams, convert tool schemas,
and normalize usage.
