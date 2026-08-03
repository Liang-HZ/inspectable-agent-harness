← Previous: [04 · The subagent runs in another file](04-the-subagent-problem.md) · [Chapter index](README.md) · Next: [06 · What this chapter cost](06-what-it-cost.md)

# 05 · An exit that binds no vendor

The harness can draw its own waterfall now. So what is an external backend for?

Because the built-in view only covers **one** run. Comparing across runs, "which
tool failed most this month", "did p95 move after the model change" — those need
a real observability backend. And that class of thing is a wheel that has already
been built well.

Which leaves one question: **which one, and what does connecting to it bind you
to.**

## Ruling one out first

LangSmith is often the default suggestion. Its SDK is open source; the backend,
UI, and storage are not. Self-hosting is Enterprise-only and requires a license
key.

For an individual developer that settles it: **it is not a question of heavy
versus light — it cannot be self-hosted at all.**

Among open-source, self-hostable options, two are representative:

- **Langfuse** — the fullest feature set (traces, evals, prompt management,
  cost), but self-hosting means six services: web, worker, Postgres, ClickHouse,
  Redis, MinIO. The docs suggest 4 cores / 16 GB for production.
- **Arize Phoenix** — Apache-2.0, one container, roughly 400 MiB and ready in
  about twelve seconds locally.

## The layer that matters: bind the convention, not the backend

Those two share something decisive: **both ingest OTLP natively.**

That determines the whole integration. What you hard-code into the harness is
not "the Langfuse SDK" or "the Phoenix SDK", but:

1. **OpenTelemetry's id shapes** — done back in Section 02, before the reason
   was given.
2. **GenAI semantic conventions** — what the attributes are called.

Bind those, and the backend is pluggable:

```ts
export type OtlpExportTarget = {
  endpoint: string;                      // switching backends = this line
  headers?: Record<string, string>;      // Langfuse Cloud basic auth goes here
  serviceName?: string;
  encoding?: OtlpEncoding;
};
```

Do it the other way — `import { Langfuse } from 'langfuse'` in the sampling loop
— and switching backends means editing the loop, and the README can no longer
say "no agent framework, no LangChain, no agent SDK".

**Emit both attribute vocabularies:**

```ts
function llmAttributes(model: string): OtlpAttributeInput[] {
  return [
    stringAttribute('gen_ai.system', 'openai'),
    stringAttribute('gen_ai.operation.name', 'chat'),
    stringAttribute('gen_ai.request.model', model),
    stringAttribute('openinference.span.kind', 'LLM'),
    stringAttribute('llm.model_name', model),
  ];
}
```

`gen_ai.*` is OTel's GenAI convention, which Langfuse reads; `openinference.*` /
`llm.*` is OpenInference, which Phoenix renders natively. They do not collide,
a few extra attributes cost nothing, and the same run looks right on either.

## The exporter is a reader, not a second writer

This is the load-bearing decision of the whole design:

```ts
export function buildSpansForSession(sessionPath: string): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  buildSpansFromRecords(readAgentSessionRecords(sessionPath), spans);

  for (const child of listSubagentSessionSummaries(sessionPath)) {
    buildSpansFromRecords(readAgentSessionRecords(child.path), spans);
  }

  return spans;
}
```

The exporter **reads** session files and POSTs. It does not participate in the
run, sits off the hot path, holds no state.

Three properties follow:

- Export can be **re-run**. Backend was down? Export again tomorrow.
- Export can be **re-pointed**. Phoenix today, Langfuse Cloud tomorrow, same
  history.
- Turning export off **loses nothing**, because no data was ever only in flight
  to a vendor.

Do it as "emit to the backend live from the runtime" and all three disappear —
plus a backend timeout now slows the agent down.

## What testing it actually found: JSON is not enough

The JSON version, pointed at Phoenix:

```
{"ok":false,"spanCount":8,"status":415,"error":"Unsupported content type: application/json"}
```

`415`. Confirmed directly:

```
JSON to /v1/traces          → 415
protobuf content-type       → 200
```

**Phoenix's OTLP HTTP endpoint accepts protobuf only.** Langfuse accepts both.

This is only discoverable by actually running it — "supports OTLP/HTTP" reads
identically in both sets of docs.

So: drop Phoenix, or learn to speak protobuf. The latter, because only a small
subset of the OTLP trace schema is in use here and a hand-written encoder is
about 190 lines:

```ts
function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}
```

That is most of protobuf's wire format: a field is a varint tag of
`(fieldNumber << 3) | wireType` followed by a value, and only four wire types
appear.

**Why not install a protobuf library**:
`@opentelemetry/exporter-trace-otlp-proto` brings a dependency tree and a global
tracer-provider singleton into a repository whose entire claim is that you can
read it. 190 readable lines beat an unreadable tree.

Two spots in the encoder are easy to get wrong; both are commented:

```ts
// trace_id and span_id are raw bytes on the wire, not the hex text used in the
// JSON encoding — a frequent source of silently-dropped spans.
encodeBytesField(1, Buffer.from(span.traceId, 'hex')),
```

```ts
/** Timestamps are `fixed64` in the OTLP schema, not varint. */
function encodeFixed64Field(fieldNumber: number, value: bigint): Buffer {
```

Get either wrong and the backend either errors or silently drops spans — both
hard to diagnose.

## What acceptance looks like

Export a run with a subagent into Phoenix, then ask it for the spans:

```
agent run          CHAIN     parent=None
├─ chat gpt-4o-mini  LLM     parent=agent run
├─ read              TOOL    parent=agent run
├─ chat gpt-4o-mini  LLM     parent=agent run
└─ task              TOOL    parent=agent run
   └─ subagent       AGENT   parent=task        ← from a different file
      ├─ chat        LLM     parent=subagent
      └─ grep        TOOL    parent=subagent
```

The subagent lives in `subagents/agent-<id>.jsonl` and never shared a file with
the main session, yet it lands under `task`.

The only thing holding that together is the trace id inherited by
`createChildSpanContext`.

---

← Previous: [04 · The subagent runs in another file](04-the-subagent-problem.md) · [Chapter index](README.md) · Next: [06 · What this chapter cost](06-what-it-cost.md)
