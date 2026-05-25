# Agent Runtime Evolution

This document records how the project evolved toward an agent runtime. It is
not only a changelog. The goal is to preserve the reasoning, tradeoffs, and
learning path behind the current architecture.

## Why This Document Exists

`docs/architecture.md` describes the current shape of the system.

This document describes how we got there:

- what problem each step was trying to solve
- why we chose the smaller step instead of a broader rewrite
- which ideas were accepted, deferred, or rejected
- what the next step depends on

The evolution matters because this project is also a learning project. A future
maintainer should be able to understand not only what the code does, but also
why the code is shaped this way.

## Starting Point

The project began as a small Next.js backend that makes a clean
OpenAI-compatible model call.

Early constraints:

- Keep route handlers thin.
- Keep business logic outside `app/api/.../route.ts`.
- Use plain TypeScript objects at service boundaries.
- Use Zod at request/API boundaries.
- Keep the code readable for someone coming from Java/Spring Boot.

The first stable backend shape was:

```text
app/api/chat/route.ts
lib/chat-input.ts
lib/env.ts
lib/openai-compatible-client.ts
lib/chat.ts
```

That gave the project a clean controller / DTO / config / client / service
split before agent-specific complexity was introduced.

## Phase 1: A Small Inspectable Agent

The first agent was intentionally small. It was not meant to be a complete
runtime.

It introduced:

- `/api/agent`
- `/api/agent/stream`
- `AgentInput`
- `AgentResult`
- `AgentStep`
- one local tool: `inspect_text`

The initial flow was:

```text
build prompt
ask model whether a tool is needed
if tool requested, run local tool
ask model for final answer
return answer and inspectable steps
```

This was a demo-shaped agent, but it made the model/tool/result sequence visible
enough to discuss.

## Phase 2: Make Steps And Logs Inspectable

The next pressure came from observability. A black-box agent is hard to learn
from and hard to debug.

We added:

- structured server logs with `runId`
- user input logging
- step output logging
- model prompt logging
- tool request and tool execution output logging

This made the runtime easier to inspect, but logs alone were not enough. Logs
are process-local and operational. They are not a durable session model.

## Phase 3: Streaming Agent Output

The agent then gained a streaming route.

The server emits runtime events and projects them into the existing frontend
stream contract:

```text
step_created -> step
model_delta  -> answerDelta
run_succeeded -> done
run_failed -> error
```

This preserved a simple frontend contract while allowing the backend to start
using richer internal events.

Important decision:

- The frontend remains an observer.
- The backend owns model calls, tools, permissions, and cancellation.
- Runtime events are internal truth.
- SSE events are only a UI projection.

## Phase 4: True Cancellation Boundary

Cancellation was designed as a platform abort chain, not as a prompt instruction
sent to the model.

The chain is:

```text
AbortController in React
fetch signal
NextRequest.signal
AgentRunContext.signal
OpenAI SDK request options
stream chunk guard
tool/runtime cancellation checks
```

This established `AgentRunContext` as the right place for lifecycle concerns
such as cancellation, retry budgets, checkpoints, and future approval wait
state.

## Phase 5: Harness Direction

After comparing ideas from Codex CLI, Claude-style agent SDKs, pi-mono, and the
"harness" concept, the project direction became clearer:

The model is not the agent. The backend harness is the agent runtime layer
around the model.

The harness should own:

- model-provider calls
- tool registration and execution
- permission and approval checks
- cancellation
- runtime events
- durable session records
- replay/resume foundations
- user-visible stream projections

This shifted the project from "a service that can call a tool" toward "an agent
runtime that happens to use a model".

## Phase 6: Tool Runtime Boundary

Tool execution moved behind `lib/agent-tool-runtime.ts`.

This separated:

```text
agent orchestration
tool registry lookup
permission decision
tool lifecycle events
concrete handler execution
```

The model now requests tools, but the runtime decides whether and how they run.

This boundary is the future home for:

- tool timeouts
- retries
- output validation
- sandbox enforcement
- interactive approval resume

## Phase 7: Permission Skeleton

Permission was modeled as separate layers:

```text
tool annotations
approval policy
sandbox mode
future hooks / guardian / user approval
```

Important decision:

- A tool declares facts about itself.
- A tool does not decide whether it may run.
- The runtime decides based on policy and annotations.
- Sandbox mode is a run-level hard boundary, not a tool attribute.

Current status:

- Known safe tools can be auto-approved.
- Unknown/risky tools can emit `approval_requested`.
- Interactive approval resume is not implemented yet.
- `ask` currently fails closed through `AgentApprovalRequiredError`.

