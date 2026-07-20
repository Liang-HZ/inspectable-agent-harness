# Next.js TypeScript Model API Demo

This is a minimal Next.js backend demo for calling an OpenAI-compatible Chat
Completions API and growing that call into a small inspectable agent backend.

## Setup

Create `.env.local` from the example file:

```bash
cp .env.example .env.local
```

Then fill in:

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_WIRE_API=openai-chat-completions
```

For compatible providers, keep the `/v1` suffix when their docs require it, set
`OPENAI_MODEL` to that provider's model id, and keep
`OPENAI_WIRE_API=openai-chat-completions` (most compatible providers do not
implement the OpenAI Responses API).

For a step-by-step environment walkthrough (Node, ripgrep, API key options,
first run), see tutorial chapter 00:
[`tutorial/zh/00-environment-and-first-run.md`](tutorial/zh/00-environment-and-first-run.md) /
[`tutorial/en/00-environment-and-first-run.md`](tutorial/en/00-environment-and-first-run.md).

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Call the API Route Directly

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"用一句话解释一下 TypeScript 为什么适合写后端。"}'
```

Successful responses use an explicit discriminant:

```json
{
  "ok": true,
  "result": {
    "model": "gpt-4o-mini",
    "content": "...",
    "usage": null
  }
}
```

## Run the Agent Route Directly

```bash
curl -X POST http://localhost:3000/api/agent \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "帮我设计一个下一步 agent 能力。",
    "goal": "保持实现小而清晰。",
    "context": "当前项目已经有 /api/chat。",
    "temperature": 0.4
  }'
```

The agent response includes the final answer, inspectable steps, and
normalized token usage:

```json
{
  "ok": true,
  "result": {
    "model": "gpt-4o-mini",
    "answer": "...",
    "steps": [
      {
        "order": 1,
        "title": "Read task",
        "detail": "..."
      }
    ],
    "usage": {
      "totalTokenUsage": { "inputTokens": 0, "outputTokens": 0, "...": "..." },
      "lastTokenUsage": null,
      "calls": []
    }
  }
}
```

## Stream the Agent Route Directly

```bash
curl -N -X POST http://localhost:3000/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "帮我找出当前项目里 agent 工具注册相关的文件，并解释它们的关系。",
    "goal": "请使用本地文件探索工具完成，不要只凭记忆回答。",
    "temperature": 0
  }'
```

The streaming route returns Server-Sent Events. `step` events show agent progress,
`assistantDelta` events stream assistant text, `done` carries the final result
object, and `error` carries stream-time failures.

Error responses use the same discriminant:

```json
{
  "ok": false,
  "error": "Field `message` is required."
}
```

## Backend Structure

```text
app/api/chat/route.ts              HTTP entry point
lib/chat-input.ts                  request body parsing and validation
lib/env.ts                         environment variable reading
lib/openai-compatible-client.ts    OpenAI-compatible SDK client
lib/chat.ts                        model call service
app/api/agent/route.ts             agent HTTP entry point
app/api/agent/stream/route.ts      streaming agent SSE entry point
lib/agent-input.ts                 agent request body parsing and validation
lib/agent.ts                       agent orchestration service
lib/agent-tools.ts                 tool groups and registry
lib/agent-builtins.ts              read-only file tools (read, grep, find, ls)
lib/agent-editing-builtins.ts      write/edit tools
lib/agent-shell-builtins.ts        shell tool behind a safe-command classifier
lib/agent-shell-sandbox.ts         OS sandbox plan resolver (fail-closed, macOS/Linux)
lib/agent-shell-sandbox-macos.ts   macOS Seatbelt SBPL profile builder
lib/agent-shell-sandbox-linux.ts   Linux bubblewrap argv builder
lib/agent-session-store.ts         JSONL session persistence and resume
```

This list is a teaser, not the map. The full, maintained module map lives in
[`docs/architecture.md`](docs/architecture.md).

`route.ts` should stay thin: read the HTTP request, validate input, call the service, and return
JSON. The service layer should receive plain TypeScript objects instead of `NextRequest`.

For the current project map and module responsibilities, see
[`docs/architecture.md`](docs/architecture.md).

For a chaptered walkthrough of how the current agent harness evolved, start at
the bilingual tutorial hub [`tutorial/README.md`](tutorial/README.md). The
English path lives at [`tutorial/en/README.md`](tutorial/en/README.md), and the
Chinese path lives at [`tutorial/zh/README.md`](tutorial/zh/README.md). The
tutorial explains the design path from the initial Next.js API boundary through
the streaming sampling loop, real read-only tools, provider dialects, Debug
Console, JSONL sessions, tool runtime contracts, and loop guardrails.
