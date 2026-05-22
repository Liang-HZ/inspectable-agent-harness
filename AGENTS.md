# AGENTS.md

## Project Intent

This project is a small Next.js + TypeScript backend learning project. The first goal is to build a clean OpenAI-compatible model API call, then grow it into an agent backend.

Keep the code easy to read for someone coming from Java/Spring Boot. Prefer explicit structure, narrow files, and plain TypeScript objects.

## Next.js Backend Style

Use Next.js App Router route handlers for backend APIs.

Map HTTP routes through file paths:

```text
app/api/chat/route.ts  ->  /api/chat
```

Keep `route.ts` as the HTTP entry point. It should:

- read the HTTP request
- parse JSON
- validate input
- call a service function
- return `NextResponse.json(...)`

Keep business logic outside `route.ts`. Service code should receive plain TypeScript objects after the route handler converts framework requests into business input.

Use this shape as the default:

```ts
export async function POST(request: NextRequest) {
  const body = await request.json();
  const input = parseInput(body);
  const result = await runService(input);

  return NextResponse.json(result);
}
```

## Current Layering

Use this structure as the default pattern:

```text
app/api/chat/route.ts              HTTP entry point
lib/chat-input.ts                  request body parsing and validation
lib/env.ts                         environment variable reading
lib/openai-compatible-client.ts    SDK client creation
lib/chat.ts                        model call service
```

Use `docs/architecture.md` as the living project map. Update it in the same
change when routes, module responsibilities, shared API contracts, or agent/tool
boundaries change.

Think of the mapping like this:

```text
Controller  -> app/api/.../route.ts
DTO/校验     -> lib/*-input.ts
Config      -> lib/env.ts
Client      -> lib/*-client.ts
Service     -> lib/*.ts
```

When adding an agent endpoint, follow the same shape:

```text
app/api/agent/route.ts
lib/agent-input.ts
lib/agent.ts
lib/openai-compatible-client.ts
lib/env.ts
```

## Request And Response

Use `NextRequest` and `NextResponse` from `next/server` in route handlers when Next-specific helpers are useful.

Use `NextRequest` for:

- `request.json()`
- `request.nextUrl.searchParams`
- `request.cookies`
- `request.headers`

Use `NextResponse.json(...)` for JSON responses and status codes:

```ts
return NextResponse.json(
  { error: 'Field `message` is required.' },
  { status: 400 },
);
```

Use explicit response discriminants for API results:

```ts
return NextResponse.json({ ok: true, result: result });
return NextResponse.json(
  { ok: false, error: 'Field `message` is required.' },
  { status: 400 },
);
```

Keep `NextRequest` inside route handlers. Convert it into plain input objects before calling service code.

## TypeScript Boolean Style

Use logical `!` freely for real boolean values.

Good:

```ts
if (!parsedInput.ok) {
  return NextResponse.json({ error: parsedInput.error }, { status: 400 });
}
```

Use explicit checks for strings, numbers, arrays, and nullable values.

Strings:

```ts
const apiKey = process.env.OPENAI_API_KEY?.trim();

if (apiKey === undefined || apiKey === '') {
  return {
    ok: false,
    error: 'Missing OPENAI_API_KEY in environment variables.',
  };
}
```

Numbers:

```ts
if (temperature === undefined) {
  // use default
}
```

Arrays:

```ts
if (items.length === 0) {
  // empty list
}
```

Type guards and boolean-returning functions are good places for `!`:

```ts
!Array.isArray(value);
!Number.isFinite(parsed);
```

## Type Narrowing And Results

Prefer discriminated result objects for parsing, validation, and config loading.

Use this shape:

```ts
type Result<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };
```

This lets TypeScript narrow safely:

```ts
const result = parseInput(body);

if (!result.ok) {
  return NextResponse.json({ error: result.error }, { status: 400 });
}

runService(result.value);
```

Use `unknown` for untrusted request bodies, then validate into a real input type.

Prefer parsed business input objects with a stable shape. Represent optional user input as explicit `undefined` values after parsing:

```ts
type ChatInput = {
  message: string;
  model: string | undefined;
  temperature: number | undefined;
};
```

Prefer explicit object property assignment in parsing, service, and response objects. When the field name and variable name are the same, write both sides while the project is in this learning-oriented phase:

```ts
return {
  ok: true,
  input: {
    message: message,
    model: model,
    temperature: temperature,
  },
};
```

## Zod Validation Boundaries

Use Zod for request body schemas once an API input has multiple fields, optional coercion, reusable validation rules, or field-level error messages.

