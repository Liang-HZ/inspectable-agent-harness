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

## Phase 23: Permission Path Policy Hardening

The permission layer now owns the first real filesystem decision instead of
leaving every path boundary as a tool-internal error.

`AgentToolDefinition` can declare which argument represents a filesystem path:

```text
permissionInput.pathArgumentName = "path"
```

`AgentToolRuntime` uses that declaration to build an `AgentPermissionRequest`
containing:

```text
declaredPathAccess  The tool's static path capability
pathAccess          The effective policy for this run's sandboxMode
requestedPath       The model-supplied path argument, when present
```

The effective path policy is computed before execution:

```text
sandboxMode=read_only          -> keep current project boundary
sandboxMode=workspace_write    -> keep current project boundary for current read-only tools
sandboxMode=danger_full_access -> widen path-declaring tools to danger_full_access
```

Path denial now happens before `tool_started`. It emits
`tool_permission_decided` with `decision.type="deny"`, returns a recoverable
model-visible tool output such as
`Error [PATH_OUTSIDE_ALLOWED_ROOT]: ...`, and lets the sampling loop continue.

This also fixes an important policy invariant: `approvalPolicy=never` means
"never ask the user"; it does not bypass filesystem boundaries.

This is still not OS sandboxing. The read-only tools also keep a `realpath`
check inside their handler so symlink escapes are caught even after the
permission pre-check. The next deeper layer is real sandbox enforcement for
write/edit, shell, and network-capable tools.

## Phase 24: Workspace Editing Tools v1

The editing skeleton now has real built-in tools:

```text
editing_builtins  write, edit
```

`write` creates or overwrites a UTF-8 file and returns a focused diff. It can
create parent directories, but only under the effective path policy for the run.

`edit` applies exact text replacements to an existing UTF-8 file. It is
deliberately stricter than `write`:

- every `oldText` must appear exactly once in the original file
- all replacements are validated before any write happens
- overlapping replacements are rejected
- the output includes a focused diff
- the same run must have successfully used `read` on the target path first

The read-before-edit rule lives in the runtime permission path, not inside the
model provider adapter. `read` declares `permissionInput.recordsReadPath=true`.
`edit` declares `permissionInput.requiresPriorRead=true`. `AgentToolRuntime`
records successful reads in the per-run context, then
`decideAgentToolPermission(...)` blocks stale edits with:

```text
Error [EDIT_REQUIRES_READ]: Read the target file first...
```

This makes the rule provider-neutral and testable. If a model requests
`read` then `edit` in the same batch, the scheduler runs the batch
sequentially because `edit` is not parallel-capable. If it requests `edit`
first, the runtime denies the call and feeds the corrective hint back to the
model.

The provider-visible tool list is now policy-aware:

```text
sandboxMode=read_only          -> read, grep, find, ls
sandboxMode=workspace_write    -> read, grep, find, ls, write, edit
sandboxMode=danger_full_access -> read, grep, find, ls, write, edit
```

Direct dispatch still fails closed. Even if a hidden write-capable tool call
arrives under `sandboxMode=read_only`, permission decision returns
`PERMISSION_DENIED` before `tool_started`.

## Phase 25: Run Policy Surface And Audit Views

The run policy moved from an internal default into the API and frontend
contract.

`/api/agent` and `/api/agent/stream` now validate two policy fields:

```text
approvalPolicy  strict | on_request | never
sandboxMode     read_only | workspace_write | danger_full_access
```

When omitted, the request still defaults to the conservative mode:

```text
approvalPolicy=on_request
sandboxMode=read_only
```

The selected policy enters `AgentRunContext`, is written to JSONL
`session_meta` and `turn_context`, and is emitted in `run_started` so the Debug
Console can display the exact mode used by the run.

The frontend now exposes the policy as part of the Agent form. This matters
because the model-visible tool surface is policy-dependent:

