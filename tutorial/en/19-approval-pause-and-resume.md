# 19. Approval Pause And Resume

This chapter explains how the harness turns an `ask` permission decision from
"fail immediately" into "suspend, wait for the user, then continue after
approval or denial." This is the first time the `AgentApprovalRequiredError`
planted in chapter 15 actually gets redeemed.

After reading this chapter, you should understand:

- why fail-closed was the right temporary answer, and where it stopped being
  enough
- how Codex and Claude Code design the approval suspend/resume channel
- why pending approvals are process memory state, not JSONL-persisted state
- why the denial tool output needs deliberate wording
- how the SSE event contract promotes approval from debug-only to a
  first-class event

## Background

When chapters 15 and 16 introduced the three-state permission decision model
(`allow` / `ask` / `deny`), the `ask` branch had exactly one path: throw
`AgentApprovalRequiredError` and fail the run. The tutorial said so
explicitly at the time — "interactive approval/resume is not implemented
yet" — that was a deliberate boundary, not an oversight.

Fail-closed was correct at that stage: without a suspend mechanism, letting a
risky tool call execute silently is far more dangerous than failing outright.
But it meant every policy combination that could trigger `ask` (strict
approval, or the default `on_request` policy hitting a tool without complete
annotations) was practically unusable — the run would always abort.

Researching how Codex CLI and Claude Code actually implement this (see
[`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))
turned up a striking similarity: approval is not a separate
"suspend/resume subsystem." It is **one suspended Promise**.

## Design Choice

### A pending approval is a resolver in memory

`lib/agent-approvals.ts` is the entire state layer:

```text
waitForAgentApproval(input)   register a pending approval, return a Promise
resolveAgentApproval(...)     look up by runId + toolCallId and resolve it
listPendingAgentApprovals()   list everything still pending (for UI recovery/polling)
```

This maps directly onto the research: Codex uses `oneshot::channel()` plus a
`pending_approvals` map, Claude Code uses a suspended Promise behind the
`canUseTool` callback — both are **process-memory state**, neither persists
to disk. That is not laziness, it is a design choice: an approval is
turn-scoped transient state, and a dead process counting as a denial is
actually the safe default.

```ts
export function waitForAgentApproval(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  signal: AbortSignal | undefined;
  timeoutMs?: number;
}): Promise<AgentApprovalResolution>
```

Three resolution paths:

```text
user approves    { type: 'approved', source: 'user' }
user denies      { type: 'denied', source: 'user', reason }
timeout          { type: 'denied', source: 'timeout', reason }  (default 120000ms)
run aborts       { type: 'denied', source: 'abort', reason }
```

Timeout and abort both collapse into `denied` — from the model's perspective,
"nobody showed up to approve" and "the user explicitly said no" should follow
the same recovery path; there is no reason to distinguish them.

### Why the registry lives on `globalThis`, not a module-level variable

The registry is stashed on `globalThis` under
`Symbol.for('myJsTest.agentApprovalRegistry')` instead of a top-level
`new Map()`. The reason: Next.js can load the same `.ts` file as multiple
module instances along certain bundling paths (the stream route and the
approvals route may each end up with their own "separate" copy of
`agent-approvals.ts`). If the registry were a module-level variable, both
routes would see an empty map and an approval request would never find the
pending entry the other route registered. `globalThis` guarantees exactly one
registry per Node process, independent of how the route files get bundled.

### Runtime integration: the `ask` branch goes from throw to await

In `lib/agent-tool-runtime.ts`, `executeAgentToolCall` used to do:

```text
permissionDecision.type === 'ask'  ->  throw AgentApprovalRequiredError
```

Now it does:

```text
permissionDecision.type === 'ask':
  emit approval_requested
  resolution = await waitForInteractiveToolApproval(...)
  emit approval_resolved
  resolution.type === 'denied':
    return a recoverable tool output with code APPROVAL_DENIED (no throw)
  resolution.type === 'approved':
    fall through to normal execution
```

`waitForInteractiveToolApproval` is a thin fork:

```ts
if (context.approvalMode !== 'interactive') {
  throw new AgentApprovalRequiredError(request, decision);
}
return waitForAgentApproval({...});
```

This preserves chapter 15's behavior as the default — the new
`approvalMode` field on `AgentRunContext` defaults to `'fail_closed'`, and
only an explicit `'interactive'` actually suspends and waits. The
non-streaming `/api/agent` route has no push channel to surface an approval
request to the user, so it correctly stays fail-closed. The
`/api/agent/stream` route passes `approvalMode: 'interactive'`, because the
SSE connection is itself the channel that tells the user "a decision is
needed now."

### The synchronous registration guarantee: why tests don't need sleeps

`waitForAgentApproval`'s Promise executor runs synchronously —
`registry.set(...)` happens inside the `new Promise((resolve) => {...})`
executor, and the executor itself has no `await`. That means: from the call
to `await waitForInteractiveToolApproval(...)` inside `executeAgentToolCall`
up to the point the `await` actually suspends, the registry entry is already
written. An async function runs synchronously up to its first
control-yielding `await`, so the caller can safely call
`resolveAgentApproval` in the very same tick it receives the pending promise
— no `setTimeout`, `setImmediate`, or polling required.

That guarantee lets tests read like this (see below):

```ts
const executionPromise = executeAgentToolCall(toolCall, context, callbacks);
const resolveResult = resolveAgentApproval(runId, toolCallId, 'approve');
assert.equal(resolveResult.ok, true);
const execution = await executionPromise;
```

The one exception is the sampling-loop-level integration test: there, the
approval request passes through several more layers of `await` (stream
consumption, tool batch scheduling) before `waitForAgentApproval` is
actually reached. Those tests defer the resolve call with `queueMicrotask` to
guarantee the registry entry exists by the time it runs (see
[`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts)).