Keep Zod at the DTO/parsing boundary, such as `lib/chat-input.ts`. Route handlers should call `parseXxxInput(body)`, and service code should receive already-validated plain TypeScript objects.

Use current Zod 4 style:

```ts
import * as z from 'zod';

const chatRequestBodySchema = z.strictObject(
  {
    message: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? 'Field `message` is required.'
            : 'Field `message` must be a string.',
      })
      .trim()
      .min(1, { error: 'Field `message` is required.' }),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'Request body contains unknown fields.'
        : 'Request body must be a JSON object.',
  },
);
```

Put field-specific validation messages next to the schema rule that raises them. This keeps the runtime validation, TypeScript inference, and API error wording in one place.

Use `z.preprocess(...)` for input normalization that happens before validation, such as treating `null`, `''`, or whitespace-only optional fields as `undefined`, or trimming strings before a minimum-length check.

Use `z.coerce.number(...)` only when the API intentionally accepts numeric strings such as `"0.7"` from clients. Keep the allowed range in the schema with `.min(...)` and `.max(...)`.

Use type predicates only for shapes they fully prove. A helper that checks only `typeof value === 'object' && value !== null && !Array.isArray(value)` should return a broad type like `Record<string, unknown>`, not a business DTO type.

## Validation Error Shape

For flat request bodies, return both a stable human summary and structured field errors.

Use the top-level `error` string as a stable summary, such as `Request body validation failed.`. Keep field-specific messages out of the summary string so clients, tests, and UI code do not need to parse natural language.

Use `z.flattenError(error)` for single-level objects:

```ts
type ChatInputValidationErrors = {
  formErrors: string[];
  fieldErrors: {
    message?: string[];
    model?: string[];
    temperature?: string[];
  };
};
```

Use `formErrors` for request-body-level problems, such as a non-object body or unknown fields. Use `fieldErrors` for specific input fields.

Keep detailed validation messages inside `validationErrors`, using the messages defined on the Zod schema rules.

Keep the route response shape explicit:

```ts
return NextResponse.json(
  {
    ok: false,
    error: parsedInput.error,
    validationErrors: parsedInput.validationErrors,
  },
  { status: 400 },
);
```

Use `z.treeifyError(error)` when the request body becomes nested. Use `z.prettifyError(error)` for logs, CLI output, or developer-facing text dumps rather than API response contracts.

## Environment Variables

Read server-only environment variables from `process.env` in server code.

Use `.env.example` as the committed template and `.env.local` for local secrets.

Expected variables:

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
```

Trim secret strings when reading them:

```ts
const apiKey = process.env.OPENAI_API_KEY?.trim();
```

Use defaults only when a missing value has an obvious safe default:

```ts
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
```

Return clear configuration errors for required secrets.

## Dependencies

Use `package.json` as the human-readable dependency and script source of truth.

Use `dependencies` for packages needed by the running app:

```text
next
react
react-dom
openai
```

Use `devDependencies` for development and type tooling:

```text
typescript
@types/node
@types/react
@types/react-dom
prettier
```

Treat `package-lock.json` as the machine-generated exact dependency lock. Keep it updated through npm commands.

Treat `node_modules/`, `.next/`, and `tsconfig.tsbuildinfo` as generated local artifacts.

## Type Packages

Use `@types/*` packages as TypeScript declaration packages for JavaScript/runtime APIs that need external type descriptions.

Examples:

```text
@types/node       gives TypeScript the Node.js types, such as process.env
@types/react      gives TypeScript React and JSX types
@types/react-dom  gives TypeScript React DOM types
```

Remember that `@types/*` packages help TypeScript and the IDE by describing runtime objects that are provided elsewhere.

## OpenAI-Compatible Calls

Use the official `openai` SDK for OpenAI-compatible Chat Completions calls.

Keep `baseURL` configurable:

```ts
new OpenAI({
  apiKey,
  baseURL,
});
```

Use Chat Completions for broad OpenAI-compatible provider support:

```ts
client.chat.completions.create(...)
```

Keep the model id configurable through request input or `OPENAI_MODEL`.

## Validation

After code changes, run:

```bash
npm run typecheck
npm run build
```

For API changes, verify representative HTTP paths with `curl`.

Examples:

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

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","temperature":3}'
```

## Code Taste

Prefer explicit code over clever code.

Prefer small files with one job.

Prefer readable names like `parseChatInput`, `readModelConfig`, and `callChatModel`.

Prefer plain TypeScript objects at module boundaries.

Prefer clear runtime errors for missing configuration.

Prefer keeping framework-specific types at the framework boundary.