```text
read_only       -> no editing tools are sent to the model
workspace_write -> write/edit are sent to the model
danger_full_access -> write/edit are sent to the model and path policy can widen
```

The Debug page also gained a dedicated permission audit section. It summarizes
`tool_permission_decided` and `approval_requested` events before the lower-level
model/tool/history panels. Each audit card shows the tool, policy, path access,
prior-read state, decision source, decision type, reason, and expandable raw
payload. This makes permission behavior inspectable without mixing it into the
end-user Agent transcript.

The Session page became a JSONL browser instead of only a current-run viewer.
It lists local sessions via `GET /api/agent/sessions`, shows each session's
model and policy, and loads the selected raw JSONL records through
`GET /api/agent/sessions/[id]`. Debug remains an operational projection;
Session remains the durable replay substrate.

## Phase 26: Shell Tool And Command Safety

Researching Codex CLI and Claude Code (see
`docs/research-codex-claude-code.md`) showed both treat shell as a core tool
behind an argument-aware safety classifier, not just another annotated tool.

Added `shell` as a built-in tool with `bash -c` execution, a `workdir`
argument resolved through the existing path policy, a per-call soft timeout
layered under a hard runtime timeout, and per-stream output truncation
(10240 chars / 256 lines).

Added `lib/agent-shell-safety.ts`, a classifier that answers one question —
does this command match a known read-only pattern? — and is deliberately
conservative: any shell control construct (`;`, `&&`, `>`, `$`, backticks,
...) falls back to review rather than being analyzed.

The tool contract gained an optional `decidePermission` hook so a tool can
refine (but never override a deny from) the generic permission decision. This
let `shell` stay visible even in `read_only` runs: known-safe commands
auto-allow, everything else is denied or asked for depending on sandbox mode.

## Phase 27: Approval Pause And Resume

The `AgentApprovalRequiredError` planted in Phase 7 was a deliberate
fail-closed placeholder. This phase redeemed it for the streaming route.

