# Agent Runtime Evolution

This document records how the project evolved toward an agent runtime. It is
not only a changelog. The goal is to preserve the reasoning, tradeoffs, and
learning path behind the current architecture.

## Why This Document Exists

`docs/architecture.md` describes the current shape of the system.

`tutorial/README.md` is the bilingual tutorial hub. `tutorial/en/README.md`
turns the same history into a chaptered English learning path, and
`tutorial/zh/README.md` is the Chinese version.

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
- one temporary local toy tool, later removed when real file-exploration tools
  became the testing surface

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
assistant_delta -> assistantDelta
run_succeeded -> done
run_failed -> error
```

This preserved a simple frontend contract while allowing the backend to start
using richer internal events. The stream event is named `assistantDelta` because
the text is assistant output, not proof that the current message is already the
final answer.

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

Tool definitions are also provider-neutral. The agent IR uses `inputSchema` and
`schemaStrict`; OpenAI dialects translate those to their wire-level
`parameters` and `strict` fields. This keeps future non-OpenAI dialects from
depending on OpenAI-shaped tool metadata.

Currently implemented dialects:

```text
openai-chat-completions
openai-responses
```

Anthropic is intentionally deferred. The architecture is prepared for it, but
the runtime should become stronger before another provider is added.

## Phase 13: Agent Runtime Spine v1

The fixed two-call agent was replaced by the first real runtime spine:

```text
initialize provider-neutral history
call model with history and tools
record function_call items
execute one batch of tools
record function_call_output items
repeat until no tool calls
stream final answer with accumulated history
```

There is no global sampling-round cap. Runaway protection is handled by narrower
runtime controls: user abort, per-tool timeout, and a repeated-tool-call guard
that stops identical tool name + arguments + output loops after three repeats.

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
      output: string;
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

## Phase 14: Streaming Sampling Loop v1

The runtime spine now uses streaming model sampling for every round:

```text
initialize provider-neutral history
stream model with history and tools
collect text_delta / assistant_message_done / tool_call_delta / tool_call_committed / completed
if tool calls exist:
  record function_call items
  execute one batch of tools
  record function_call_output items
  continue with the updated history
else:
  use this round's streamed text as the final answer
```

This removed the extra final-answer model call. The last round that does not
request tools is the final answer stream.

The provider-neutral stream event now includes tool-call events:

```ts
type AgentModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_delta'; ... }
  | { type: 'tool_call_committed'; toolCall: AgentModelToolCall }
  | { type: 'completed'; model: string; usage: AgentModelUsageSnapshot };
```

OpenAI Chat Completions reconstructs streaming tool calls from
`delta.tool_calls`. OpenAI Responses emits function-call deltas from
`response.function_call_arguments.delta` and completed tool calls from
`response.output_item.done`.

## Phase 15: Assistant Message Commit Semantics

The streaming loop now separates three concepts that were previously blended
together:

```text
text_delta                 provisional assistant text for live display
assistant_message_done     commit point for one complete assistant message
round decision             continue only if this round has tool_call_committed events
```

Provider dialects own the conversion from native stream events to this contract:

```text
OpenAI Chat Completions:
  delta.content -> text_delta
  stream completion -> assistant_message_done
  delta.tool_calls + finish_reason/tool-call tail -> tool_call_committed

OpenAI Responses:
  response.output_text.delta -> text_delta
  response.output_item.done(message) -> assistant_message_done
  response.output_item.done(function_call) -> tool_call_committed
```

The agent loop waits until a sampling round has completed before deciding what
the committed assistant message means:

```text
if tool_call_committed events exist:
  committed assistant messages are working messages
  execute tools and continue
else:
  committed assistant text is the final answer
