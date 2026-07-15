# 14. Debug Console And Session Viewer

This chapter explains how the frontend splits a single transcript into three
views: an end-user Agent page, a developer Debug Console, and a durable Session
Viewer.

After reading this chapter, you should understand:

- who the Agent page, Debug page, and Session page are for
- why model input and model output both belong in debug
- why JSONL session records are not Debug Console state
- why permission audit belongs in Debug while run policy belongs in API,
  Debug, and Session surfaces
- why tool inputs and outputs are collapsed by default

## Background

Once the runtime had streaming rounds and real tools, the frontend needed to
show more than a final answer.

The first Debug Console exposed a semantic gap: it showed model requests, but
not enough of the corresponding model output and committed history.

## Three Views

The frontend now separates:

```text
Agent page    end-user-facing transcript
Debug page    runtime inspection
Session page  persisted JSONL records
```

This split prevents debug terminology from leaking into the normal agent
experience.

## Agent Page

The Agent page shows:

- assistant text
- grouped tool batches
- final answer
- collapsed run details

It does not expose "round 1", "round 2" style runtime labels.

Assistant text renders as Markdown with GFM support because models commonly
produce lists, tables, and code blocks.

## Debug Page

The Debug page shows:

- run policy
- permission audit decisions
- model input
- model output
- assistant deltas
- committed assistant messages
- tool calls
- tool arguments
- tool results
- model-visible `modelOutput`
- internal tool details
- usage and raw usage
- history commits

Debug data comes from runtime events plus stream-only debug events.

## Session Page

The Session page browses persisted JSONL through:

```text
GET /api/agent/sessions
GET /api/agent/sessions/[id]
```

It first lists local sessions, then loads the selected session's raw records
because this page is meant to inspect the replay substrate directly.

The session list shows model, session id suffix, `approvalPolicy`, and
`sandboxMode`. The full JSONL still renders as raw records instead of being
reshaped into the Debug Console event view.

## Why Debug And Session Are Separate

Debug is operational. Session is durable.

`debug.historyCommitted` is not stored as another `agent_event` because the
session already stores authoritative `response_item` records.

This avoids polluting future resume state with debug-only duplication.

Permission audit follows the same boundary. The Debug page uses it to explain
`allow/ask/deny` decisions to developers. The Session page shows the actual
`agent_event` and `response_item` records written to JSONL.

## Frontend Implementation

The main file is:

```text
components/chat-playground.tsx
```

Supporting types and clients:

```text
lib/agent-api-types.ts
lib/agent-api-client.ts
lib/agent-stream-projection.ts
```

## Current Status

This layer makes the Debug Console and Session Viewer a permanent part of the
workbench: model inputs and outputs, tool details, the permission audit, and
JSONL session records each have a stable place to be inspected. It is the
first tool to reach for when diagnosing agent behavior.

## Verification

Manual verification is important here:

1. start the dev server
2. run an agent task that uses `ls/find/grep/read`
3. check Agent page for readable transcript
4. check Debug page for model input/output and tool details
5. check Debug page for permission audit
6. check Session page for the session list and selected JSONL records

## Common Misunderstandings

### Misunderstanding 1: Debug Data Belongs On The Agent Page

The Agent page is for end users and should show a natural process: assistant
text, tool batches, and final answer. Rounds, raw requests, usage, and JSONL
belong to debug/session views.

### Misunderstanding 2: Model Input Is Enough

It is not enough. Model output, committed assistant messages, tool calls, and
usage are core telemetry facts. The Debug Console needs input/output pairing.

### Misunderstanding 3: Tool Details Should Expand By Default

Tool inputs and outputs can be long. Collapsing them by default protects the
reading flow while keeping details available.

## Chapter Summary

This chapter separates frontend observation surfaces: the Agent page tells the
end-user story, the Debug Console inspects runtime details, and the Session
Viewer shows durable JSONL records.

## Chapter Checkpoint

The first item needs no key. Start the dev server (`npx next dev -p 3102`),
then ask the session read API for an id that does not exist:

```bash
curl -i http://localhost:3102/api/agent/sessions/does-not-exist
```

Measured response (status line and body):

```text
HTTP/1.1 404 Not Found
{"ok":false,"error":"Agent session was not found."}
```

`GET /api/agent/sessions` returns `{"ok":true,"sessions":[]}` on a fresh
checkout with no runs yet. These two endpoints are exactly what the Session
Viewer consumes — list first, then load raw records by id.

The second item requires `.env.local` configured per chapter 0: run an Agent
task that uses `ls/grep/read`, then walk the three views — the Agent page is
a clean transcript (no "round" labels), the Debug page shows model
input/output, tool details, and the permission audit, and the Session page
lists the run and expands its line-by-line JSONL records.
