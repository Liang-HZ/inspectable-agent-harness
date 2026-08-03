← [Chapter index](README.md) · Next: [02 · An event stream is not a trace](02-events-are-not-a-trace.md)

# 01 · The question you cannot answer

No design yet. Run the agent once, then ask it an ordinary question.

## An ordinary run

Give it a task and let it finish:

```
Find which module under lib/ is the largest, then check whether it has tests
```

It does this: think → call `ls` → think → call `grep` → think → call `read` →
answer.

Forty seconds total.

## Now ask one question

**Where did those forty seconds go?**

What do you have? Open the JSONL under `data/agent-sessions/` — a few hundred
lines, one record each:

```jsonl
{"timestamp":"...","type":"agent_event","payload":{"type":"model_requested",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"model_completed",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"tool_started","toolName":"ls",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"tool_finished","toolName":"ls",...}}
```

The data is all there. Every record has a `timestamp`.

So work it out:

1. Find the first `model_requested`, note the time.
2. Find the matching `model_completed` — **which one is "matching"?** They share
   no id. You are inferring it from "they are adjacent in the file" plus the
   `round` field.
3. Subtract to get the first round's duration.
4. Repeat for three tool calls. Those are easier — `toolCallId` pairs them.
5. Write the six numbers down and sort them.

You now have the answer. **You also just used your brain as a query engine.**

## This is not a data problem

Notice that at no point were you blocked by something not being logged. The data
is complete.

You were blocked by two things:

- **Nothing pairs up.** `model_requested` and `model_completed` are separate
  records with no shared identifier. They are associated implicitly by adjacency
  — and adjacency breaks the moment tools run concurrently (the parallel
  execution added in Chapter 05 emits four `tool_started` in a row, then four
  `tool_finished` back in whatever order they finish).
- **Containment is invisible.** That `ls` call happened *underneath* a round of
  model decision-making. Nothing in the file says so. You reconstruct it from
  knowing what the agent loop looks like.

## Put differently

What you have is a list of **things that happened**.

What you want is a picture of **what contained what, and how long each took**.

Getting from one to the other does not need more data. It needs two very small
things: **each piece of work having an identity, and knowing whose it is.**

The next section shows why fifteen event types still do not add up to a trace.

---

← [Chapter index](README.md) · Next: [02 · An event stream is not a trace](02-events-are-not-a-trace.md)
