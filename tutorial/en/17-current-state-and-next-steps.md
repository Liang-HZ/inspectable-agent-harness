# 17. Current State And Next Steps

This chapter summarizes what the harness can truly do now and which directions
are most valuable next. It is not a promise of a roadmap; it is an engineering
judgment based on the current boundaries.

After reading this chapter, you should understand:

- which agent foundations are already real
- why sandbox, shell, approval resume, and deeper editing safety are still missing
- why session replay and context compaction are likely future pressure points
- how future tutorial chapters should stay maintainable

## What Is Real Now

The project now has a real inspectable agent harness foundation:

- thin Next.js API routes
- schema-first input validation
- OpenAI-compatible chat service
- streaming agent route
- cancellation boundary
- internal runtime events
- provider-neutral model gateway
- OpenAI Chat Completions dialect
- OpenAI Responses dialect
- OpenAI strict tool-schema adapter
- `AgentResponseItem` model-visible history
- streaming sampling loop
- assistant commit semantics
- deterministic runtime tests
- read-only tools: `ls`, `find`, `grep`, `read`
- editing tools v1: `write`, `edit`
- read-before-edit runtime precondition
- path policy boundary
- tool runtime boundary
- permission skeleton with path-policy hardening
- run policy request contract and frontend controls
- structured tool output contract
- Debug Console with permission audit
- JSONL session store and browser
- tool source/group/path/execution contract
- unlimited loop with repeated-call guard

## What Is Still Missing

### Sandbox

Current path policy is not an OS sandbox. It is a runtime path boundary.
`sandboxMode` now maps to the effective path policy used by file tools:
`read_only` keeps the current project boundary, while `danger_full_access`
allows path-declaring read-only tools to access absolute paths outside the
project.

The remaining production step is OS-level enforcement and richer modes for
write/edit, shell, and network-capable tools:

```text
read-only
workspace-write
danger-full-access
external sandbox
```

### Write/Edit

Write/edit now exists as a first real editing layer:

- diff-oriented output
- clear failure messages
- tests around partial changes
- exact replacement validation before writing
- read-before-edit enforcement in the runtime

What is still missing is the deeper production layer:

- interactive approval/resume for edits that need a human decision
- richer conflict behavior when files change between read and edit
- stronger concurrency control around multiple write-capable calls
- OS-level sandbox enforcement below the runtime path policy

### Shell

Shell v1 now exists (see chapter 18): a command schema, per-call timeout,
cancellation, output truncation, a safe-command classifier, and a tool-level
permission override.

Still missing:

- PTY / interactive session support
- background execution and streamed output
- middle-truncation or persist-to-disk handling for large outputs
- OS-level sandbox enforcement

### Approval Resume

Now implemented (see chapter 19): under `interactive` approval mode, an `ask`
decision suspends the tool-call promise, and
`POST /api/agent/approvals/{runId}/{toolCallId}` approves or denies it to
resume execution. A denial produces a model-visible recoverable error, so the
loop continues instead of failing the run.

Pending state lives in process memory (`Map<runId:toolCallId, resolver>`),
not on disk — matching Codex and Claude Code: an approval is turn-scoped
transient state, and a dead process counts as a denial. The full audit trail
(who requested/approved/denied what, and when) already lands in the existing
JSONL session event log, since `approval_requested`/`approval_resolved` are
ordinary recorded events.

Still missing: recovering pending approvals across a process restart (if that
ever matters, pending state would also need to be written to JSONL and
reconstructed on resume).

### Session Replay

Now implemented (see chapter 20): a `sessionId` input field lets the same
JSONL session be continued more than once, `resumeAgentSession` reconstructs
model-visible history from the response-item records, and
`normalizeAgentResponseItemHistory` repairs orphan `function_call` items left
by a mid-turn crash. Resume only writes new content back to disk (the
synthesized outputs from normalization plus the new user message), never the
whole history.

Still missing: the non-streaming `/api/agent` route has no session concept;
there is no way to fork a new session from a point in history (Codex's
`fork`); the Session panel still shows a single flat JSONL stream without
visually separating turns.

### Context Compaction

Now implemented (see chapter 21): once reported token usage crosses a
threshold, `decideAgentHistoryCompaction` triggers, and
`applyAgentHistoryCompaction` applies a full-replacement strategy — keeping
the system message, one model-generated summary, and budgeted recent user
messages, with everything else absorbed into the summary. Because
compaction never keeps a tool call partially, the
function_call/function_call_output pairing invariant is satisfied almost
automatically.

Still missing: the threshold is a fixed constant, not configured per
model's context window; there is no Claude Code-style microcompact that
skips the model call; summary generation has no retry or circuit breaker on
failure.

### MCP / Dynamic / Hosted Tools

The tool contract already has source categories. Only built-ins are active.

Future work can add:

- dynamic tool registration
- MCP discovery and dispatch
- hosted provider tools
- tool-search/discovery

## How To Add Future Chapters

Every new capability should add or update a tutorial chapter with:

```text
why the layer appeared
what boundary was introduced
what data flows through it
what tradeoff was accepted
which tests prove it
what remains deferred
```

That keeps the tutorial aligned with the code instead of turning into an
after-the-fact README.

## Common Misunderstandings

### Misunderstanding 1: Fewer Than 6000 Backend Lines Means Little Capability

Line count is not the only measure of capability. The value here is clean
boundaries: provider dialects, runtime spine, tools, sessions, debug, streaming,
and tests already form an extensible skeleton.

### Misunderstanding 2: Sandbox Must Always Be Next

Sandbox is important, but "sandbox" has layers. The project now has
pre-execution permission decisions and path-policy hardening. OS sandboxing,
approval resume, deeper editing safety, shell, session replay, or telemetry can
each be the right next step depending on what needs validation.

### Misunderstanding 3: An Open-Source Tutorial Only Needs Final Code

Part of this project's value is the evolution. The tutorial should keep
tradeoffs and boundary changes, but organize them for public readers rather
than as an internal retrospective.

## Chapter Summary

The project already has the foundation of a real agent harness: model loop,
streaming, real read-only tools, editing tools v1, provider dialects, session
records, and debug surfaces. Future work should follow the same rule: define
the boundary, implement the capability, then lock it down with tests and
tutorial updates.
