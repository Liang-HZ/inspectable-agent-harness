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
```

For compatible providers, keep the `/v1` suffix when their docs require it and set
`OPENAI_MODEL` to that provider's model id.

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

The first agent response includes the final answer plus inspectable steps:

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
    "usage": null
  }
}
```

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
lib/agent-input.ts                 agent request body parsing and validation
lib/agent.ts                       single-step agent service
```

`route.ts` should stay thin: read the HTTP request, validate input, call the service, and return
JSON. The service layer should receive plain TypeScript objects instead of `NextRequest`.

For the current project map and module responsibilities, see
[`docs/architecture.md`](docs/architecture.md).
