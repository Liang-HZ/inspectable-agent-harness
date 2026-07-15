# Appendix: Prerequisite Bridges

This appendix is written for readers crossing over from a Java/Python
background. The main text assumes you can program, but not that you know
TypeScript, Node, Next.js, or LLM APIs — and in that gap sit six specific
concepts, each capable of stalling you in particular chapters.

Don't read this appendix cover to cover before starting. The better way: read
the main text, and when you hit a wall, jump back here via the table below,
patch that one bridge, and continue. Every bridge lists which chapters depend
on it.

| Bridge | Topic | Used In |
| --- | --- | --- |
| [1](#bridge-1-discriminated-unions-and-narrowing) | Discriminated unions and narrowing | The whole book; concentrated in 02, 09, 10, 13, 19 |
| [2](#bridge-2-zod-and-boundary-validation) | Zod and boundary validation | 02, 06, 13 |
| [3](#bridge-3-nextjs-app-router-files-are-routes) | Next.js App Router: files are routes | 01, 02, 19 |
| [4](#bridge-4-sse-streaming-responses) | SSE: streaming responses | 05, 10, 14 |
| [5](#bridge-5-the-openai-tool-calling-protocol) | The OpenAI tool-calling protocol | 09, 10, 13 |
| [6](#bridge-6-promiseasync-ordering-and-the-event-loop) | Promise/async ordering and the event loop | 19; indirectly 05, 10 |

## Bridge 1: Discriminated Unions And Narrowing

**Used in**: this is the book's central narrative device. `AgentResponseItem`
(chapter 09), `AgentToolOutput` (chapter 13), `AgentEvent` (chapter 05), and
`AgentStreamEvent` (chapter 19) are all unions. So is the
`ok: true / ok: false` return-value pattern from chapter 02.

### The concept

A discriminated union is how TypeScript expresses "this value is one of a
finite set of shapes." Each shape is an object type, all shapes share a
literal-typed discriminant field (usually named `type` or `ok`), and the
compiler tells shapes apart by that field.

Mapped onto what you already know:

- **Java**: `sealed interface` + several `record` implementations + `switch`
  pattern matching (Java 17+). `sealed` makes the set of implementations
  closed and enumerable, and `switch` fails to compile on a missing branch —
  TypeScript unions give you exactly those two guarantees.
- **Python**: `Union[A, B, C]` plus `isinstance` dispatch, or dataclasses
  with a `tag` field plus `match`. The difference is that Python's checking
  depends on mypy and exhaustiveness checking is weaker; in TypeScript,
  narrowing is a core language mechanism.

### Real code

In `lib/agent-tool-output.ts`, a tool execution result is a three-shape
union:

```ts
export type AgentToolOutput =
  | {
      type: 'success';
      contentText: string;
      details?: unknown;
      notice?: string;
      truncated?: boolean;
    }
  | {
      type: 'respond_to_model';
      error: AgentToolError;
      details?: unknown;
    }
  | {
      type: 'fatal';
      error: AgentToolError;
      details?: unknown;
    };
```

The shapes carry entirely different fields: success has `contentText` and no
`error`; failures are the reverse. **Narrowing** means: once you check the
discriminant, the compiler shrinks the type to the matching shape within that
branch:

```ts
export function serializeAgentToolOutputForModel(
  output: AgentToolOutput,
): string {
  if (output.type === 'success') {
    // In this branch, output is narrowed to the success shape:
    // contentText is accessible, and output.error is a compile error
    if (output.notice === undefined || output.notice === '') {
      return output.contentText;
    }

    return `${output.contentText}\n\n[${output.notice}]`;
  }

  // Here the compiler knows only respond_to_model and fatal remain,
  // and both carry an error field
  return `Error [${output.error.code}]: ${output.error.message}`;
}
```

The Java analogue is
`switch (output) { case Success s -> ...; case RespondToModel r -> ...; }` —
except no class hierarchy is needed; the shapes live directly in the type.

### Why the whole book leans on it

Look at `projectAgentEventToStreamEvent` in `lib/agent-stream-projection.ts`:
one big `switch (event.type)` over `AgentEvent` (a union with a dozen-plus
shapes), projecting each internal event to a public SSE event. When someone
adds a new shape to `AgentEvent` and forgets the projection, `tsc` fails the
build — the bug class "added an event, missed a consumer" is a compile-time
error in this project, not a production incident. Chapter 02's
`{ ok: true, ... } | { ok: false, error }` return values apply the same idea:
"this can fail" is written into the type, and callers cannot reach the result
fields without checking `ok`.

Once this pattern is familiar, all the passages in the main text shaped like
"add a member to the union, then follow the compile errors to update every
consumer" read naturally.

## Bridge 2: Zod And Boundary Validation

**Used in**: chapter 02 (chat input validation), chapter 06 (tool input
validation), chapter 13 (tool schemas). Every `*-input.ts` file in the repo
is Zod.

### The concept

TypeScript types are fully erased at compile time — there is zero type
checking at runtime. So wherever data enters from outside (HTTP request
bodies, model-generated tool arguments, environment variables), you need a
**runtime** validation layer. That is Zod's job: you declare a schema, it
validates data at runtime, and it **also derives the TypeScript type** — one
declaration yields both the runtime check and the compile-time type.

Mapped:

- **Java**: Bean Validation (`@NotNull`, `@Size`) on DTO classes. The
  difference: in Java the type (the class) and the validation (the
  annotations) are two separate declarations; in Zod the schema is the single
  source of truth and the type is derived from it (`z.infer`).
- **Python**: pydantic is a near one-to-one counterpart — `BaseModel` gives
  you runtime validation and type annotations together. If you know pydantic,
  the Zod mental model transfers directly.

### Real code

The agent request body schema in `lib/agent-input.ts` (excerpt):

```ts
export const agentInputSchema = z.strictObject(
  {
    task: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? 'Field `task` is required.'
            : 'Field `task` must be a string.',
      })
      .trim()
      .min(1, { error: 'Field `task` is required.' }),
    goal: optionalTrimmedStringSchema,
    // ...
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'Request body contains unknown fields.'
        : 'Request body must be a JSON object.',
  },
);

export type AgentInput = z.infer<typeof agentInputSchema>;
```

Worth noticing:

- `z.strictObject` rejects unknown fields (pydantic's `extra='forbid'`).
  This is deliberate: an undeclared field in a request almost always means
  the client misspelled a field name, and silently ignoring it just hides
  the bug.
- Every rule carries a custom error message. Those messages are returned
  verbatim to API callers and are part of the contract — chapter 02 explains
  why error messages deserve design too.
- `z.infer<typeof agentInputSchema>` derives the `AgentInput` type from the
  schema. Change the schema and the type follows; "validation and types out
  of sync" is not a possible bug.

Usage goes through `safeParse`, which returns — again — a discriminated union
(bridge 1):

```ts
const parsedBody = agentInputSchema.safeParse(body);
if (!parsedBody.success) {
  // parsedBody.error holds structured validation errors
}
// parsedBody.data is typed as AgentInput
```

`safeParse` never throws; it encodes "this can fail" into the return type —
consistent with the project's overall error-handling style.

### Where the boundary sits

The project's discipline: Zod appears only at **boundaries** — where HTTP
request bodies enter (`lib/*-input.ts`), where model-generated tool arguments
enter (each tool's `inputSchema` in `lib/agent-builtins.ts`), where
environment variables enter (`lib/env.ts`). Inside the boundary, data has
already been proven, and plain TypeScript types suffice. Code that validates
everywhere and code that never validates are two symptoms of the same
disease.

## Bridge 3: Next.js App Router: Files Are Routes

**Used in**: chapters 01 and 02 (chat/agent routes), chapter 19 (the dynamic
segments of the approval routes). Every `app/api/**/route.ts` file.

### The concept

In Spring you write a class and declare routes with annotations:

```java
@RestController
@RequestMapping("/api/agent")
public class AgentController {
    @PostMapping
    public ResponseEntity<...> run(@RequestBody AgentRequest req) { ... }
}
```

The Next.js App Router replaces annotations with **filesystem location**: the
path under `app/` is the URL path, and the exported function name is the HTTP
method. No registry, no annotation scanning, no configuration file.

### Real code

`app/api/agent/route.ts` (excerpt):

```ts
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  // ...
  return NextResponse.json({ ok: true, result: result });
}
```

The mapping rules:

```text
file path app/api/agent/route.ts        ->  URL path /api/agent
export async function POST               ->  responds to POST only
```

Export `GET` and it answers GET; export both and it answers both.
`export const runtime = 'nodejs'` pins the route to the full Node.js runtime
(rather than the restricted Edge runtime) — this project's tools spawn child
processes and read the filesystem, which requires Node.

Dynamic path segments are bracketed directory names. Chapter 19's approval
decision route:

```text
app/api/agent/approvals/[runId]/[toolCallId]/route.ts
  ->  POST /api/agent/approvals/{runId}/{toolCallId}
```

`[runId]` and `[toolCallId]` are directory names; the handler receives the
actual values through `params` — Spring's `@PathVariable`, in other words.

### How this project uses it

The convention is that `route.ts` stays thin: read the request, call the
validation function in `lib/`, call the service in `lib/`, return JSON. All
business logic lives in `lib/`, receives plain TypeScript objects, and never
touches `NextRequest`. That lets tests call the service layer directly with
no HTTP server — chapter 11's deterministic tests are built entirely on this
discipline. In Spring terms: the controller only ever does parameter binding
and response wrapping, and the `@Service` layer imports nothing from
`javax.servlet`.

One more warning for Java/Python readers: Next.js is not "boot one
long-lived application context." In dev mode a route module can be loaded
multiple times by the bundler, so module-level globals are unreliable — that
is the root cause behind chapter 19 putting the approval registry on
`globalThis`.

## Bridge 4: SSE: Streaming Responses

**Used in**: chapter 05 (making the agent streaming), chapter 10 (streaming
sampling), chapter 14 (the Debug Console consuming the event stream). Chapter
19's approval events ride the same channel.

### How it differs from WebSocket

Clearing up the most common confusion first. SSE (Server-Sent Events) and
WebSocket can both "push data continuously from the server," but they are not
the same thing:

```text
WebSocket   bidirectional, its own protocol (ws://), upgrade handshake, binary/text
SSE         one-way (server -> client only), just a plain HTTP response, plain text
```

SSE is surprisingly simple at its core: **an HTTP response that never ends**.
The server sets `Content-Type` to `text/event-stream` and keeps writing text
chunks into the body; the client reads as they arrive. No handshake, no new
protocol — curl can consume it.

The agent scenario happens to need only one-way push (the server pushes
events; the client's "input" is the initial POST request itself), so SSE is
sufficient — and it drops an entire layer of operational complexity that
WebSocket carries (proxies, heartbeats, reconnect semantics). That is the
heart of chapter 05's choice.

### The wire format

SSE's text format: each event is one or more `data: ...` lines terminated by
a blank line. This project's implementation in
`app/api/agent/stream/route.ts` is one line of core code:

```ts
function encodeAgentStreamEvent(event: AgentStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
```

Each event is serialized to one JSON line, prefixed with `data: `, followed
by a blank line. The response headers:

```ts
headers: {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
},
```

See it with your own eyes (`-N` disables curl's output buffering):

```bash
curl -N -X POST http://localhost:3000/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"task": "List the files in the project root.", "temperature": 0}'
```

You will watch `data: {...}` lines arrive one by one until the `done` event,
after which the connection closes.

### Two easy traps

- **The browser's native `EventSource` API only supports GET.** This
  project's streaming route is a POST (it needs a request body), so the
  frontend cannot use `EventSource`; instead it uses `fetch` plus a
  `ReadableStream`, reading bytes manually and splitting events on blank
  lines. You will meet that client code in chapter 05.
- **SSE event framing is not your business event type.** The wire layer has
  only one carrier, `data:`; distinguishing `step`/`assistantDelta`/`done`/
  `error` happens via the `type` field inside the JSON — which brings you
  back to bridge 1's discriminated unions.

For reference: if you have used OpenAI's or DeepSeek's streaming APIs,
`stream: true` there is also SSE, same format lineage (`data: {...}` with a
final `data: [DONE]`). This project effectively replicates the pattern on its
own API.

## Bridge 5: The OpenAI Tool-Calling Protocol

**Used in**: chapter 09 (response items), chapter 10 (committing tool calls
under streaming), chapter 13 (strict schemas). This protocol is the bedrock
of the agent loop.

### The protocol itself

Tool calling (also called function calling) is a three-step cycle, entirely
over ordinary Chat Completions requests:

**Step 1: declare tools in the request.** Each tool is a name plus a JSON
Schema description of its parameters:

```json
{
  "model": "gpt-4o-mini",
  "messages": [...],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read a UTF-8 text file. ...",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "File path to read. ..." }
          },
          "required": ["path"]
        }
      }
    }
  ]
}
```

(That schema is exactly the `modelTool.inputSchema` on each tool definition
in `lib/agent-builtins.ts` — the tool's "manual" as the model sees it.)

**Step 2: instead of answering, the model requests a tool call.** The
assistant message in the response carries `tool_calls`:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"path\": \"package.json\"}"
      }
    }
  ]
}
```

Note that `arguments` is a **string**, not a JSON object. That is not a
design accident: the model generates text token by token, so under streaming
the arguments arrive as string fragments being stitched together (chapter
10's `tool_call_delta` events), and the protocol simply defines the field as
a string, pushing parsing responsibility onto the caller. So the harness must
`JSON.parse` it itself — and must handle parse failure, because the model can
emit broken JSON. `parseToolInput` in `lib/agent-builtins.ts` is that defense
layer: first `JSON.parse`, then the Zod schema, either step can fail, and
both failures become model-visible errors.

**Step 3: execute the tool, feed the result back as a message, call the
model again.** In the Chat Completions dialect that is a `role: "tool"`
message:

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "File: package.json\nLines: 1-30 of 30\n..."
}
```

`tool_call_id` pairs the result with the request from step 2 — one round can
contain multiple tool calls, so pairing cannot rely on order. Then the model
is called again with the full history. It may request more tools (back to
step 2) or produce a plain text answer — **a response with no `tool_calls`
is the loop's termination condition**. That sample-execute-append-resample
cycle is the agent loop itself, and all of chapter 10's commit semantics
revolve around it.

### The counterparts in this repo

Chapter 09 introduces the provider-neutral history representation
`AgentResponseItem` (`lib/agent-response-items.ts`):

```ts
export type AgentResponseItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: string; /* ... */ }
  | { type: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { type: 'function_call_output'; callId: string; toolName: string; output: string; isError: boolean }
  | { type: 'compaction_summary'; content: string };
```

The pair `function_call` / `function_call_output` takes its names from the
OpenAI **Responses API** vocabulary (which calls a tool result
`function_call_output`, where Chat Completions uses a `role: "tool"`
message). The project keeps this neutral representation internally, and the
dialect layer (chapter 08) translates it into each wire format's own idiom —
`responseItemsToModelMessages` is the half that translates into the Chat
Completions shape. With this bridge's wire protocol understood, chapters 08
and 09's argument for "why a neutral representation is necessary" follows
naturally.

## Bridge 6: Promise/async Ordering And The Event Loop

**Used in**: chapter 19's "synchronous registration guarantee" section is
built directly on this bridge; chapter 05 (cancellation) and chapter 10
(stream consumption) also need the basic intuition.

### Where it differs from the model you know

- **Java**: concurrency means threads; a `CompletableFuture` callback may run
  on another thread, so locks and visibility are everywhere. JS has none of
  that — it is **single-threaded**; no two pieces of JS code ever run at the
  same time, so there are no data races. The price: no code may block (there
  is no `Thread.sleep` equivalent), and every wait is written as `await`.
- **Python**: `asyncio` is the closest model (single-threaded event loop plus
  `await`), with one key difference that happens to be chapter 19's whole
  point: Python coroutines are **lazy** — calling an `async def` function
  yields a coroutine object without executing a single line; JS async
  functions are **eager** — the call starts executing synchronously and only
  suspends at the first `await` that actually yields control.

### Three rules

Three rules cover every ordering question in this project:

**Rule 1: an async function runs synchronously up to its first await.**

```ts
async function example() {
  console.log('A');            // runs synchronously at call time
  await somethingAsync();      // control is yielded here
  console.log('B');            // runs on some later tick
}

example();
console.log('C');
// output order: A, C, B
```

**Rule 2: a Promise executor also runs synchronously.** The function body in
`new Promise((resolve) => { ... })` completes during the `new` itself (unless
it starts async work of its own).

**Rule 3: microtasks run before macrotasks.** Continuations after `await`,
`.then` callbacks, and `queueMicrotask` all enter the microtask queue, which
drains **immediately** after the current call stack empties — ahead of
`setTimeout` (a macrotask). A workable approximation: microtasks are "as soon
as I finish this breath," macrotasks are "next round."

### Real code: chapter 19's synchronous registration guarantee

Chapter 19 contains a test pattern that looks like gambling if you don't know
the rules above:

```ts
const executionPromise = executeAgentToolCall(toolCall, context, callbacks);
const resolveResult = resolveAgentApproval(runId, toolCallId, 'approve');
assert.equal(resolveResult.ok, true);
const execution = await executionPromise;
```

Line one calls an async function **without awaiting it**; line two
immediately resolves an approval that is "supposed to be pending." Why is
this not a race?

Because of rules 1 and 2: once called, `executeAgentToolCall` executes
synchronously down to its internal `await waitForAgentApproval(...)`; and
inside `waitForAgentApproval`, the `registry.set(...)` that records the
pending entry happens inside the Promise executor — synchronously. So by the
time line one returns, the registry entry **already** exists, and line two's
resolve is guaranteed to find it. No sleeps, no polling — the ordering is
guaranteed by language semantics, not luck.

The same chapter has the counter-case: in the sampling-loop-level integration
tests, the approval request crosses several layers of `await` before reaching
the registration point, the synchronous guarantee no longer holds, and the
tests use `queueMicrotask` (rule 3) to push the resolve into the microtask
queue, ensuring registration happens first.

A Java contrast to locate the value of this guarantee: in Java, "start a task
and immediately poke at its internal state" is almost always a race requiring
a lock or a latch; in JS, as long as the write happens before the first
yielding await, it is synchronous and deterministic. The single-threaded
event loop turns a whole class of concurrency bugs into an ordering problem
you can reason about — provided you know these three rules.
