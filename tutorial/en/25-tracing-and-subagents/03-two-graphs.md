← Previous: [02 · An event stream is not a trace](02-events-are-not-a-trace.md) · [Chapter index](README.md) · Next: [04 · The subagent runs in another file](04-the-subagent-problem.md)

# 03 · Two graphs, not one

Having added spans, an obvious conclusion suggests itself: **if the span tree
expresses "what contains what", do we still need to store message order
separately?**

Yes. This section explains why, and why the point deserves its own section.

## Look at how someone else stores it

Claude Code's own session files are on your machine, at
`~/.claude/projects/<project>/<sessionId>.jsonl`. Pull one record and look at
the keys:

```json
{
  "parentUuid": "d572a37b-5809-470d-b23d-00886f7c8552",
  "isSidechain": true,
  "agentId": "a50ec970333ec68c4",
  "type": "attachment",
  "uuid": "5effcb66-ffcc-459e-be69-31d8f0bddae9",
  "timestamp": "2026-07-29T02:19:52.920Z",
  "sessionId": "816fab5f-aa24-489a-9833-39c412f7025b",
  "gitBranch": "HEAD"
}
```

Note `uuid` and `parentUuid`: every record points at its predecessor, so the
file is a **tree**, not an array.

Note also what is absent: **no span fields at all** — no trace id, no duration.

## Two axes, measuring different things

| | Expresses | Without it you cannot answer |
| --- | --- | --- |
| `uuid` / `parentUuid` | **Message lineage**: what this record follows | replay after compaction, forking from a message, "which version of history was this edit based on" |
| `traceId` / `spanId` / `parentSpanId` | **Span tree**: what ran inside what, for how long | which step was slow, who called whom, where the tokens went |

Both look like "parent/child", but the parents mean different things:

- A lineage parent is **the previous record in time**. When Chapter 21's context
  compaction replaces a stretch of messages with one summary, that replacement
  is an event on the lineage graph — the span tree cannot see it at all.
- A span parent is **the logical container**. A `grep` call's parent is "this
  round of model decision-making", but in the message sequence several unrelated
  records may sit between them.

**Neither graph derives the other.** Try to express lineage with the span tree
and compaction becomes undrawable: it is not "work containing work", it is
"history was rewritten".

So keep both.

## How we do it

The harness's session records are already append-only JSONL, where order *is*
lineage (Chapter 07). What this chapter adds is the span axis:

```
data/agent-sessions/2026/07/29/
  rollout-<ts>-<id>.jsonl        # main session; order is lineage
```

Each `agent_event` payload carries span fields. Both axes live in the same file
without interfering.

## A counter-example: why not put spans in parentUuid

There is a tempting shortcut: both are trees, so point `parentUuid` at the
*logical* parent and get one tree serving two purposes.

One example kills it:

```
model_requested(round 1)  ← lineage parent: run_started
tool_started(ls)          ← lineage parent: model_completed(round 1)
                          ← logical parent: model_completed(round 1)   ✓ same
tool_started(grep)        ← lineage parent: tool_finished(ls)          ← previous record
                          ← logical parent: model_completed(round 1)   ✗ different
```

With parallel tool calls, four calls have four different lineage parents and one
shared logical parent. **One field cannot hold two meanings** — the moment it
tries, readers have to guess, and guesses are wrong.

Two fields, each honest.

## The takeaway

Storing the extra ids costs a few dozen bytes per record.

Not storing them costs a class of question you can never answer — and you find
out at the moment you finally need to, when the historical data does not have it.

The next section is the real test: when a stretch of work runs in **a different
file**, do these two graphs still connect?

---

← Previous: [02 · An event stream is not a trace](02-events-are-not-a-trace.md) · [Chapter index](README.md) · Next: [04 · The subagent runs in another file](04-the-subagent-problem.md)