### Wording the denial for the model

The `APPROVAL_DENIED` error message is deliberately written as:

```text
{reason} The action was not performed. Do not retry the same call;
take a different approach or explain what you need in the final answer.
```

This directly mirrors the pattern found in both Codex (`"rejected by user"`)
and Claude Code ("The tool use was rejected... take a different approach") —
a denial is not an ordinary tool error, it needs to **explicitly steer the
model away from retrying**. Otherwise the model easily re-issues the same
call on the next round, re-triggering approval and looping. Chapter 16's
repeated-call guard is a backstop for that case, but it is better to make
"don't retry" explicit in the wording from the start.

## API Surface

Two new routes:

```text
GET  /api/agent/approvals?runId=...
POST /api/agent/approvals/{runId}/{toolCallId}   body: { decision: "approve" | "deny" }
```

`GET` is for recovery/polling — if the frontend reloads the page or misses an
SSE event, it can actively query which approvals are still pending. `POST` is
the core action; its response includes a snapshot of the resolved `pending`
entry plus the final `resolution`, so the frontend can confirm state even
without waiting for the SSE echo.

Request body validation follows the project's usual Zod convention
(`lib/agent-approval-input.ts`), reusing the `formErrors`/`fieldErrors` error
shape.

## Stream Event Contract

`approval_requested` and `approval_resolved` always existed in the internal
`AgentEvent` union (the former since chapter 15), but how they project to SSE
changed. `approval_requested` used to be wrapped inside a `debug` event; now
both are promoted to **first-class stream events**:

```text
type AgentStreamEvent =
  | { type: 'approvalRequired'; request: AgentApprovalStreamRequest }
  | { type: 'approvalResolved'; runId; toolCallId; toolName; resolution }
  | ... (the existing step / assistantDelta / debug / done / error)
```

This is not cosmetic. Debug events are for runtime observation — the Debug
Console shows them, but the core UI does not depend on them. An approval
request needs to drive a real user interaction (clicking Approve/Deny), so it
must be a mainline event type the frontend is guaranteed to handle, not a
debug detail that could be filtered away.

