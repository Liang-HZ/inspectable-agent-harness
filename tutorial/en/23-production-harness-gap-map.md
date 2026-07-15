# 23. The Gap Map to Production Harnesses

Chapter 17 answers "what this project has and what comes next." This chapter
answers the other question an informed reader will ask: compared to
production harnesses like Codex CLI and Claude Code, which mechanisms are
still missing here, and why did this project choose not to build them?

This is the book's "edge of the map" chapter. These gaps must be stated by
the author first, not left for the reader to discover — drawing the boundary
proactively is a credibility asset, and it is also this book's methodology:
a declared simplification and an unnoticed omission are two entirely
different things. Every item below was checked against the current code, not
written from memory.

After reading this chapter, you should understand:

- which categories of mechanism concentrate the gap between this harness and
  production ones
- how each gap is closed in production systems
- why this project's answer to each gap is "not now," and when it becomes
  worth doing
- the recommended order, with reasons, if you want to keep adding capability

## The Table

| Mechanism | This project today | What production harnesses do |
| --- | --- | --- |
| OS-level sandbox | path policy + lexical argument screening, no kernel enforcement | Codex: macOS Seatbelt / Linux Landlock; Claude Code: sandbox mode |
| Environment context injection | system prompt is a hard-coded constant; no cwd/date/tree digest | auto-injected environment block + AGENTS.md / CLAUDE.md project memory |
| Model-call retry | 429/5xx/dropped stream goes straight to `run_failed` | retryable-error classification + exponential backoff |
| Provider coverage | OpenAI's two wire forms only; capabilities declared but never consumed | multiple provider dialects; Anthropic Messages is the real touchstone |
| MCP | `'mcp'` in the source enum is a placeholder | full discovery/dispatch/lifecycle |
| Subagents | none | Claude Code's Task tool spawns subtasks |
| Hooks and persistent rules | `hook`/`guardian` decision sources are placeholders; every ask is approved one-off | settings allowlists, "approved for session," hook chains |
| Prompt caching | passive `cachedInputTokens` accounting only | cache breakpoint control, stable-prefix engineering |
| Steering | no way to inject a message mid-run; cancel is the only intervention | queue/insert user input while running |
| Miscellaneous | fixed threshold, no microcompact/fork/durable approvals/SSE reconnect | see the miscellany section below |

The table is an index; the sections below expand each topic in the same
structure: this project today → the production approach → why not here, and
when it becomes worth doing.

## 1. OS-Level Sandbox

**Today**: this project's execution boundary is two stacked layers — file
tools go through path policy (`lib/agent-path-policy.ts`), and shell goes
through the argument-aware safe-command classifier
(`lib/agent-shell-safety.ts`) plus the permission composition rule. Chapter
18 already said it plainly: the classifier is **lexical**. It sees what the
command string looks like; it cannot follow symlinks and cannot see runtime
behavior. `cat ./innocent.txt` is lexically clean, but if that file is a
link to `/etc/passwd`, the read still lands outside the project.

**Production**: Codex uses Seatbelt on macOS and Landlock on Linux to lock
filesystem and network access at the kernel — a command string can fool
lexical analysis but not the kernel. Claude Code has a sandbox mode for the
same kind of isolation. In that architecture the classifier only saves
approvals; the sandbox is the backstop.

**Why not here**: an OS sandbox is platform-specific deep water (one
mechanism per platform, orthogonal to the teaching thread), and the
structure itself — classifier saves approvals, permission boundary decides,
real execution enforcement absent — is exactly what this book wants to
teach. When it becomes worth doing: the moment this harness has to run on
untrusted input, it stops being optional.

## 2. The Other Half of Context Assembly

**Today**: `AGENT_SYSTEM_MESSAGE` in `lib/agent.ts` is a hard-coded string
constant; the user prompt is assembled by `buildAgentPrompt` from three
sections — Task/Goal/Context — where Context is **manually supplied by the
user**, not collected by the runtime. No cwd injection, no current date, no
directory-tree digest, no git status, and no AGENTS.md / CLAUDE.md-style
project memory mechanism — everything the model knows about "where it is"
comes from tool-call exploration.

**Production**: Codex and Claude Code both assemble an environment block per
turn (cwd, date, platform, directory overview, git status) and inject the
project root's AGENTS.md / CLAUDE.md content as persistent instructions.
This is the often-overlooked other half of the harness story: tools decide
what the model can **do**; context assembly decides what the model
**knows**.

