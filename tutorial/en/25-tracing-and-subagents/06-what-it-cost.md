← Previous: [05 · An exit that binds no vendor](05-export-without-a-vendor.md) · [Chapter index](README.md)

# 06 · What this chapter cost

## The dependency budget

**New runtime dependencies: zero.**

`package.json` is untouched. The only external capabilities used are already in
Node:

- `crypto.randomBytes` — id generation
- `fetch` — sending OTLP

The OTLP protobuf encoding is hand-written (190 lines). It is the one place in
this chapter where a library was an option; the reasoning is in Section 05.

**New code** (excluding the tutorial):

| File | Does what |
| --- | --- |
| `lib/agent-trace.ts` | span identity: ids, child derivation, timing |
| `lib/agent-trace-tree.ts` | event stream → span tree (pure, testable) |
| `lib/agent-subagent.ts` | the `task` tool and the spawner types |
| `lib/agent-otel-export.ts` | session files → OTLP spans |
| `lib/agent-otlp-protobuf.ts` | OTLP protobuf encoding |
| `components/agent-trace-waterfall.tsx` | the waterfall |

**27 new tests**, none of which need an API key.

## Backend comparison: the measured parts

| | Arize Phoenix | Langfuse |
| --- | --- | --- |
| Licence | Apache-2.0 | open-source core (some enterprise features separate) |
| Self-host shape | **1 container** | **6 containers**: web, worker, Postgres, ClickHouse, Redis, MinIO |
| Image size | **1.08 GB** | **~3.95 GB** (web 1.29G + worker 1.09G + ClickHouse 802M + Postgres 476M + MinIO 160M + Redis 136M) |
| Idle memory | **~400 MiB** | **~2.4 GiB** (measured across all six) |
| Vendor's recommendation | — | 4 cores / 16 GB / 100 GB disk (production) |
| OTLP/JSON | **rejected (415)** | accepted |
| OTLP/protobuf | **accepted (measured 200)** | **accepted (measured 200)** |
| End-to-end ingestion | **8/8 spans stored, parentage correct** | **8/8 spans stored, parentage correct** |
| Feature surface | traces, evals, datasets | traces, evals, prompt management, cost |

Every bolded figure was measured on the same development machine. "Six
containers" is a count from Langfuse's own official `docker-compose.yml`, not
hearsay.

Sent into Langfuse, the same export had its LLM spans recognised as Langfuse's
native `GENERATION` type, with the subagent still nested under `task` — exactly
what emitting both attribute vocabularies (Section 05) was for.

## A debugging story: the 500 that lied

This one is worth writing down, because it was thoroughly misleading.

With all six Langfuse containers up, `curl localhost:3000` returned 500 for
**every** path, including the landing page. The container logs were suspiciously
clean: migrations applied, Next ready, init scripts run, **not one error line**.

The obvious theory was "the init script failed", so the seeding environment
variables came back out and the container was recreated — **still 500**.

The truth: another project's dev server was running on the host's port 3000. On
macOS `localhost` resolves to IPv6 first, and that process was listening on IPv6
`*:3000` — so every request went somewhere else entirely. Langfuse was fine the
whole time. It had simply **never received a request**, which is exactly why its
logs looked so clean.

The cheap step that broke it open: **make the same request from inside the
container.**

```
inside container, fetch localhost:3000  → failed
from the host,   curl localhost:3000    → 500
```

Those two cannot both be true of one server. If nothing is listening inside,
the host should get a connection refusal, not a rendered 500 page. The moment
the contradiction appeared, the problem was no longer inside the container.

The lesson is not "watch out for port conflicts". It is: **when a component's
logs contradict its observable behaviour, first suspect you are not talking to
it at all.**

**How to read the table**: if you want to see one run's chain clearly, Phoenix
wins on cost — one container, start and stop it at will, nothing resident when
you are not using it. If you want cross-run cost dashboards, prompt versioning,
and collaboration, that is Langfuse's territory, at the price of six resident
containers.

And per Section 05, this choice **stays reversible**: change one endpoint.

## Traps, ordered by how much they are worth remembering

**1. When a test goes red, do not start by editing the test.**