## Frontend

The `AgentApprovalBar` component subscribes to the
`onApprovalRequired`/`onApprovalResolved` callbacks and stores pending
approvals in `agentView.pendingApprovals` (meaningful only in the
`streaming` status). Each card shows the tool name, formatted argument JSON,
the denial reason, and Approve/Deny buttons that call
`submitAgentApprovalDecision` to POST the decision.

The card is not removed in the POST success callback — it is removed only
when the SSE stream delivers the `approvalResolved` event. That keeps the
frontend state consistent with the runtime's actual state regardless of
whether the POST response or the SSE event arrives first.

## Permission Behavior Matrix

| approvalMode | Decision | Result |
| --- | --- | --- |
| `fail_closed` (default, non-streaming API) | `ask` | throws `AgentApprovalRequiredError`, run fails |
| `interactive` (`/api/agent/stream`) | `ask` | suspends, waits for approve/deny/timeout/abort |
| any | `deny` | returns a recoverable tool output directly, never enters the approval channel |
| any | `allow` | executes normally, never touches the approval system |

## What Is Still Missing

- **No pending-approval recovery across a process restart.** This is a
  deliberate tradeoff matching Codex and Claude Code; a future cross-process
  persistence layer would need to write pending state to JSONL and reconstruct
  it on session resume.
- **No "approved for session" shortcut.** Codex's `ApprovedForSession` and
  Claude Code's persisted "don't ask again" rules have no equivalent yet;
  every `ask` requires its own approval.
- **No automatic retry after an approval timeout.** After 120 seconds the
  request is simply treated as denied, and the model has to decide what to do
  next on its own.

## Which Tests Prove It

- [`tests/agent-approvals.test.ts`](../../tests/agent-approvals.test.ts):
  registration/resolution/timeout/abort/unknown-pending for the approvals
  module, plus the approve, deny, and run-abort paths of
  `executeAgentToolCall` under interactive mode
- Two new integration tests in
  [`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts):
  the loop produces a final answer after an approval is granted; the loop
  produces a final answer with a recoverable error after a denial
- The existing fail-closed test (`risky tools request approval and fail
  closed...`) is unchanged, proving the default behavior was not broken

## Chapter Summary

Approval resume's core idea is not a new state machine — it is modeling
"waiting for the user" as an ordinary Promise that can be resolved or time
out, and having the runtime honestly `await` it inside the `ask` branch.
Pending state lives in memory rather than on disk, a choice learned directly
from how Codex and Claude Code implement the same boundary, and a judgment
call about where this layer should stop for now — persisting pending state is
a bigger capability (it touches process-restart semantics) that can wait
until something actually needs it.

## Chapter Checkpoint

The approvals module and its loop integration each have a key-free test set.
Run the module layer first:

```bash
npx tsx --test tests/agent-approvals.test.ts
```

Measured tail output:

```text
✔ interactive tool runtime executes the tool after approval (0.750166ms)
✔ interactive tool runtime returns a recoverable error after denial (0.245958ms)
✔ interactive tool runtime denies when the run aborts while waiting for approval (0.169791ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Then run the two sampling-loop integration cases by name — continue after
approval, and continue with a recoverable error after denial:

```bash
npx tsx --test --test-name-pattern "interactive" tests/agent-sampling-loop.test.ts
```

The measured output is `✔ resumes the loop after an interactive approval is
granted` and `✔ resumes the loop with a recoverable error after an
interactive denial`. The API boundary can also be verified without a key:
with the dev server running, `curl "http://localhost:3102/api/agent/approvals?runId=demo"`
returns `{"ok":true,"pending":[]}`, and posting a decision for a pending
approval that does not exist returns 404 with `"No pending approval found for
run demo-run and tool call demo-call. It may have already been resolved or
timed out."`.
