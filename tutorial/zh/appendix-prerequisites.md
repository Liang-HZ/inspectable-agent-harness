# 附录：前置知识桥

这份附录写给从 Java/Python 背景跨过来的读者。正文假设你会编程，但不假设你熟 TypeScript、Node、Next.js 或 LLM API——这中间有六个具体的知识断层，每个都会在某几章里让你卡住。

不建议从头到尾读完这份附录再开始正文。更好的用法是：直接读正文，卡住时对着下面的目录跳回来补那一座桥，补完接着读。每座桥都标注了"哪几章会用到"。

| 桥 | 主题 | 哪几章会用到 |
| --- | --- | --- |
| [1](#桥-1discriminated-union-与类型收窄) | Discriminated union 与类型收窄 | 全书；集中在 02、09、10、13、19 |
| [2](#桥-2zod-与边界校验) | Zod 与边界校验 | 02、06、13 |
| [3](#桥-3nextjs-app-router文件即路由) | Next.js App Router：文件即路由 | 01、02、19 |
| [4](#桥-4sse流式响应) | SSE：流式响应 | 05、10、14 |
| [5](#桥-5openai-tool-calling-协议) | OpenAI tool-calling 协议 | 09、10、13 |
| [6](#桥-6promiseasync-时序与事件循环) | Promise/async 时序与事件循环 | 19；间接支撑 05、10 |

## 桥 1：Discriminated union 与类型收窄

**哪几章会用到**：这是全书的核心叙事工具。`AgentResponseItem`(第 9 章)、`AgentToolOutput`(第 13 章)、`AgentEvent`(第 5 章)、`AgentStreamEvent`(第 19 章)全是 union。第 2 章的 `ok: true / ok: false` 返回值模式也是它。

### 概念

Discriminated union(可辨识联合)是 TypeScript 表达"这个值是有限几种形态之一"的方式。每种形态是一个对象类型，共享一个字面量类型的判别字段(通常叫 `type` 或 `ok`)，编译器靠这个字段区分形态。

对照你熟悉的概念：

- **Java**：`sealed interface` + 若干 `record` 实现 + `switch` 模式匹配(Java 17+)。`sealed` 保证实现类封闭可枚举，`switch` 缺分支时编译器报错——TypeScript 的 union 提供完全一样的两个保证。
- **Python**：`Union[A, B, C]` + `isinstance` 分流，或带 `tag` 字段的 dataclass + `match` 语句。区别是 Python 的检查靠 mypy 且穷尽性检查较弱，TypeScript 的收窄是语言核心机制。

### 真实代码

`lib/agent-tool-output.ts` 里，工具执行结果就是一个三形态 union：

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

三种形态字段完全不同：成功时有 `contentText`，没有 `error`；失败时反过来。**类型收窄(narrowing)** 指的是：一旦你检查了判别字段，编译器就在那个分支里把类型缩小成对应形态：

```ts
export function serializeAgentToolOutputForModel(
  output: AgentToolOutput,
): string {
  if (output.type === 'success') {
    // 这个分支里 output 被收窄为 success 形态，
    // 可以访问 contentText；访问 output.error 会编译报错
    if (output.notice === undefined || output.notice === '') {
      return output.contentText;
    }

    return `${output.contentText}\n\n[${output.notice}]`;
  }

  // 走到这里，编译器知道只剩 respond_to_model 和 fatal 两种形态，
  // 它们都有 error 字段
  return `Error [${output.error.code}]: ${output.error.message}`;
}
```

对照 Java：这相当于 `switch (output) { case Success s -> ...; case RespondToModel r -> ...; }`，但不需要定义类层次——形态直接写在类型里。

### 为什么全书都在用它

看 `lib/agent-stream-projection.ts` 的 `projectAgentEventToStreamEvent`：它对 `AgentEvent`(十几种形态的 union)做一个大 `switch (event.type)`，把每种内部事件投影成对外的 SSE 事件。当有人给 `AgentEvent` 加一种新形态而忘了处理投影时，`tsc` 会直接报错——**新增一种事件却漏掉一个消费方**这类 bug，在这个项目里是编译期错误，不是线上事故。第 2 章的 `{ ok: true, ... } | { ok: false, error }` 返回值也是同一思路：把"可能失败"写进类型，调用方不检查 `ok` 就拿不到结果字段。

习惯了这个模式，正文里大量"给 union 加一个成员，然后跟着编译错误把所有消费方补齐"的叙述就都能读懂了。

## 桥 2：Zod 与边界校验

**哪几章会用到**：第 2 章(chat 输入校验)、第 6 章(工具输入校验)、第 13 章(工具 schema)。项目里所有 `*-input.ts` 文件都是 Zod。

### 概念

TypeScript 的类型在编译后会被完全擦除——运行时没有任何类型检查。所以当数据从外部进来(HTTP 请求体、模型生成的工具参数、环境变量)，必须有一个**运行时**校验层。Zod 就是干这个的：你用它声明一个 schema，它在运行时校验数据，并且**顺便推导出 TypeScript 类型**——一份声明，同时得到运行时检查和编译期类型。

对照：

- **Java**：Bean Validation(`@NotNull`、`@Size`)+ DTO 类。区别是 Java 里类型(class)和校验(注解)是两套声明；Zod 里 schema 就是唯一事实源，类型从 schema 推导(`z.infer`)。
- **Python**：pydantic 是几乎一对一的对照物——`BaseModel` 同时给你运行时校验和类型标注。如果你熟 pydantic，Zod 的心智模型可以直接平移。

### 真实代码

`lib/agent-input.ts` 里 agent 请求体的 schema(节选)：

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

几个值得注意的点：

- `z.strictObject` 拒绝未知字段(对照 pydantic 的 `extra='forbid'`)。这是刻意的：请求里出现没定义的字段，大概率是客户端拼错了字段名，静默忽略只会把 bug 藏起来。
- 每条规则都带自定义错误文案。这些文案会原样返回给 API 调用方，是 contract 的一部分——第 2 章会讲为什么错误消息也要设计。
- `z.infer<typeof agentInputSchema>` 从 schema 推导出 `AgentInput` 类型。改 schema，类型自动跟着变，不存在"校验和类型不同步"这类问题。

使用时走 `safeParse`，返回的又是一个 discriminated union(桥 1)：

```ts
const parsedBody = agentInputSchema.safeParse(body);
if (!parsedBody.success) {
  // parsedBody.error 里是结构化的校验错误
}
// parsedBody.data 的类型是 AgentInput
```

`safeParse` 不抛异常，把"可能失败"编码进返回类型——和整个项目的错误处理风格一致。

### 边界在哪

这个项目的纪律是：Zod 只出现在**边界**上——HTTP 请求体进来的地方(`lib/*-input.ts`)、模型生成的工具参数进来的地方(`lib/agent-builtins.ts` 里每个工具的 `inputSchema`)、环境变量进来的地方(`lib/env.ts`)。边界以内，数据已经是被证明过的类型，纯 TypeScript 类型就够了。校验逻辑到处都是的代码和完全不校验的代码，是同一种病的两个症状。

## 桥 3：Next.js App Router：文件即路由

**哪几章会用到**：第 1、2 章(chat/agent 路由)、第 19 章(approval 路由的动态段)。所有 `app/api/**/route.ts` 文件。

### 概念

Spring 里你写一个类，用注解声明路由：

```java
@RestController
@RequestMapping("/api/agent")
public class AgentController {
    @PostMapping
    public ResponseEntity<...> run(@RequestBody AgentRequest req) { ... }
}
```

Next.js App Router 用**文件系统位置**代替注解：`app/` 目录下的路径就是 URL 路径，文件里导出的函数名就是 HTTP 方法。没有注册表，没有注解扫描，没有配置文件。

### 真实代码

`app/api/agent/route.ts`(节选)：

```ts
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  // ...
  return NextResponse.json({ ok: true, result: result });
}
```

对应规则：

```text
文件路径 app/api/agent/route.ts   ->  URL 路径 /api/agent
导出函数 export async function POST  ->  只响应 POST 方法
```

导出 `GET` 就响应 GET，两个都导出就都响应。`export const runtime = 'nodejs'` 声明这个路由跑在完整 Node.js 运行时里(而不是受限的 Edge 运行时)——本项目的工具要 spawn 子进程、读文件系统，必须是 Node 运行时。

动态路径段用方括号目录名表达。第 19 章的 approval 决策路由：

```text
app/api/agent/approvals/[runId]/[toolCallId]/route.ts
  ->  POST /api/agent/approvals/{runId}/{toolCallId}
```

`[runId]` 和 `[toolCallId]` 是目录名，路由处理函数通过 `params` 拿到实际值——对照 Spring 的 `@PathVariable`。

### 这个项目怎么用它

约定是 `route.ts` 保持薄：读请求、调 `lib/` 里的校验函数、调 `lib/` 里的 service、返回 JSON。所有业务逻辑都在 `lib/` 里，接收纯 TypeScript 对象，不接触 `NextRequest`。这样 service 层可以被测试直接调用，不需要起 HTTP 服务器——第 11 章的确定性测试完全建立在这条纪律上。对照 Spring 的说法：controller 永远只做参数绑定和响应包装，`@Service` 层不 import 任何 `javax.servlet`。

另外一个对 Java/Python 读者的提醒：Next.js 不是"启动一个常驻的 application context"。开发模式下每个路由模块可能被打包器加载多次，模块级的全局变量不可靠——第 19 章 approval registry 为什么放在 `globalThis` 上，根源就是这个。

## 桥 4：SSE：流式响应

**哪几章会用到**：第 5 章(agent 流式化)、第 10 章(流式采样)、第 14 章(Debug Console 消费事件流)。第 19 章的 approval 事件也走这条通道。

### 和 WebSocket 的区别

先把最常见的混淆说清楚。SSE(Server-Sent Events)和 WebSocket 都能"服务器持续推数据"，但它们不是一个东西：

```text
WebSocket   双向、独立协议(ws://)、需要协议升级握手、二进制/文本
SSE         单向(仅服务器 -> 客户端)、就是普通 HTTP 响应、纯文本
```

SSE 的本质简单到出乎意料：**一个一直不结束的 HTTP 响应**。服务器把 `Content-Type` 设为 `text/event-stream`，然后往响应体里持续写文本块；客户端边到边读。没有握手升级，没有新协议，curl 就能消费。

Agent 场景恰好只需要单向推送(服务器推事件，客户端的"输入"就是最初那个 POST 请求本身)，所以 SSE 够用，而且比 WebSocket 少一整层运维复杂度(代理、心跳、重连语义)。这是第 5 章选型的核心理由。

### Wire 格式

SSE 的文本格式：每个事件是一行或多行 `data: ...`，以一个空行结束。本项目的实现在 `app/api/agent/stream/route.ts`，就一行核心代码：

```ts
function encodeAgentStreamEvent(event: AgentStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
```

每个事件序列化成一行 JSON，前缀 `data: `，后跟空行。响应头：

```ts
headers: {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
},
```

亲眼看一次(`-N` 禁用 curl 的输出缓冲)：

```bash
curl -N -X POST http://localhost:3000/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"task": "列出项目根目录的文件。", "temperature": 0}'
```

你会看到 `data: {...}` 一行行到达，直到 `done` 事件后连接关闭。

### 两个容易踩的点

- **浏览器原生的 `EventSource` API 只支持 GET**。本项目的流式路由是 POST(要传请求体)，所以前端没法用 `EventSource`，而是用 `fetch` + `ReadableStream` 手动读字节流、按空行切分事件。第 5 章会看到这段客户端代码。
- **SSE 事件类型不等于业务事件类型**。wire 层只有 `data:` 一种载体；业务上的 `step`/`assistantDelta`/`done`/`error` 区分是靠 JSON 里的 `type` 字段——又回到了桥 1 的 discriminated union。

对照：如果你用过 OpenAI/DeepSeek 的流式 API，它们的 `stream: true` 走的就是 SSE，格式完全同源(`data: {...}`，最后一条是 `data: [DONE]`)。本项目等于在自己的 API 上复刻了这个模式。

## 桥 5：OpenAI tool-calling 协议

**哪几章会用到**：第 9 章(response items)、第 10 章(流式下的 tool call 提交)、第 13 章(strict schema)。这是 agent loop 的地基协议。

### 协议本体

Tool calling(也叫 function calling)是一个三步循环，全部走普通的 Chat Completions 请求：

**第 1 步：请求时声明工具。** 每个工具是一个名字加一份 JSON Schema 参数描述：

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

(这份 schema 就是 `lib/agent-builtins.ts` 里每个工具定义的 `modelTool.inputSchema`——模型看到的工具"说明书"。)

**第 2 步：模型不回答，而是请求调用工具。** 响应里的 assistant message 带 `tool_calls`：

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

注意 `arguments` 是**字符串**，不是 JSON 对象。这不是设计失误：模型是逐 token 生成文本的，流式传输时参数是一段一段拼出来的字符串(第 10 章的 `tool_call_delta` 事件)，协议干脆把它定义为字符串，解析责任交给调用方。所以 harness 必须自己 `JSON.parse`，而且必须处理解析失败——模型可能生成残缺 JSON。`lib/agent-builtins.ts` 的 `parseToolInput` 就是这层防御：先 `JSON.parse`，再过 Zod schema，两步都可能失败，失败都变成 model-visible 错误。

**第 3 步：执行工具，把结果作为消息回填，再次调用模型。** Chat Completions 形态下是一条 `role: "tool"` 消息：

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "File: package.json\nLines: 1-30 of 30\n..."
}
```

`tool_call_id` 把结果和第 2 步的请求配对——一轮里可能有多个 tool call，配对不能靠顺序。然后带着完整历史再调一次模型。模型可能继续请求工具(回到第 2 步)，也可能给出普通文本回答——**没有 `tool_calls` 的响应就是循环的终止条件**。这个"采样—执行—回填—再采样"的循环就是 agent loop 本体，第 10 章的 commit 语义全部围绕它展开。

### 项目里的对应物

第 9 章会引入 provider 中立的历史表示 `AgentResponseItem`(`lib/agent-response-items.ts`)：

```ts
export type AgentResponseItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: string; /* ... */ }
  | { type: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { type: 'function_call_output'; callId: string; toolName: string; output: string; isError: boolean }
  | { type: 'compaction_summary'; content: string };
```

`function_call` / `function_call_output` 这对名字来自 OpenAI **Responses API** 的术语(它把工具结果叫 `function_call_output`，而 Chat Completions 叫 `role: "tool"` 消息)。项目内部用这套中立表示，再由 dialect 层(第 8 章)翻译成两种 wire 形态各自的写法——`responseItemsToModelMessages` 就是翻译成 Chat Completions 形态的那半边。理解了本桥的 wire 协议，第 8、9 章"为什么需要中立表示"的论证就是顺理成章的。

## 桥 6：Promise/async 时序与事件循环

**哪几章会用到**：第 19 章的"同步注册保证"一节直接建立在本桥之上；第 5 章(取消)、第 10 章(流消费)也需要基本直觉。

### 和你熟悉的模型差在哪

- **Java**：并发靠线程，`CompletableFuture` 的回调可能在另一个线程执行，所以到处要考虑锁和可见性。JS 没有这些——**单线程**，永远不会有两段 JS 代码同时执行，也就没有数据竞争。代价是任何代码都不能阻塞(没有 `Thread.sleep` 的等价物)，一切等待都写成 `await`。
- **Python**：`asyncio` 的模型最接近(单线程事件循环 + `await`)，但有一个关键差异，正好是第 19 章的要点：Python 的协程是**惰性**的——调用 `async def` 函数只得到 coroutine 对象，一行都不执行；JS 的 async 函数是**急切**的——调用即开始同步执行，直到第一个真正让出控制权的 `await` 才暂停。

### 三条规则

理解本项目的时序问题，只需要三条规则：

**规则 1：async 函数在第一个 await 之前是同步执行的。**

```ts
async function example() {
  console.log('A');            // 调用时立即同步执行
  await somethingAsync();      // 到这里才让出控制权
  console.log('B');            // 之后的某个 tick 执行
}

example();
console.log('C');
// 输出顺序：A, C, B
```

**规则 2：Promise 的 executor 也是同步执行的。** `new Promise((resolve) => { ... })` 里的函数体在 `new` 的当下就跑完(除非它内部再做异步操作)。

**规则 3：微任务(microtask)优先于宏任务(macrotask)。** `await` 之后的续体、`.then` 回调、`queueMicrotask` 都进微任务队列，在当前调用栈清空后**立即**执行，排在 `setTimeout`(宏任务)之前。你可以近似理解为：微任务是"当前这口气做完就处理"，宏任务是"下一轮再说"。

### 真实代码：第 19 章的同步注册保证

第 19 章有一个测试写法，不懂上面三条规则会觉得它在赌运气：

```ts
const executionPromise = executeAgentToolCall(toolCall, context, callbacks);
const resolveResult = resolveAgentApproval(runId, toolCallId, 'approve');
assert.equal(resolveResult.ok, true);
const execution = await executionPromise;
```

第一行调用了 async 函数但**没有 await**，第二行立刻去 resolve 一个"应该正在等待的" approval。这为什么不是竞态？

因为规则 1 + 规则 2：`executeAgentToolCall` 被调用后同步执行到内部的 `await waitForAgentApproval(...)`；而 `waitForAgentApproval` 里，往 registry 写入 pending 项的 `registry.set(...)` 发生在 Promise executor 内部——同步。所以第一行返回时，registry **已经**写入完毕，第二行的 resolve 必然能找到它。不需要 sleep，不需要轮询，时序是由语言语义保证的，不是靠运气。

同一章还有反面案例：采样循环层面的集成测试里，approval 请求要穿过多层 `await` 才到达注册点，同步保证不再成立，所以测试用 `queueMicrotask`(规则 3)把 resolve 推迟到微任务队列，确保注册先发生。

一个 Java 对照帮助定位这个保证的价值：在 Java 里"启动一个任务然后立刻操作它的内部状态"几乎必然是竞态，需要锁或 latch；在 JS 里，只要写入发生在第一个 await 之前，它就是同步的、确定的。单线程事件循环把一整类并发 bug 变成了可以推理的顺序问题——但前提是你知道这三条规则。