**Why not here**: not hard, just not its turn yet — the tutorial's main
thread patched behavioral boundaries first (shell/approval/resume/
compaction). It is also the **cheapest gap to close**: one pure function
that folds environment facts into the system message, a set of tests
asserting the injected content, one tutorial chapter. That is why it is
first in the recommended order.

## 3. Model-Call Retry and Backoff

**Today**: the model gateway (`lib/model-gateway.ts`) has no retry logic at
all. 429s, 5xxs, and dropped streams propagate up to the sampling loop and
become a terminal `run_failed` event. The terminal event itself is complete
(that was a real fix — runs never hang silently), but the recovery strategy
is zero: one transient hiccup ends the whole run.

**Production**: production harnesses classify errors into retryable (429,
5xx, dropped stream, timeout) and non-retryable (4xx semantic errors, auth
failures), apply jittered exponential backoff to the former, and record
retry counts in telemetry.

**Why not here**: pedagogically, "failure must be visible" outranks
"failure must self-heal" — retry logic written too early papers over
boundary problems. But this gap hurts first in real use: a long conversation
dies at round ten because of one 429, and a failed compaction summary call
takes the whole run down with it (declared in chapter 21). It is second in
the recommended order.

## 4. Provider Coverage

**Today**: the provider-neutral `AgentResponseItem` IR has only ever been
validated against OpenAI's two wire forms (Chat Completions, Responses).
`AgentModelCapabilities` (tools/streaming/streamingUsage/parallelToolCalls)
is declared by every dialect, but **no runtime code reads it today** — a
declared contract with no consumer, which is the honest state of things.

**Production**: supporting multiple providers is not adding a baseURL; it is
subjecting the IR to a structurally different protocol. The Anthropic
Messages API is the real touchstone: content is an array of blocks rather
than a string, tool results return as `tool_result` blocks inside user
messages, and system is a top-level parameter rather than a message. Any
OpenAI-shaped shortcut in the IR gets exposed at exactly those three spots.

**Why not here**: two OpenAI forms were enough to establish the teaching
value of the dialect boundary. But "provider-neutral" is currently a claim
untested by a second party — adding an Anthropic dialect is the shortest
path to testing it, and it is third in the recommended order.

## 5. MCP

**Today**: the `AgentToolSource` enum includes `'mcp'` (and `'dynamic'`,
`'hosted'`), but only the builtin groups are active. `'mcp'` is a reserved
type placeholder: no discovery, no dispatch, no server lifecycle.

**Production**: Codex and Claude Code both ship full MCP clients — startup,
handshake, tool enumeration, call forwarding, error and timeout boundaries —
and external tools go through the same permission layer as built-ins.

**Why not here**: MCP's complexity is protocol-client engineering (process
management, handshake, capability negotiation) with limited teaching
increment — the tool contract boundary has already abstracted away "where a
tool comes from." The placeholder enum is the design intent made explicit:
the attachment point is reserved, so adding it later needs no refactor.

## 6. Subagents and Task Spawning

**Today**: none, explicitly out of scope. A run is one sampling loop; there
is no mechanism to spawn subtasks.

**Production**: Claude Code's Task tool spawns subagents with independent
context to handle subtasks and reports results back to the main loop — in
essence trading an extra context window for the main conversation's token
budget.

**Why not here**: subagents are "orchestration of multiple harness
instances"; introducing that while the single loop is still being polished
would only dilute the main thread. Revisit after the single loop's
boundaries (especially steering and retry) are stable.

## 7. Hooks and Persistent User Rules