## Phase 8: JSONL Session Records

The project adopted a Codex-style rollout idea in a smaller form.

Current session files live under:

```text
data/agent-sessions/YYYY/MM/DD/rollout-{timestamp}-{runId}.jsonl
```

Each record is:

```ts
{
  timestamp: string;
  type: string;
  payload: unknown;
}
```

Initial row types:

```text
session_meta
turn_context
agent_event
```

This made agent runs durable and inspectable after the request finishes.

The current store is still not a full resume system because it does not yet
persist provider-neutral model-visible history as `response_item`.

## Phase 9: Session Read APIs

After writing JSONL, the project added local inspection APIs:

```text
GET /api/agent/sessions
GET /api/agent/sessions/:id
```

These APIs are intentionally read-only. They are for local inspection and debug,
not resume.

This step made the session store usable without manually opening files.

## Phase 10: Usage Tracking

Usage moved from raw `unknown | null` into structured runtime data.

The current shape keeps both:

- provider raw usage
- normalized token usage
- per-call usage records
- summed usage for the run
- last call usage

The key rule:

Single-call token numbers come from the model provider. Cross-call totals are
computed by the runtime.

This mirrors the shape used by mature agent systems:

```text
last usage     most recent model call
total usage    accumulated model calls in this run/session
```

## Phase 11: Provider Dialect Architecture

The project then addressed a deeper architectural problem: the runtime was
becoming tied to OpenAI Chat Completions types.

The selected direction combines:

- Codex-style provider-neutral response/history concepts
- pi-mono-style API registry and provider adapter openness
- database-style dialect separation

The current shape is:

```text
Agent Runtime
  -> Agent Model IR
  -> Model Gateway
  -> Provider Dialect
  -> OpenAI SDK / provider wire API
```

New boundaries:

```text
lib/agent-model-types.ts
lib/model-provider-dialect.ts
lib/openai-chat-completions-dialect.ts
lib/openai-responses-dialect.ts
lib/model-gateway.ts
```

Important decision:

`lib/agent.ts` must not import provider SDK wire types such as OpenAI
`ChatCompletionMessage` or Responses `ResponseStreamEvent`.

The runtime talks through:

```text
AgentModelMessage
AgentModelToolDefinition
AgentModelToolCall
AgentModelRequest
AgentModelResponse
AgentModelStreamEvent
```

Provider dialects translate those into concrete wire formats.

Currently implemented dialects:

```text
openai-chat-completions
openai-responses
```

Anthropic is intentionally deferred. The architecture is prepared for it, but
the runtime should become stronger before another provider is added.

## Phase 13: Agent Runtime Spine v1

The fixed two-call agent has been replaced by the first real runtime spine:

```text
initialize provider-neutral history
call model with history and tools
record function_call items
execute one batch of tools
record function_call_output items
repeat until no tool calls or max rounds
stream final answer with accumulated history
```

The key type is provider-neutral model-visible history:

```ts
type AgentResponseItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      argumentsJson: string;
    }
  | {
      type: 'function_call_output';
      callId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    };
```

The runtime now persists streaming sessions with `response_item` records, so the
JSONL file shows the model-visible chain in addition to UI/runtime events:

```text
message(system)
message(user)
function_call(...)
function_call_output(...)
message(assistant final answer)
```

Tool execution also gained a small scheduler:

```text
all tools in the batch declare executionMode="parallel" -> Promise.all
otherwise                                             -> sequential
```

This deliberately does not guess data dependencies. If a second tool needs the
first tool's output, the model should request it in a later round after the
first `function_call_output` enters history.

This phase connects the existing infrastructure:

- model dialects
- tool runtime
- session JSONL
- usage tracking
- future approval resume
- future compaction/resume

## Deferred Work

The following are useful, but should build on top of the loop/history core
rather than bypass it:

- Anthropic Messages dialect
- more OpenAI-compatible providers
- sandbox enforcement
- interactive approval resume
- user input during a run
- retry policy
- memory / retrieval
- planner / subtask decomposition
- evaluation / replay tooling

These features need a stable runtime history model to avoid becoming isolated
subsystems.

## Design Principles Learned So Far

- Keep route handlers thin.
- Keep framework types at route boundaries.
- Keep provider wire types inside dialect files.
- Prefer provider-neutral runtime events over frontend-shaped events.
- Prefer append-only records for auditability.
- Record raw provider data when useful, but normalize what the runtime needs.
- Do not let compatibility quirks leak into the agent loop.
- Build the runtime spine before adding many outward-facing features.
