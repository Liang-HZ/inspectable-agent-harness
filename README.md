# Inspectable Agent Harness

**A coding-agent runtime built from a bare OpenAI-compatible API — plus a 26-chapter tutorial explaining why every boundary sits where it does.**

### 📖 Read it online → **[learn.liangai.org](https://learn.liangai.org)**

26 chapters, searchable, bilingual, dark mode. The same content also reads fine on GitHub:
[中文说明](README.zh-CN.md) · [中文教程](tutorial/zh/README.md) · [English tutorial](tutorial/en/README.md)

TypeScript · Next.js · 141 deterministic tests · no agent framework, no LangChain, no agent SDK

---

## Why this exists

Most agent tutorials stop at "call the model in a loop". The parts that actually make a coding agent hard are somewhere else:

- when an assistant message is safe to *commit* while it is still streaming
- where a cancellation boundary can sit without corrupting the transcript
- how a tool contract survives a provider's strict JSON-schema mode
- what happens to a run that pauses mid-flight for human approval — and how it resumes
- how context gets compacted without breaking tool-call / tool-result pairing
- how a shell tool is actually confined at the OS level

This project implements those one at a time, in the order a real project hits them. The tutorial is the design log: each chapter explains the problem that forced the next boundary into existence.

It is a **reference harness for reading and learning**, not a production CLI. Chapter 23 is an explicit gap map against production harnesses (Codex CLI / Claude Code): what is missing, and what closing it would take.

## What's inside

| Capability | Where | Chapter |
| --- | --- | --- |
| Streaming sampling loop, commit semantics | `lib/agent.ts`, `lib/agent-model-stages.ts` | [10](tutorial/en/10-streaming-sampling-and-commit-semantics.md) |
| Cancellation boundaries and runtime events | `lib/agent-run-context.ts`, `lib/agent-events.ts` | [05](tutorial/en/05-streaming-cancellation-and-events.md) |
| Provider dialects — OpenAI Chat Completions / Responses, Anthropic Messages | `lib/model-provider-dialect.ts`, `lib/anthropic-messages-mapping.ts` | [08](tutorial/en/08-provider-dialect-boundary.md) |
| Provider-neutral response items (the runtime spine) | `lib/agent-response-items.ts` | [09](tutorial/en/09-response-items-and-runtime-spine.md) |
| Tool runtime boundary, contracts, strict-schema adaptation | `lib/agent-tool-runtime.ts`, `lib/agent-tool-contracts.ts`, `lib/openai-tool-schema.ts` | [06](tutorial/en/06-tool-runtime-and-permission-skeleton.md) · [13](tutorial/en/13-tool-output-and-strict-openai-schema.md) · [15](tutorial/en/15-tool-contract-boundary-and-toy-removal.md) |
| Permission policy, path policy, read-before-edit | `lib/agent-permissions.ts`, `lib/agent-path-policy.ts` | [06](tutorial/en/06-tool-runtime-and-permission-skeleton.md) · [12](tutorial/en/12-real-readonly-tools.md) |
| Shell tool behind a safe-command classifier | `lib/agent-shell-builtins.ts`, `lib/agent-shell-safety.ts` | [18](tutorial/en/18-shell-tool-and-command-safety.md) |
| OS-level sandbox — macOS `sandbox-exec`, Linux `bwrap`, fail-closed | `lib/agent-shell-sandbox-macos.ts`, `lib/agent-shell-sandbox-linux.ts` | [24](tutorial/en/24-os-level-sandbox.md) |
| Trace waterfall, subagents, vendor-neutral OTLP export | `lib/agent-trace.ts`, `lib/agent-subagent.ts`, `lib/agent-otel-export.ts` | [25](tutorial/en/25-tracing-and-subagents/README.md) |
| Approval pause and resume | `lib/agent-approvals.ts` | [19](tutorial/en/19-approval-pause-and-resume.md) |
| JSONL session store, replay, resume | `lib/agent-session-store.ts` | [07](tutorial/en/07-jsonl-sessions-and-usage.md) · [20](tutorial/en/20-session-replay-and-resume.md) |
| Context compaction | `lib/agent-compaction.ts` | [21](tutorial/en/21-context-compaction.md) |
| Environment context injection, retry with backoff | `lib/agent-environment-context.ts`, `lib/model-retry.ts` | [23](tutorial/en/23-production-harness-gap-map.md) |
| Debug console and session viewer | `app/` | [14](tutorial/en/14-debug-console-and-session-viewer.md) |
| Deterministic runtime tests | `tests/` | [11](tutorial/en/11-deterministic-runtime-tests.md) |

## Quick start

```bash
git clone https://github.com/Liang-HZ/inspectable-agent-harness.git
cd inspectable-agent-harness
npm install
cp .env.example .env.local   # OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
npm run dev                  # → http://localhost:3000
```

Works with any OpenAI-compatible provider (OpenAI, DeepSeek, Qwen, …), and with Anthropic Messages through the mapping layer. Chapter [00](tutorial/en/00-environment-and-first-run.md) walks the environment end to end, including a first run over `curl`.

```bash
npm test         # 141 deterministic tests, no network
npm run typecheck
```

## The tutorial

26 chapters, Chinese and English, reconstructed from the project's real evolution — git history, the current workspace, and the trade-offs already baked into the code.

- **[中文教程](tutorial/zh/README.md)** — chapter map and reading order
- **[English tutorial](tutorial/en/README.md)**

It is not a source index. It answers a different question: *why is the code cut into these boundaries and not others.* Each chapter ends with a verification point you can run yourself.

## Architecture

- [`docs/architecture.md`](docs/architecture.md) — current module map and boundaries
- [`docs/evolution.md`](docs/evolution.md) — how they got there
- [`docs/research-codex-claude-code.md`](docs/research-codex-claude-code.md) — research notes on Codex CLI and Claude Code harness mechanics (2026-07)

## API surface

```text
POST /api/chat            single model call
POST /api/agent           agent run, returns final answer + inspectable steps + usage
POST /api/agent/stream    same run as Server-Sent Events (step / assistantDelta / done / error)
```

Responses use an explicit discriminant (`{ ok: true, result }` / `{ ok: false, error }`). Route handlers stay thin: parse, validate, call the service, return JSON.

## License

MIT — see [LICENSE](LICENSE).