**Today**: in the `AgentPermissionDecisionSource` enum, `hook`, `user`, and
`guardian` are placeholders — the sources that actually appear in decisions
are only `annotation`, `policy`, and `tool_override`. There is no
settings-style allowlist (Claude Code's `permissions.allow` prefix rules)
and no "approved for session" (Codex's `ApprovedForSession`): the same
command triggers a fresh approval every time it hits ask.

**Production**: the research notes (`docs/research-codex-claude-code.md`)
record both rule systems in full: Claude Code's fixed deny → ask → allow
evaluation order with prefix wildcards, and Codex's execpolicy extensions
with prefix rules persisted at approval time.

**Why not here**: the hard part of a rule system is **designing the rule
language** (the safety of prefix matching, the deny-is-final layering). Done
shallowly it is a security hazard; done properly it is a project of its own.
"Ask every time" is annoying but safe, and the direction is right.

## 8. Prompt Caching

**Today**: both OpenAI dialects read `cachedInputTokens` from responses and
account for it in the usage rollup — and that is all. No cache breakpoint
control, no stable-prefix engineering for hit rates, no hit-rate exposure as
an observable metric.

**Production**: production harnesses actively manage the cache: Anthropic's
explicit `cache_control` breakpoints, byte-stable system prompts and tool
definitions, and Codex deriving synthetic call ids via UUIDv5 precisely so
cache keys never break. At scale this is an order-of-magnitude cost
difference on long conversations.

**Why not here**: cache optimization only pays off when call volume makes
cost tangible, which a teaching project never feels. Worth noting, though:
chapter 20's decision to reuse the original callId on resume already
preserved cache friendliness in passing — draw the boundary right, and the
later optimization needs no rework.

## 9. Steering

**Today**: once a run starts, the user can do exactly two things: respond to
approval requests, and cancel the whole run. There is no channel for "one
more sentence while it runs" — when the model drifts, the only option is to
abort and start over with a better prompt (resume means starting over keeps
the history, but the intermediate rounds' work is lost).

**Production**: Codex supports injecting user input within a turn, and
Claude Code lets you keep typing while it runs (queued as the next user
message, or interrupting the current sampling). Steering is one of the core
experience gaps between interactive agents.

**Why not here**: steering touches the sampling loop's most sensitive
invariant — the injection point must align with function_call/output pairing
boundaries or it tears the history apart. In this project it is a real but
deep change that deserves its own chapter, not a feature to slip in.

## 10. Miscellany

The following gaps were each declared in their chapter's "what is not done"
section; collected here in one place:

- **The compaction threshold is hard-coded at 8000 tokens**
  (`DEFAULT_COMPACTION_TOKEN_THRESHOLD`). That number is far below modern
  context windows — against a 200K-window model it triggers compaction at 4%
  utilization, discarding usable context far too early. The production
  answer is per-model configuration (Codex's
  `model_auto_compact_token_limit`).
- **No microcompact.** Every compaction costs an extra model call; Claude
  Code's lightweight path (no model call, just evicting stale tool_result
  blocks) has no counterpart here.
- **No session fork.** You can only continue from the latest state, not
  branch from a point in history (Codex's `fork`).
- **No durable approvals.** Pending approvals are process memory; a restart
  equals denial — consistent with both production systems, but their
  persistent rules (item 7) soften the re-approval cost, and this project
  has none.
- **No SSE reconnection.** A dropped stream has no Last-Event-ID-style
  resumption; the live observation window for a run is one-shot.
- **Permissions see a single path argument.** `AgentPermissionRequest`
  carries one `pathArgumentName`/`requestedPath`; a future two-path tool
  like copy/move would need the permission layer extended first.

## If You Want to Keep Adding Capability

The recommended order, with reasons:

1. **Environment context injection** — cheapest, risk-free, improves every
   real use immediately; the standard cadence of pure function + tests + one
   tutorial chapter.
2. **Model-call retry** — the gap that hurts first in real use; error
   classification is itself boundary design worth teaching.
3. **Anthropic dialect** — the shortest path to testing the central
   "provider-neutral" claim; also the first time the capabilities
   declarations get consumed by the runtime.
4. **OS sandbox** — after the first three make the harness worth daily use,
   the safety boundary graduates from a teaching declaration to kernel
   enforcement.
5. **MCP** — the attachment point for the tool ecosystem, redeeming the
   placeholder enum.

The logic of the order: first what makes it useful (1, 2), then what tests
the core claim (3), then what makes it trustworthy (4), and finally what
makes it open (5). Every step follows chapter 17's discipline: define the
boundary, expose the data flow, write real tests, update the tutorial.

## Chapter Summary

This chapter is not an apology list; it is a boundary map. Every gap has
three coordinates: where this project stops, where production systems go,
and why stopping here was a choice. A teaching harness's value is not in
pretending to be complete — it is in every incompleteness being declared,
explained, and annotated with an upgrade path. A reader carrying this map
into the Codex and Claude Code source trees knows what to look for.
