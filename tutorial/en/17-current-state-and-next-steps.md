# 17. Current State And Next Steps

This chapter summarizes what the harness can truly do now and which directions
are most valuable next. It is not a promise of a roadmap; it is an engineering
judgment based on the current boundaries.

After reading this chapter, you should understand:

- which agent foundations are already real
- why sandbox, write/edit, shell, and approval resume are still missing
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
- path policy boundary
- tool runtime boundary
- permission skeleton with path-policy hardening
- structured tool output contract
- Debug Console
- JSONL session store and viewer
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

Write/edit should not be simple file writes. They need:

- diff-oriented output
- approval decisions
- conflict behavior
- clear failure messages
- tests around partial changes

### Shell

Shell needs:

- command schema
- timeout
- cancellation
- output truncation
- approval rules
- safe command classification
- maybe PTY/session support

### Approval Resume

The current runtime can emit approval-needed events, but it cannot pause and
resume after user approval.

That requires durable pending state in JSONL.

### Session Replay

JSONL sessions exist, but replay does not.

Replay will need to reconstruct:

- run metadata
- turn context
- response-item history
- missing tool outputs if a crash happened mid-turn

### Context Compaction

Long histories will eventually need compaction. It must preserve:

- user goal
- current task state
- recent tool observations
- function_call/function_call_output invariants

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
approval resume, write/edit, shell, session replay, or telemetry can each be the
right next step depending on what needs validation.

### Misunderstanding 3: An Open-Source Tutorial Only Needs Final Code

Part of this project's value is the evolution. The tutorial should keep
tradeoffs and boundary changes, but organize them for public readers rather
than as an internal retrospective.

## Chapter Summary

The project already has the foundation of a real agent harness: model loop,
streaming, real read-only tools, provider dialects, session records, and debug
surfaces. Future work should follow the same rule: define the boundary,
implement the capability, then lock it down with tests and tutorial updates.