Added `lib/agent-approvals.ts`: an in-process registry (stashed on
`globalThis` to survive Next.js's per-route module instancing) that turns a
pending approval into a plain Promise, resolved by approve, deny, a 120s
timeout, or the run's `AbortSignal`.

`AgentRunContext` gained `approvalMode: 'interactive' | 'fail_closed'`
(default `fail_closed`). Only `/api/agent/stream` sets `interactive`, because
only a live SSE connection has a channel to surface the request to a user;
the non-streaming `/api/agent` route keeps the original fail-closed behavior.

Two new routes resolve pending approvals:

```text
GET  /api/agent/approvals?runId=...
POST /api/agent/approvals/{runId}/{toolCallId}
```

`approval_requested` and `approval_resolved` were promoted from
debug-wrapped events to first-class SSE event types (`approvalRequired` /
`approvalResolved`), and the frontend gained an approval card with
Approve/Deny buttons driven by those events. A denial returns a recoverable
`APPROVAL_DENIED` tool output worded to steer the model away from retrying
the same call, instead of failing the run.

Pending state is intentionally not persisted to JSONL — matching both
reference systems, an approval is turn-scoped memory state, and a dead
process is treated as a denial. The full audit trail still lands in the
session JSONL, since both approval events are ordinary recorded agent
events.

## Phase 28: Session Replay And Resume

Since Phase 8, `session.id` and `context.runId` had always been the same
value: every `/api/agent/stream` call created a brand-new session containing
exactly one turn. The JSONL store was a single-turn audit log, not yet a
conversation that could be continued.

`AgentInput` gained an optional `sessionId` field, decoupling session
identity (stable across turns) from run identity (fresh per turn, as
before). `run_started` now carries both `sessionId` and `resumed`.

Added two functions to `lib/agent-session-store.ts`:

- `normalizeAgentResponseItemHistory(items)`: both OpenAI wire protocols
  require every tool call to have a matching tool response. A crash between
  committing a `function_call` and its `function_call_output` leaves an
  orphan; this inserts a synthesized `function_call_output`
  (`isError: true`, reusing the original `callId`) after any orphan call.
- `resumeAgentSession(sessionId)`: finds the session file, reads every
  `response_item` record in write order, normalizes it, and returns the
  reconstructed history without writing a new `session_meta`.

`lib/agent.ts` gained `initializeAgentSessionForStream` (exported for tests),
the single place deciding fresh vs. resumed session behavior. It separates
`history` (the full history sent to the model) from `newItemsToPersist` (only
the actually-new content written to disk) — for a resumed session that is
just the normalization's synthesized outputs plus the new user message,
never the whole reconstructed history. This keeps repeated resumes from
making the JSONL file grow superlinearly. Resuming an unknown `sessionId`
throws rather than silently starting a new session.

The frontend Session panel gained a "Continue this session" button that
writes the session id into the Agent form; the composer then shows a
"Continuing session ..." banner with a way to clear it. The sidebar's
session highlighting switched from `runId`-based to `sessionId`-based, so it
keeps highlighting the same conversation across turns.

Verified end to end through the real HTTP route (not just unit tests): a
second turn against an existing session correctly appended a new
`turn_context` (not a duplicate `session_meta`), and the resulting
`model_requested` event showed the model receiving all three accumulated
messages (system + both turns' user messages) instead of just the new one.

## Phase 29: Context Compaction

Session resume (Phase 28) sent the full reconstructed history to the model
verbatim on every turn. That works for a few turns, but token usage grows
linearly with turn count until it hits a limit -- the explicit gap the
resume phase left open.

Added `lib/agent-compaction.ts` with three pure functions:
`decideAgentHistoryCompaction` (fires only when the provider actually
reported `totalTokens` and it crosses a threshold, and the history is long
enough to be worth compacting), `buildCompactionSummaryRequest` (a
`tools: []` / `toolChoice: 'none'` request asking the model for a concise
summary), and `applyAgentHistoryCompaction` (full replacement: keep the
leading system message and budgeted recent user messages, drop every
assistant/function_call/function_call_output item, add one new
`compaction_summary` item). Because no tool call ever survives compaction
partially, the function_call/function_call_output pairing invariant holds
without a separate normalization pass, unlike session resume's mid-turn
crash case.

`AgentResponseItem` gained the `compaction_summary` variant. `lib/agent.ts`
now calls `modelGateway.createResponse(...)` -- the non-streaming method
that had existed on `AgentModelGateway` since its introduction but was never
used by the sampling loop -- between rounds, after tool outputs are fully
committed and before the next round's request, so compaction can never tear
apart an in-flight tool call. Only the new summary item gets persisted to
JSONL; the discarded items were already written when originally committed,
keeping the file append-only.

A new `history_compacted` event projects to a first-class debug event
(`historyCompacted`); the Debug Console gained a "Compactions" summary tile
and a card showing each compaction's token count, removed/kept item counts,
reason, and an expandable summary. Verified with a sampling-loop integration
test proving the round immediately after compaction sends the model a
shorter message list than before, and manually by injecting fake state to
confirm the Debug Console card renders correctly.

The compaction threshold (`DEFAULT_COMPACTION_TOKEN_THRESHOLD = 8000`) is a
fixed constant, not derived from any real model's context window, since
`ModelConfig` doesn't track that metadata yet.

## Deferred Work

The following are useful, but should build on top of the loop/history core
rather than bypass it:

- Anthropic Messages dialect
- more OpenAI-compatible providers
- OS-level sandbox enforcement
- durable (JSONL-persisted) pending approvals that survive a process restart
- session resume for the non-streaming `/api/agent` route
- forking a new session from a point in an existing session's history
- per-model compaction thresholds derived from real context-window sizes
- a microcompact path that evicts stale tool output without a model call
- retry/circuit-breaker behavior when a compaction summary call fails
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
