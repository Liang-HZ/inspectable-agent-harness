# 02. API Contracts And Validation

This chapter explains how the project stabilizes HTTP input, runtime config, and
frontend response handling. Before the agent becomes complex, the API contract
needs to be explicit enough that later layers do not have to guess.

After reading this chapter, you should understand:

- why request bodies are parsed from `unknown` into business inputs
- why Zod belongs at the DTO boundary instead of inside services
- why validation errors include both a stable summary and field-level details
- why the frontend also parses response discriminants

## Background

Once `/api/chat` existed, the next problem was not model intelligence. It was
trusting the boundary.

HTTP request bodies are `unknown`. Environment variables are strings or
missing. Frontend `fetch` responses are also unknown. If those shapes are not
checked at the boundary, TypeScript becomes decorative instead of protective.

## What We Built

The project added clear contracts for:

- request input parsing
- validation error shape
- server model config
- frontend response parsing
- shared API types

The important files are:

```text
lib/chat-input.ts
lib/chat-api-types.ts
lib/chat-api-client.ts
lib/env.ts
app/api/chat/route.ts
```

## Zod At The DTO Boundary

The request parser uses Zod at the boundary and returns a discriminated result.
The service never sees raw request JSON.

The route flow is:

```text
request.json()
  -> parseChatInput(unknown)
  -> ChatInput
  -> callChatModel(...)
```

This became the template for the later agent input parser.

## Structured Validation Errors

The project does not collapse every validation problem into one sentence.

The API response has:

```ts
{
  ok: false,
  error: 'Request body validation failed.',
  validationErrors: {
    formErrors: string[],
    fieldErrors: { ... }
  }
}
```

This is more stable than making clients parse natural-language errors.

## Environment Config

`lib/env.ts` trims env vars and treats empty strings as missing.

This matters because `.env.local` mistakes are common. The config boundary
should fail clearly before any model call happens.

The intended variables are:

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_WIRE_API
```

`OPENAI_WIRE_API` arrived later, when the model gateway learned to choose
between Chat Completions and Responses dialects.

## Frontend Parsing

The browser client does not blindly trust `fetch(...).json()`. It parses the
response into shared API types before React uses it.

That pattern became important later when the streaming agent route introduced
many more event shapes.

## Key Tradeoff

The project accepted extra boilerplate in exchange for:

- reliable type narrowing
- predictable API error shape
- easier frontend/backend coordination
- safer future agent inputs

This is a teaching repo. Seeing the boundary is part of the point.

## Verification

This layer is verified by:

```bash
npm run typecheck
npm run build
```

and direct API probes:

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","temperature":0}'
```

## How It Prepared The Agent

The agent route later reused the same lessons:

- parse first
- service gets plain input
- explicit result discriminants
- validation errors stay structured
- framework objects stay at the route boundary

## Common Misunderstandings

### Misunderstanding 1: Validation Is Only For Avoiding API Errors

Validation also fixes boundary semantics. Agent endpoints accept more fields
over time. If the input boundary is unstable, provider, tool, and session layers
all have to defend against dirty input.

### Misunderstanding 2: One Error String Is Enough

One string is readable, but it is not enough for UI field placement or stable
tests. `validationErrors` gives clients structured detail without parsing prose.

### Misunderstanding 3: The Frontend Can Fully Trust Backend Output

The frontend still parses response discriminants. If backend code or a proxy
returns an unexpected shape, the UI should fail clearly instead of entering a
silent bad state.

## Chapter Summary

This chapter locks down the API contract: routes own HTTP, parsers own
untrusted input, env code owns configuration, services receive typed inputs, and
the frontend parses discriminated results. The agent API reuses the same rules.