```

OpenAI Responses `phase` is preserved as provider metadata when present, but it
does not drive the loop. The loop stop condition remains provider-neutral:
whether the completed round requested tools.

## Phase 16: Deterministic Sampling Loop Tests

The sampling loop gained model-free tests with a fake `AgentModelGateway`.
Instead of calling a real provider, tests feed deterministic
`AgentModelStreamEvent` sequences into `runSamplingLoop` and assert the resulting
history shape.

The first cases document the runtime contract:

- no tool call: committed assistant message becomes `runtimeRole: "final_response"`
- tool call: committed assistant message becomes `runtimeRole: "working_message"`,
  then `function_call`, `function_call_output`, and final response
- text delta without `assistant_message_done`: protocol error
- tool-call argument delta without `tool_call_committed`: protocol error

## Phase 17: Built-In Read-Only Tools v1

The first real agent tool foundation is read-only local file exploration rather
than shell execution. This keeps the learning project close to production agent
needs while postponing OS process sandboxing and approval complexity.

Registered tools:

```text
ls      list directory entries
find    find files by glob-style path pattern
grep    search file contents with ripgrep
read    read UTF-8 text files with line pagination
```

Each tool is marked read-only, non-destructive, closed-world, idempotent, and
parallel-capable. Paths are resolved under the current project root and
checked with `realpath`, so both lexical escapes such as `../package.json` and
symlink escapes fail as ordinary tool errors. Those errors become
`function_call_output` records with `isError: true`, so the model can retry with
a valid path in the next sampling round.

The tools return bounded model-facing text plus internal structured details
rather than unbounded raw dumps:

- `read` sends file path, line range, and content to the model; details preserve
  line metadata and truncation state.
- `grep` sends path/line/match text to the model; details preserve structured
  match records and limit state.
- `find` and `ls` send deterministic sorted paths or entries to the model;
  details preserve the structured arrays.

The tests now cover both direct tool runtime behavior and sampling-loop
integration. The integration test has the fake model request `read`, verifies
the real built-in tool runs through the permission/runtime boundary, and
asserts the ordered `function_call_output` history item.

## Phase 18: Tool Result Contract v1

Tool results now have an explicit split between internal runtime structure and
model-visible history. Tools return `AgentToolOutput`; the runtime serializes it
before appending `function_call_output`.

```ts
type AgentToolOutput =
  | { type: 'success'; contentText: string; details?: unknown; notice?: string }
  | {
      type: 'respond_to_model';
      error: { code: AgentToolErrorCode; message: string };
    }
  | { type: 'fatal'; error: { code: AgentToolErrorCode; message: string } };
```

The model never receives an `{ ok, error, details }` JSON envelope. It sees only
plain text:

```text
success            -> contentText plus optional [notice]
respond_to_model   -> Error [CODE]: message
fatal              -> no function_call_output; terminate the run
```

Runtime events and logs still keep the structured output, including details,
error codes, duration, and whether the output was an error. This mirrors the
useful part of Codex and pi-mono: model-facing output stays easy for the model
to read, while the runtime keeps typed metadata for UI, debugging, and future
evaluation.

The runtime also owns two lifecycle errors:

- timeout becomes `Error [TIMEOUT]: ...` in history, so the model can recover.
- in-flight abort becomes `Error [ABORTED]: ...` in history, so the model sees
  that the tool did not complete.

Permission pauses remain fail-closed for now because approval resume is not
implemented yet.

## Phase 19: OpenAI Strict Tool Schema Adapter

The first browser run with built-in tools exposed an OpenAI strict-schema
constraint: with `strict: true`, OpenAI requires every property in a tool schema
to be listed in `required`, and optional fields must be represented by allowing
`null`.

The fix belongs in the provider dialect layer, not in the agent tool contract.
`lib/openai-tool-schema.ts` now compiles provider-neutral `inputSchema` into an
OpenAI-compatible strict schema before the Chat Completions and Responses
dialects send tools upstream.

```text
agent inputSchema:
  required: ['path']
  properties: path, offset?, limit?

OpenAI strict parameters:
  required: ['path', 'offset', 'limit']
  offset.type = ['number', 'null']
  limit.type = ['number', 'null']
