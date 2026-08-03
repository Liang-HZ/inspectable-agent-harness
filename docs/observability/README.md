# Observability runbook

The harness draws its own trace waterfall with no backend at all — the panel
above "Run details" fills in the moment a run produces spans, straight from the
session JSONL. Everything below is optional, and exists for the questions a
single run cannot answer: comparing runs, cost over time, prompt versions.

## The short version

```bash
npm run obs:up      # start both backends
npm run dev         # then click "Run agent"
```

The **Trace** panel is open by default and shows the call chain. Under it,
"Observability backends" reports what is running, opens each UI, sends the
current run to either one, and has the **Stop all backends** button — so
shutting the stack down never means going to look up a command.

```bash
npm run obs:down    # or just press the button in the app
```

## What each backend costs

Measured on one development machine, idle:

| | Arize Phoenix | Langfuse |
| --- | --- | --- |
| Containers | 1 | 6 |
| Images on disk | 1.08 GB | ~3.95 GB |
| Memory | ~400 MiB | ~2.4 GiB |
| UI | http://localhost:6006 | http://localhost:3100 |

Phoenix is the sensible default for day-to-day work: one container, start and
stop it at will. Langfuse earns its footprint when you want cross-run cost
dashboards, prompt versioning, or evals.

You do not have to choose permanently. The harness speaks plain OTLP to both,
so switching is one endpoint.

## Ports

Langfuse's own compose publishes its web UI on **3000**, which collides with
essentially every other Next dev server on a developer machine. The vendored
compose here publishes **3100** instead.

That collision is worth knowing about because of how it fails: requests reach
*the other* server and return its errors, while Langfuse's own logs stay
perfectly clean because it never received anything. If a backend looks broken
but its logs look healthy, check what is really listening:

```bash
lsof -nP -iTCP:3100 -sTCP:LISTEN
```

## Langfuse credentials

OTLP ingestion needs a project key pair. Langfuse can provision one headlessly
on first boot — copy `.env.example` to `.env` next to the compose file:

```bash
LANGFUSE_INIT_ORG_ID=local-org
LANGFUSE_INIT_ORG_NAME=Local
LANGFUSE_INIT_PROJECT_ID=local-project
LANGFUSE_INIT_PROJECT_NAME=agent-harness
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-1234567890
LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-1234567890
LANGFUSE_INIT_USER_EMAIL=local@example.invalid
LANGFUSE_INIT_USER_NAME=Local
LANGFUSE_INIT_USER_PASSWORD=change-me-locally
```

Then give the harness the same pair so the "Send this run" button can
authenticate:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-1234567890
LANGFUSE_SECRET_KEY=sk-lf-1234567890
```

These are local-only development credentials for a container on your own
machine. Do not reuse them for anything reachable from outside it.

Phoenix needs no credentials.

## Environment variables the app reads

All optional; the defaults match the compose file here.

| Variable | Default |
| --- | --- |
| `PHOENIX_URL` | `http://localhost:6006` |
| `PHOENIX_OTLP_ENDPOINT` | `http://localhost:6006/v1/traces` |
| `PHOENIX_CONTAINER` | `phoenix-obs` |
| `LANGFUSE_URL` | `http://localhost:3100` |
| `LANGFUSE_OTLP_ENDPOINT` | `http://localhost:3100/api/public/otel/v1/traces` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | unset |

## One protocol detail that will bite you

Phoenix's OTLP endpoint **rejects JSON** with `415 Unsupported content type`
and accepts protobuf only. Langfuse takes either. The exporter therefore sends
protobuf by default, which is the only encoding that works everywhere.

See [chapter 25](../../tutorial/en/25-tracing-and-subagents/README.md) for why
the encoder is hand-written rather than a dependency.
