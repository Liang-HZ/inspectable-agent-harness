# 21. Context Compaction

This chapter explains how the harness turns "the history sent to the model
grows linearly until it hits a limit" into "compact automatically once a
threshold is reached, then keep the conversation going." This is the
explicit gap the previous chapter's session resume left behind — resume
solved "how to get history back," not "what to do when history gets too
big."

After reading this chapter, you should understand:

- why this project chose "full replacement" over "trim item by item"
  compaction
- why compaction has to reuse the same model gateway rather than opening a
  new call path
- why the function_call/function_call_output pairing invariant is almost
  free here
- which boundary in the loop compaction happens at, and why it has to be
  that boundary
- how compaction keeps working across session resume, and why the first
  version silently didn't
- why this isn't a threshold design you can drop straight into production

## Background

Chapter 20 let the same session be continued repeatedly, but resume's
guiding principle was "send the reconstructed full history to the model
verbatim." That's fine for two or three turns, but as turn count grows, the
messages array produced by `responseItemsToModelMessages(history)` grows
linearly, and eventually either exceeds the model's context window or
spends most of its tokens on stale tool output before hitting the limit.

Researching Codex and Claude Code (see
[`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))
found different mechanisms aimed at the same goal:

- Codex's strategy is **full replacement**: `initial_context + recent
  original user messages (reverse-filled within a budget) + one summary
  message`, triggered by `model_auto_compact_token_limit`, with support for
  mid-turn compaction.
- Claude Code has two layers: a lightweight microcompact (no model call,
  just evicting stale large tool_result blobs) and a full compact that calls
  the model for a nine-section summary, triggered around 92% of the context
  window.

This project picks Codex's "full replacement" strategy for a direct reason:
this project's `AgentResponseItem` history structure is closer to Codex's
response-item model than to Claude Code's tool_use/tool_result block
structure, and reusing the "what's worth keeping separately" judgment
already established by chapter 20's resume (the system message, recent user
messages) is simpler than inventing a separate set of microcompact rules.

## Design Choice

### The threshold check: only fire when real usage data exists

`lib/agent-compaction.ts`'s `decideAgentHistoryCompaction`:

```text
tokenUsage === null           -> don't compact (the provider didn't report usage, no way to judge)
totalTokens < threshold       -> don't compact
history.length < 4            -> don't compact (barely more than system+user, nothing worth compacting)
otherwise                     -> compact, with the reason string carrying the actual token count
```

`tokenUsage` can be `null` — not every provider reports usage on every
response, and mid-stream events almost never do. This project chooses to
**skip the check rather than guess** when there's no data — a conservative
choice: missing one compaction opportunity is better than making a
compaction decision off a bad estimate.

The default threshold `DEFAULT_COMPACTION_TOKEN_THRESHOLD = 8000` is a
teaching-size constant, not derived from any model's real context window —
this project doesn't currently track metadata like "how large is the
current model's context window" (`ModelConfig` only has
`apiKey`/`baseURL`/`model`/`wireApi`). Production would need to configure
this per model; here a fixed value is enough to get the mechanism working.

### What survives compaction: full replacement, not trimming

`applyAgentHistoryCompaction`'s output rule:

```text
keep:     the leading system message at the start of history, if any
add:      one compaction_summary message, containing the model-generated summary
keep:     recent user messages, reverse-filled from newest to oldest, budgeted at 20000 chars
drop:     every assistant message, function_call, and function_call_output
```

`assistant`/`function_call`/`function_call_output` items are all absorbed
into the summary and don't survive individually in the compacted history.
This is a deliberate simplification: rather than picking which tool calls
are worth keeping verbatim, letting the model fold them into summary text
fits this project's teaching size better, and it avoids the more complex
trimming logic that "partially keep tool call history" would require.

Recent user messages are kept for a specific reason: **the user's original
intent shouldn't be re-told through a summary before reaching the model**.
The summary is the compaction layer's retelling of history; the raw user
message is input the compaction layer shouldn't rewrite. This budgeting
logic is nearly identical to chapter 20's "keep recent user messages" during
resume — the same judgment is reused.

### Why the function_call/function_call_output pairing barely needs worry

Chapter 20's resume needed a dedicated
`normalizeAgentResponseItemHistory` to handle "a call with no output"
orphans. Compaction doesn't need one — because the compaction rule is "keep
the whole thing (summary + user messages) or drop the whole thing (every
function_call/function_call_output)," there's no "keep half" case. A test
([`tests/agent-compaction.test.ts`](../../tests/agent-compaction.test.ts)'s
"never leaves an orphan function_call behind") asserts directly that no
`function_call` survives compaction.

### The summary request reuses the same model gateway

`buildCompactionSummaryRequest` builds a request with no tools
(`tools: [], toolChoice: 'none'`), with a system instruction asking the
model to write a summary that preserves the user's goal, key decisions,
files touched, completed/remaining work, and errors encountered — without a
preamble like "here is a summary."

The call goes through `modelGateway.createResponse(...)` — the non-streaming
method — because a compaction summary doesn't need to push deltas to the
user like a normal round does; it just needs the final text in one shot.
This method has always existed on the `AgentModelGateway` interface
(`lib/model-gateway.ts`), but this chapter is the first time it's actually
used.

### Which boundary compaction happens at

In `runSamplingLoop`, the compaction check sits **after a round has fully
completed, before the next round begins**:

```text
round N completes
  -> commits the working message + function_call
  -> executes tools
  -> commits function_call_output
  -> [compaction check happens here]
round N+1 begins
```

This is the only safe position. Compaction never fires mid-round — never
while the model hasn't yet decided whether to call a tool, and never while a
tool has been called but its output hasn't been written back yet. That
guarantees compaction always sees a "fully committed" history and never
tears apart an in-flight tool_call/output pairing.

The `tokenUsage` used to trigger compaction is the usage reported by **the
round that just finished**, not a fresh measurement taken right before
compaction — so the compaction decision and the reason text explaining why
it fired (`Reported token usage {n} reached the compaction threshold
{threshold}`) always correspond exactly, and stay auditable.

### Persisted immediately, but only the new item

Compaction replaces the in-memory `history` array's contents
(`history.length = 0; history.push(...)`), but writing back to JSONL only
`appendAgentResponseItem`s the one new `compaction_summary` record — the
discarded old `assistant`/`function_call`/`function_call_output` records
were already written once when they were originally committed, so the
JSONL stays a complete append-only audit trail; only the in-memory "current
history sent to the model" gets shorter. This is exactly the same "append
only what's new" principle chapter 20 established.

## How Compaction Interacts With Resume

Compaction changes the in-memory history, while chapter 20's resume
rebuilds history from JSONL. These two mechanisms have to agree, or a
subtle failure mode appears — and it actually did: **in the first version,
resume read every response_item back verbatim**. Continue a compacted
session for another turn, and all the discarded old history came back to
life — the uncompacted transcript went to the model in full. Compaction
worked within a single run and silently failed the moment a run boundary
was crossed — exactly the scenario it was needed for most.

The fix is not a new JSONL record type. Instead, the existing
`compaction_summary` row **doubles as the replay marker**:
`replayAgentResponseItemHistory` in `lib/agent-session-store.ts` walks the
response items in write order, and at each `compaction_summary` it
re-applies `applyAgentHistoryCompaction` to the history accumulated so
far. This works because of one key property: `applyAgentHistoryCompaction`
is a **pure function** of `(history so far, summary text)` — no hidden
inputs, no dependence on runtime state — so replaying it during resume
reconstructs, item for item, the compacted history the live run held in
memory.

The JSONL file itself needs no change: it stays append-only and never
shrinks, and the discarded records remain fully on disk for audit. The
"current history sent to the model" was never the file's contents — it is
derived state, **replayed** from the file.

What makes this bug worth remembering is not the fix but the general
lesson it exposes: in any event-sourced system, **derived state must be
reproducible by replaying the record**. If the runtime applies a transform
to its state (here, compaction) and the replay path doesn't know about
that transform, the two sides diverge — silently, until some cross-run
behavior goes wrong. Persisting one marker on write and replaying the same
pure function on read is the smallest fix that makes the record and the
state converge again.

## Events And Frontend

A new internal event `history_compacted` projects to a first-class debug
event `historyCompacted` (not a mainline event — compaction doesn't need a
user decision, only observability). The Debug Console gained a
"Compactions" summary tile and a dedicated card section showing each
compaction's token count, removed/kept item counts, the trigger reason, and
an expandable "Summary sent to the model" detail.

## Permission And Data-Flow Matrix

| Scenario | tokenUsage | history length | Result |
| --- | --- | --- | --- |
| Provider didn't report usage | `null` | any | not checked |
| Below threshold | number < threshold | any | not compacted |
| History too short | any | < 4 items | not compacted (nothing worth compacting) |
| Threshold reached and history long enough | number >= threshold | >= 4 items | compacted: calls createResponse for a summary, replaces history, persists the summary, emits `history_compacted` |

## What Is Still Missing

- **The threshold is a fixed constant, not configured per model.**
  Production would need different thresholds for different models' real
  context windows; this project has nowhere to store that metadata yet.
- **No microcompact.** Claude Code's lightweight "evict stale tool_result
  blobs without calling the model" path isn't implemented — compaction here
  always needs one extra model call.
- **No retry or fallback when summary generation fails.** If
  `createResponse` throws, the whole run fails; there's no Claude Code-style
  circuit breaker that disables auto-compact after N consecutive failures.
- **Assistant messages and tool call details are unrecoverable once
  compacted.** Once compaction happens, the original tool call arguments
  and outputs only exist in the JSONL history record, not in the context
  the model sees going forward — if a later turn needs to reference a
  specific tool call's details, it can only rely on whatever the summary
  happened to mention.

## Which Tests Prove It

- [`tests/agent-compaction.test.ts`](../../tests/agent-compaction.test.ts):
  `decideAgentHistoryCompaction`'s four paths (null / below threshold /
  history too short / triggers); `serializeAgentHistoryForSummaryPrompt`
  rendering every item kind; `buildCompactionSummaryRequest` carrying no
  tools; `applyAgentHistoryCompaction` keeping system+summary+recent user
  messages, never leaving an orphan function_call, always keeping the
  newest user message even over budget, dropping older ones once the
  budget is exceeded, and working with no leading system message
- A new integration test in
  [`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts):
  once reported usage reaches the threshold, `runSamplingLoop` actually
  calls `createResponse`, the history gets replaced, the
  `history_compacted` event correctly records the token count and summary
  text, and **the next round's** `streamResponse` request receives the
  compacted message count (3, not the pre-compaction 4)
- [`tests/agent-session-store.test.ts`](../../tests/agent-session-store.test.ts)'s
  "resumeAgentSession replays compaction instead of returning the
  uncompacted transcript": resuming a compacted session reconstructs the
  replayed, compacted history rather than the full transcript
- The Debug Console visualization was verified manually by temporarily
  injecting fake state and screenshotting: the Compaction card correctly
  shows the token count, removed/kept counts, reason, and expandable
  summary

## Chapter Summary

Context compaction's core work isn't "write a general-purpose summarization
engine" — it's three boundary decisions: when to trigger (real usage data
exists and the threshold is crossed), what survives afterward (system +
summary + budgeted recent user messages, everything else absorbed into the
summary), and at which safe point to trigger (between rounds, never tearing
apart an in-flight tool call). Get those three decisions right, and the
pairing invariant and persistence correctness follow almost for free.