```

The built-in tool Zod parsers also accept strict-mode `null` for optional
arguments and normalize it to `undefined`, so model calls that follow the
OpenAI schema do not fail at the runtime validation boundary.

## Phase 20: Frontend Debug Console v1

The React workbench now has an agent Debug Console focused on validating the
runtime rather than presenting a polished chat UI.

The backend stream projection exposes runtime internals as `debug` SSE events:

```text
model_requested         -> debug.modelRequested
model_completed         -> debug.modelCompleted
tool_requested          -> debug.toolRequested
tool_started            -> debug.toolStarted
tool_finished           -> debug.toolFinished
tool_permission_decided -> debug.toolPermissionDecided
approval_requested      -> debug.approvalRequested
```

`debug.historyCommitted` is emitted on a separate stream-only debug channel,
not as a persisted `AgentEvent`. JSONL already stores committed context as
`response_item` records, so the Debug Console can show the same commit boundary
without duplicating resume state inside `agent_event`.

Each sampling round emits the provider-neutral model request before it enters
the model gateway, including:

- model id
- wire API
- messages/history sent to the model
- tools exposed to the model
- tool choice
- temperature

Each sampling round also emits the provider-neutral model output after the
stream finishes, including:

- streamed assistant text
- committed assistant messages
- completed tool calls
- usage/raw usage

Tool cards show the tool call id, tool name, arguments, status,
model-visible `modelOutput`, and internal structured details. The final run
also shows normalized usage, including cached token values as `null` when the
provider did not report them.

History commits show the provider-neutral `AgentResponseItem[]` written into
model-visible history. This is the layer that carries
`runtimeRole: "working_message" | "final_response"`, so Debug can distinguish
model-call completion from agent-level final answer commitment.

This keeps the browser as an observer. It can inspect every important runtime
boundary, but the server remains responsible for model calls, tool execution,
session writes, and cancellation.

## Phase 21: Agent, Debug, and Session Pages

The frontend now renders the same run through three separate pages:

- Agent page: reads like a transcript. It chains each completed model round's
  assistant text with the tool calls requested by that model output, without
  exposing runtime terms such as "round" to the user. Tool calls from the same
  model output are grouped into one collapsible batch. Assistant text is
  rendered as Markdown with GFM support, so lists, tables, and code blocks match
  the format models normally produce.
- Debug page: keeps the full inspection surface. It shows every model request,
  model output, history commit, tool lifecycle event, model-visible tool output,
  internal tool details, and usage payload without truncating summary values.
- Session page: loads the current run's persisted JSONL through
  `/api/agent/sessions/[id]` and prints one raw JSON record per line. This is
  the session/replay artifact view, not another debug projection.

The page split itself is a frontend projection. The Debug page also consumes the
stream-only `debug.historyCommitted` event so it can show the exact response
items that entered model-visible history without adding duplicate state to the
JSONL session event log.

`AgentStep` remains available, but it is collapsed on the Agent page because it
is now a summary layer. The runtime truth remains the provider-neutral model
rounds, tool requests, tool outputs, and response-item history.

## Phase 22: Tool Runtime Boundary v1

The tool layer now has an explicit runtime contract before adding write/edit,
shell, MCP, or hosted tools.

`lib/agent-tool-contracts.ts` defines the provider-neutral tool definition:

```text
source        builtin | dynamic | mcp | hosted
group         utility_builtins | read_only_builtins | editing_builtins | shell_builtins
category      utility | read | search | write | shell
annotations   readOnly / destructive / openWorld / idempotent facts
execution     executionMode, timeoutMs, abortable
pathAccess    none | current_project | allowed_roots | danger_full_access
modelTool     name, description, inputSchema, schemaStrict
execute       concrete handler
```

`lib/agent-tools.ts` composes groups instead of flattening every tool by hand:

```text
utility_builtins    empty skeleton
read_only_builtins  read, grep, find, ls
editing_builtins    empty skeleton
shell_builtins      empty skeleton
```

The original text-counting toy tool was removed after the read-only built-ins
landed. The frontend demo now exercises project exploration with
`ls/find/grep/read` instead of text counting.

The OpenAI Chat Completions and Responses dialects still receive only
`modelTool`. Runtime metadata such as source, group, path policy, annotations,
execution mode, timeout, and abortability stays inside the agent runtime. This
keeps the future Anthropic/MCP/provider adapters from depending on OpenAI-shaped
tool objects.

`lib/agent-path-policy.ts` separates path access from concrete tools:

```text
none
current_project
allowed_roots
danger_full_access
```

Current read-only built-ins still use `current_project`; behavior is unchanged.
The new `allowed_roots` and `danger_full_access` policies are contract-tested
but not activated by default. This gives write/edit and shell a place to attach
their filesystem semantics later without burying permission decisions inside a
single large tool file.

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
