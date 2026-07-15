# 00. Environment Setup And First Run

This chapter does exactly one thing: get you from `git clone` to "watching the
agent stream through a task in the UI for the first time" on your own machine.

The other 22 chapters are about design — why the boundaries are cut the way
they are, why the tradeoffs went the way they did. But for readers crossing
over from another stack, the first real wall is usually not design. It is the
environment: the wrong Node version, not knowing where to get an API key, a
base URL missing its `/v1`, `rg` not installed. Every one of these can burn an
evening, and none of them has anything to do with agents. This chapter clears
them all at once.

If you are already a fluent Node/Next.js developer, skim this in ten minutes —
the two sections worth your attention are
[the three API key paths](#api-keys-three-paths-and-what-they-cost) and
[the troubleshooting table](#troubleshooting).

After this chapter, you should have:

- Node.js, git, and ripgrep installed
- a working OpenAI-compatible API key, with a clear idea of what it costs
- a configured `.env.local`, understanding every variable in it
- one Chat call and one streaming Agent run completed in the UI
- `/api/chat` and `/api/agent/stream` called directly with curl, so you have
  seen the raw responses
- `npm test` and `npm run typecheck` passing, confirming the environment is
  complete

## Prerequisite Software

### Node.js 20 LTS or newer

The project uses Next.js 16, which requires Node.js 20.9 or later. Installing
22 LTS directly is the recommended choice.

On macOS, use nvm so switching versions later doesn't mean reinstalling:

```bash
# Install nvm (command per the official README at https://github.com/nvm-sh/nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash

# In a fresh terminal:
nvm install --lts
nvm use --lts
```

On Windows, use the official installer (pick LTS at https://nodejs.org) or
winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

nvm-windows (https://github.com/coreybutler/nvm-windows) works too, similar to
nvm on macOS.

Verify:

```bash
node -v    # should print v20.9+ or v22.x
npm -v
```

### git

macOS ships with it (the first `git` run prompts you to install the Xcode
Command Line Tools). On Windows, install Git for Windows
(https://git-scm.com) — the bundled Git Bash is also the recommended shell for
the curl commands later in this chapter.

### ripgrep (easy to miss, but required)

This is the one people forget. The agent's `grep` tool is not a hand-rolled
text search — it spawns the local `rg` binary (see `runRipgrep` in
`lib/agent-builtins.ts`). If `rg` is missing, every `grep` execution fails and
the model receives this error:

```text
Error [EXECUTION_ERROR]: ripgrep (rg) is required for grep but was not found: spawn rg ENOENT
```

Note that this is a model-visible error — it does not crash the run. The model
sees the message and tries other tools, which makes the symptom sneaky: the
agent still runs, it just gets worse at anything search-shaped. Installing rg
fixes it:

```bash
# macOS
brew install ripgrep

# Windows
winget install BurntSushi.ripgrep.MSVC

# Debian / Ubuntu
sudo apt install ripgrep
```

Verify:

```bash
rg --version
```

## Getting The Code And Installing Dependencies

```bash
git clone <the repo URL you were given>
cd <repo directory>
npm install
```

`npm install` installs roughly 190 packages per `package-lock.json` (Next.js,
React, the OpenAI SDK, Zod, plus the TypeScript toolchain) — a minute or two
on a normal connection. Mapping to the Java/Python mental model:
`package.json` is your `pom.xml`/`pyproject.toml`, `package-lock.json` is the
lockfile pinning exact versions, and `node_modules/` holds dependencies
locally inside the project directory (not globally).

## API Keys: Three Paths And What They Cost

This project calls an "OpenAI-compatible" Chat Completions API — a de facto
industry standard: OpenAI defined the wire format, and many other vendors
implement it. So you do not necessarily need an official OpenAI key; any
compatible provider works. Three paths, in recommended order:

### Path A: OpenAI directly

Register at https://platform.openai.com, add a card, create an API key. The
upside is zero compatibility questions (it is the standard itself); the
downsides are needing an international credit card, and no direct network
access from mainland China.

Cost ballpark: `gpt-4o-mini`, the tutorial default, runs on the order of a few
tenths of a dollar per million input tokens and under a dollar per million
output tokens. Working through every experiment in this tutorial typically
costs a few dollars at most. Check https://openai.com/pricing for current
numbers.

### Path B: OpenAI-compatible providers reachable from mainland China (recommended for readers there)

These vendors implement the OpenAI Chat Completions wire format, with low
signup friction, local payment options, and direct connectivity. Configuring
them only means changing three values — `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
`OPENAI_MODEL`:

| Provider | `OPENAI_BASE_URL` shape | Notes |
| --- | --- | --- |
| DeepSeek (official) | `https://api.deepseek.com/v1` | Models like `deepseek-chat`. Pricing is on the order of single-digit RMB per million tokens. |
| SiliconFlow | `https://api.siliconflow.cn/v1` | An aggregator — one key reaches Qwen, DeepSeek, and others; some small models are free. |
| Alibaba Cloud DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | The `compatible-mode` path is what makes it OpenAI-compatible — don't drop it. Models like `qwen-plus`; new accounts usually get free quota. |
| Moonshot (Kimi) | `https://api.moonshot.cn/v1` | Check the official docs for current model ids. |

Prices move constantly; the table only conveys the order of magnitude —
**always defer to each provider's website**.

Two things you must get right:

1. **The model you pick must support tool calling (function calling).** The
   defaults listed above all do, but if you swap in another model id, check
   its documentation first. Chat mode does not depend on tool calling, but the
   entire agent loop is built on the model being able to issue `tool_calls` —
   on a model without it, the agent degrades into something that can only
   talk, never act.
2. **Keep `OPENAI_WIRE_API=openai-chat-completions`.** The project supports
   two wire protocols (see the provider dialect boundary in chapter 08);
   `openai-responses` follows OpenAI's official Responses API semantics, which
   most compatible providers have not implemented. With a compatible provider,
   `openai-chat-completions` is the correct — and only — choice.

### Path C: relay/proxy resellers (be careful)

There are plenty of "API relay" sites reselling official OpenAI models at a
discount. Know the risks: your key and request contents pass through a third
party (never send anything sensitive); the advertised model may be silently
swapped for a cheaper one; prepaid balances can vanish when the site does.
This is a learning project and the request contents are harmless, but if you
use a relay, treat it as a disposable that can die at any moment — don't load
it with a large balance.

## Configuring .env.local

```bash
cp .env.example .env.local
```

`.env.local` is git-ignored, so your key never gets committed. The four
variables, one by one:

```bash
OPENAI_API_KEY=sk-your-api-key
```

Your API key. This is the only variable with no default: without it, the
server returns the error `Missing OPENAI_API_KEY in environment variables.` on
the first model call (see `lib/env.ts`).

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
```

The API base address, defaulting to OpenAI. Swap in the address from the table
above when using a compatible provider. **Mind the `/v1` suffix** — the OpenAI
SDK appends `/chat/completions` to this address, and most providers expect the
full path to be `.../v1/chat/completions`. The classic symptom of a missing
`/v1` is a 404 (it's in the troubleshooting table).

```bash
OPENAI_MODEL=gpt-4o-mini
```

The model id. With a compatible provider, use that provider's model id (such
as `deepseek-chat` or `qwen-plus`). Set it explicitly rather than relying on
the fallback in the code.

```bash
OPENAI_WIRE_API=openai-chat-completions
```

The wire protocol: `openai-chat-completions` or `openai-responses`. As above,
unless you are on OpenAI directly and specifically want to try the Responses
API, keep `openai-chat-completions`.

After editing `.env.local`, restarting `npm run dev` is the safe move — the
environment variables are read server-side.

## First Run: The UI

```bash
npm run dev
```

The terminal prints the local address. Open:

```text
http://localhost:3000
```

You will see a three-column workbench:

- **Left rail**: the brand block ("Next.js API Workbench / Agent Harness"),
  the Agent/Chat mode switcher, and a current-run card (status badge, model
  name, run id). In Agent mode the rail also holds a Sessions list — empty
  now, populated once you have run something.
- **Middle transcript column**: the conversation/result area on top, the
  composer (request form) at the bottom.
- **Right Inspector**: in Agent mode, three tabs — Debug/Audit/Session —
  showing runtime events, permission decisions, and the persisted session
  record. This panel is the main carrier of the project's inspectability
  philosophy; chapter 14 is devoted to it.

### First, one Chat call (validating your key and base URL)

The page opens in Agent mode. Click **Chat** in the left rail first — Chat is
one bare model call with no tools, the shortest possible path, which makes it
the best configuration check.

Type anything into the Message box in the lower middle and click
**Call model**. A few seconds later the reply appears in the middle and the
right Inspector shows the call's details. If this step errors, go match the
symptom in the [troubleshooting table](#troubleshooting).

### Then, one Agent run (your first stream and first tools)

Switch back to **Agent** mode. Give it a task that requires actually doing
something, for example:

```text
帮我找出当前项目里 agent 工具注册相关的文件，并解释它们的关系。
```

(Below Task there is a collapsed section with Goal, Context, model, and
policy settings — leave everything at its default for now.)

Click **Run agent**. Unlike Chat, this time you watch the process:

- the left status badge turns into a shimmering "Running", and a **Stop**
  button appears next to the composer while the run is live (you can cancel
  mid-flight)
- in the middle transcript, tool calls appear one by one as collapsed entries
  (`ls`, `grep`, `read`, …), with a "Thinking…" indicator while waiting on
  model output
- the model's final answer streams out token by token
- in the right Inspector's Debug tab, raw runtime events (modelRequested,
  toolStarted, toolFinished, …) scroll by in real time

Once it finishes, the session shows up in the left Sessions list — it has been
persisted as a JSONL file (chapter 07), viewable directly in the Inspector's
Session tab.

With that one run you have now seen everything this tutorial takes apart:
streaming (chapters 05 and 10), tools (chapter 12), events (chapter 05),
sessions (chapters 07 and 20), the inspector (chapter 14). The remaining 22
chapters explain every boundary behind that one scene.

## First Run: curl

Behind the UI are two ordinary HTTP routes. Hitting them with curl once builds
the right intuition: the frontend is just a consumer. The commands below come
from the repo root `README.md` and can be copied verbatim (Windows readers:
run them in Git Bash — cmd's quoting rules will mangle the JSON).

First `/api/chat`:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"用一句话解释一下 TypeScript 为什么适合写后端。"}'
```

Expect a JSON response with an explicit discriminant:

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

Then the streaming `/api/agent/stream` (note `-N`, which stops curl from
buffering so events print as they arrive):

```bash
curl -N -X POST http://localhost:3000/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "帮我找出当前项目里 agent 工具注册相关的文件，并解释它们的关系。",
    "goal": "请使用本地文件探索工具完成，不要只凭记忆回答。",
    "temperature": 0
  }'
```

This time it is not one JSON document but a stream of Server-Sent Events: each
event is a `data: {...}` line followed by a blank line. You will see something
like this (truncated):

```text
data: {"type":"debug","event":{"type":"runStarted","runId":"...","sessionId":"...", ...}}

data: {"type":"step","step":{...}}

data: {"type":"debug","event":{"type":"toolStarted","toolName":"grep", ...}}

data: {"type":"assistantDelta","delta":"These"}

data: {"type":"assistantDelta","delta":" files"}

data: {"type":"done","result":{...}}
```

`step` is progress, `assistantDelta` carries text increments of the final
answer, `done` carries the complete result, and failures arrive as `error`.
The SSE protocol itself is bridge 4 in the
[prerequisites appendix](appendix-prerequisites.md).

Invalid requests share one error shape:

```json
{
  "ok": false,
  "error": "Request body validation failed."
}
```

## Health Checks

Two commands confirm the environment is complete. Neither needs an API key —
the tests are deterministic and never call a real provider (chapter 11
explains how):

```bash
npm test
```

Expected final lines:

```text
ℹ tests 103
ℹ pass 103
ℹ fail 0
```

```bash
npm run typecheck
```

A full `tsc --noEmit` type check — **no output means it passed**. Both
commands are worth running after every chapter's changes from here on.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Calls fail with `Missing OPENAI_API_KEY in environment variables.` | No `.env.local`, empty key, or the dev server wasn't restarted after the edit | Confirm `cp .env.example .env.local` ran and the key is filled in; restart `npm run dev` |
| 404, or the provider returns HTML instead of JSON | `OPENAI_BASE_URL` is missing `/v1` (or has an extra path) | Check the full base URL against the table above; the SDK appends `/chat/completions` to it |
| The agent's `grep` tool keeps failing with `Error [EXECUTION_ERROR]: ripgrep (rg) is required for grep but was not found: spawn rg ENOENT` | ripgrep is not installed | `brew install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` / `sudo apt install ripgrep`, then restart the dev server |
| `npm run dev` says port 3000 is in use | Another process holds 3000 | Next.js automatically picks another port and prints the actual address — open that; or find the process with `lsof -i :3000` (macOS/Linux) |
| curl returns `Request body must be valid JSON.` | The JSON got mangled by shell quoting (typical on Windows cmd) | Use Git Bash or PowerShell; keep single quotes around the JSON, double quotes inside |
| Chat works, but the agent only talks and never calls tools | The chosen model doesn't support tool calling | Switch to a model id that explicitly supports function calling |
| 401 / Unauthorized | Wrong or expired key, or key and base URL belong to different providers | Make sure all three variables come from the same provider |

## Chapter Summary

There is no design at this layer, but it decides whether you get to start at
all. You now have: a working Node toolchain, a model you can call, a UI and
curl runs you have completed yourself, and two health-check commands that can
confirm "I didn't break anything" at any moment.

Start the real material at
[chapter 01](01-project-starting-point.md): why this project begins from a
deliberately minimal API path. Whenever the main text hits a concept gap —
TypeScript, Zod, SSE — detour to the
[prerequisites appendix](appendix-prerequisites.md) and come back.
