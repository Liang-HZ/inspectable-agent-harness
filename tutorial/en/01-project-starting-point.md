# 01. Project Starting Point And Constraints

This chapter starts from the smallest runnable shape of the project. The goal
was not to build a full agent immediately, but to establish a readable,
testable, extensible Next.js backend boundary first.

After reading this chapter, you should understand:

- why the project starts with a normal model API instead of an agent loop
- why the code is split into route, input, env, client, and service layers
- why this repo intentionally favors explicit, plain TypeScript shapes

## Starting Goal

The first step was small:

```text
Build a Next.js + TypeScript backend.
Expose a model API that can call an OpenAI-compatible endpoint.
Read model, baseURL, and apiKey from config.
Keep the code clear enough to extend into an agent later.
```

This simple goal shaped the rest of the architecture: make boundaries clear
first, then add capability.

"OpenAI-compatible" does not mean the project only supports OpenAI's hosted
service. It means the first implementation uses the OpenAI SDK and Chat
Completions request shape, while allowing compatible backends through
`OPENAI_BASE_URL`.

## Core Files

The first stable backend shape used a few small files:

```text
app/api/chat/route.ts
lib/chat-input.ts
lib/env.ts
lib/openai-compatible-client.ts
lib/chat.ts
```

Together, they form a plain server-side flow:

```text
HTTP request
  -> route handler
  -> request body validation
  -> environment config
  -> OpenAI-compatible client
  -> model call service
  -> JSON response
```

The flow later became more capable, but the boundary discipline stayed the
same. `/api/agent`, streaming routes, provider adapters, and tool runtime
boundaries all grew from this structure.

## Layering Rule

The project uses a familiar backend responsibility split:

```text
Controller       -> app/api/.../route.ts
DTO / parsing    -> lib/*-input.ts
Config           -> lib/env.ts
Client           -> lib/*-client.ts
Service          -> lib/*.ts
```

The point is not ceremony. The point is to prevent future agent logic from
collapsing into one large file.

### Route Handlers Own The HTTP Boundary

`route.ts` is responsible for:

- reading `NextRequest`
- parsing JSON
- calling the input parser
- calling the service
- returning `NextResponse.json(...)`

It is not responsible for:

- composing prompts
- creating model clients
- executing tools
- parsing provider streams
- writing session files

This keeps framework types out of the business layer. Service code receives
plain TypeScript objects.

### Input Parsers Own Untrusted Input

The body of an HTTP request starts as `unknown`. It must be converted into a
known business input before service code can use it.

The project moved toward this result shape early:

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

This is more explicit than throwing directly, but the boundary is clear: input
either becomes a usable object or a precise error response.

### Config Owns Environment Variables

`lib/env.ts` reads server-only environment variables:

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
```

It handles trimming, defaults, and missing configuration errors. Service code
does not read `process.env` directly, which makes later tests and provider
switching easier.

## Code Style

During this learning-oriented phase, the repo prefers explicit object fields:

```ts
return {
  ok: true,
  result: result,
};
```

This is longer than shorthand:

```ts
return { ok: true, result };
```

But the explicit version is easier to read in a tutorial and easier to review.
The response shape is visible without relying on variable-name inference.

The same taste later influenced the agent runtime:

- events use explicit `type`
- response items use explicit discriminants
- tool results separate internal metadata from model-visible text
- provider dialects convert external formats into stable internal formats

## Git Evidence

The first commit in the repo is:

```text
75be406 Add Next.js model and agent backend
```

It added the Next.js app layout, `/api/chat`, the OpenAI-compatible client, env
handling, README, and the first agent files.

That means the project did not begin as a pure chat demo. It began as a backend
learning project that was expected to grow into an agent harness.

## Common Misunderstandings

### Misunderstanding 1: This Chapter Is Just A Normal API Tutorial

The first chapter does contain only a normal API, but it establishes the
load-bearing structure for the agent. Tool execution, streaming output, session
records, and debug pages all rely on the same boundary discipline.

### Misunderstanding 2: Explicit Code Is Only A Style Preference

Explicit code is about inspectability, not aesthetics. Agent runtimes contain
many intermediate objects. If those shapes are unclear, debugging becomes hard
quickly.

### Misunderstanding 3: Provider Abstraction Should Exist Immediately

The project does not start with a provider dialect layer. The first stage only
needs to prove that the HTTP boundary, config loading, OpenAI-compatible call,
and response shape are clean. The provider boundary becomes useful once Chat
Completions and Responses differences become real.

## Chapter Summary

This chapter establishes the foundation:

- route handlers stay thin
- input validation stays at the boundary
- env loading is centralized
- SDK client creation is isolated
- services receive plain objects
- response shapes are explicit

Every later agent capability grows along this line instead of replacing it.

## Chapter Checkpoint

Verify the three foundations: clean type boundaries, a green test suite, and a
first commit that matches this chapter. None of these commands needs an API key.

1. Type check; no output after the script banner means it passed:

```bash
npm run typecheck
```

2. Full test suite; measured tail output (truncated):

```bash
npm test
```

```text
ℹ tests 103
ℹ pass 103
ℹ fail 0
```

3. Confirm the repository's first commit:

```bash
git log --reverse --oneline | head -1
```

Measured output: `75be406 Add Next.js model and agent backend`, matching the
Git evidence above.