Adding span fields to the projection turned four existing tests red. The real
cause was that the change also added `span: undefined` to **old** events,
altering the contract. After switching to spreading only present fields, those
four tests went green **with no edits** — which is the actual proof that nothing
was broken. Editing the expectations would have thrown that proof away.

**2. When you add a new kind of file, ask who is scanning that directory.**

Dropping subagent JSONL into the tree broke the session list endpoint. See
Section 04.

**3. Container spans have no closing event.**

`run_succeeded` is projected to `{type:'done'}` — the result channel, **not the
debug event stream**. So the run level of the span tree never receives its own
end. Left alone, every *successful* run renders as unfinished in the waterfall,
which is precisely the signal that should only appear when something went wrong.

The fix derives a container's end from its children:

```ts
if (
  node.endedAtMs === undefined &&
  node.children.length > 0 &&
  !anyChildOpen &&
  latestEnd !== undefined
) {
  node.endedAtMs = latestEnd;
}
```

With one precondition: **a measured end wins.** `task` has its own measured
duration, so it is closed even if something beneath it looks unterminated. Only
spans with no end of their own are inferred.

This bug was found by **looking at the rendered HTML**, not by a test — every
test was green at the time. Worth remembering: unit tests cover the cases you
thought of; rendering the thing and looking at it catches the ones you did not.

**4. "Carries no span field" and "skip this event" are not the same thing.**

The exporter resolves a span with `'span' in event ? event.span : undefined` and
`continue`s when there is none. That skip is right for old sessions, which
genuinely have no spans. But `run_succeeded`, `run_failed` and `run_cancelled`
**also carry no span field** — they describe the run, not a new unit of work. So
all three were skipped, and the code that closes the root span was **never
reached**.

The consequence was not one missing record. **Every run's root span** fell
through to the leftover sweep and came out tagged `agent.span_unterminated` with
`STATUS_ERROR` — so **successful runs showed up red in the backend too**.

What makes this one deceptive is that it looks like "the cancellation caused an
error". It has nothing to do with cancellation; successful runs were equally
affected. The fix is to remember the root span at `run_started` and resolve the
terminal events against it:

```ts
const isRunTerminalEvent =
  event.type === 'run_succeeded' ||
  event.type === 'run_failed' ||
  event.type === 'run_cancelled';
const span = isRunTerminalEvent ? runSpan : eventSpanContext(event);
```

One semantic distinction is worth defending while you are in there:
`run_cancelled` should close the span and record why, and must **not** be tagged
`span_unterminated`. "Stopped on purpose" and "never came back" are different
facts, and telling them apart is the whole reason a trace exists.

**5. In a git worktree, `.git` is a file, not a directory.**

Unrelated to this chapter, but you will hit it if you also work
one-worktree-per-change: Chapter 24's sandbox test asserts that writing to
`.git/xxx` is refused with `Operation not permitted`, but in a worktree `.git`
is a text file, so the shell fails first with `Not a directory`. The write is
still blocked — only the message differs.

## What is still missing

**Parallel subagents.** `task` is `executionMode: 'sequential'`. The batch
scheduler only parallelises when every call in the batch is parallel, and
parallel subagents need the approval queue to become per-run first — otherwise
one child waiting on an approval prompt blocks its siblings.

**The compaction model call has no span.** Chapter 21's compaction really does
call the model — tokens and time — but only emits `history_compacted`, with no
model span. So there is a gap in the waterfall.

**Export is triggered manually.** There is no "export on run completion". It is
not hard to add (call it after `run_succeeded`), but retry and backpressure need
thinking through first, or a wedged backend slows the run down — defeating
Section 05's "the exporter is off the hot path".

**No cross-run aggregation.** Deliberately left to the external backend; see the
top of Section 05.

## Looking back at Chapter 23

The gap map's `Subagent` row moves from *none* to *present, depth limit 2,
sequential*.

But the more useful observation is the pattern this chapter exposes: **"it is
recorded" and "you can answer the question" are different things.** Chapter 04
added logging and Chapter 07 added JSONL — both are the former. It is easy to
finish those and believe observability is handled.

What made it usable was adding two very small fields: identity, and parentage.

---

← Previous: [05 · An exit that binds no vendor](05-export-without-a-vendor.md) · [Chapter index](README.md)
