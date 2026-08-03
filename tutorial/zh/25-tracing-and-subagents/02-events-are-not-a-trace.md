← 上一节：[01 · 答不出来的那个问题](01-the-question-you-cant-answer.md) · [章目录](README.md) · 下一节：[03 · 两张图，不是一张](03-two-graphs.md)

# 02 · 事件流不等于 trace

上一节结束在一个结论：缺的不是数据，是"每段工作有自己的身份，以及它属于谁"。

这一节把这两样东西加上。加完你会发现，改动小得有点不像话——而这恰恰说明前面几章的事件流设计是对的。

## 一段工作，需要哪三样东西

一个 span（跨度）就是"一段有始有终的工作"。要让它可用，需要三样：

| 需要什么 | 为了回答 |
| --- | --- |
| 一个自己的 id | "这条 `tool_finished` 是哪条 `tool_started` 的结局" |
| 一个父 id | "这次工具调用是在哪一轮决策底下发生的" |
| 起止时刻 | "它花了多久" |

第三样其实**早就有了**。翻开 `lib/agent-tool-runtime.ts`，`executeAgentToolCall` 的第二行：

```ts
const startedAt = Date.now();
```

每条返回路径都在算 `Date.now() - startedAt`，结果塞进 `AgentToolExecution.durationMs`。时长一直在测，只是没往事件里带。

所以真正要加的只有前两样。

## id 长什么样：一个五分钟的决定，管十年

先定 id 的格式。这个选择现在改是免费的，以后改是数据迁移。

```ts
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export function createTraceId(): string {
  return randomBytes(TRACE_ID_BYTES).toString('hex');
}

export function createSpanId(): string {
  return randomBytes(SPAN_ID_BYTES).toString('hex');
}
```

trace id 16 字节、span id 8 字节、小写 hex。

**为什么偏偏是这个尺寸**：这是 OpenTelemetry 在线上要求的格式。我们这一章不打算引入 OTel 的任何代码，但把 id 做成它认识的形状，成本是零；等哪天想把 run 导出去看（第 05 节），那件事就是字段改名，而不是"重新生成所有 id"。

用 `randomUUID()` 也能跑，但 UUID 是 36 字符带连字符的，OTLP 不收。到时候你要么做映射表，要么承认历史数据导不出去。

**时间戳反过来**——OTel 用 Unix 纳秒，我们坚持 ISO 字符串：

```ts
export function createSpanTiming(startedAtMs: number, endedAtMs: number) {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
  };
}
```

因为 JSONL 是要给人用 `less` 看的。`"2026-07-29T03:14:07.238Z"` 一眼能读，`1785294847238000000` 不能。导出时乘个 `1_000_000` 就完事了——**为机器省的那点转换，不值得让人每次都去数零**。

## 挂在哪儿：不加参数

span 要传遍整个调用链。而调用链里已经有个东西传遍了各处：`AgentRunContext`。

```ts
export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
  policy: AgentRunPolicy;
  approvalMode: AgentApprovalMode;
  toolState: AgentRunToolState;
  span: AgentSpanContext;      // 新增
  spawnDepth: number;          // 新增，第 04 节要用
};
```

于是三层 span 各自有了明确的出生地：

- **run 的根 span** — `createAgentRunContext` 里创建，整个 run 一个
- **model span** — 在 `runSamplingLoop` 的循环体里创建，每轮一个
- **tool span** — 在 `executeAgentToolCall` 里创建，每次调用一个

model span 这个有点讲究。`model_requested` 事件是在 `runSamplingRound` 里发的，`model_completed` 是在外层 `runSamplingLoop` 里发的——**两个不同的函数**。要让它们带同一个 span id，span 就必须在外层创建再传进去：

```ts
const modelSpan = createChildSpanContext(context.span);
const modelStartedAt = Date.now();

const roundResult = await runSamplingRound(
  modelGateway, input, context, history, round, emitAgentEvent,
  modelSpan, modelStartedAt,
);
```

多传两个参数，换一对能配上的 id。这就是上一节"配不上对"那个问题的解。

## 字段做成可选的：一个诚实问题

给事件加 span 字段的时候，有个选择：必填还是可选？

必填的好处是编译器帮你查漏——任何一个发射点忘了带 span 都过不了编译。

但是：**旧的会话文件里没有 span**。而读取路径是这样的：

```ts
.map((line) => JSON.parse(line) as AgentSessionRecord)
```

一个无校验的 `as`。旧文件读进来，`span` 就是 `undefined`，类型上写"必有"只会骗人——骗到的是几个月后写 UI 的你，然后在旧数据上崩掉。

所以做成可选：

```ts
export type AgentEventSpanFields = {
  span?: AgentSpanContext;
};
```

**类型描述的是文件里可能有什么，不是你希望有什么。** 发射端的完整性用测试保证，不用类型硬凹。

## 一个真踩到的坑：别给旧数据加字段

事件送到浏览器要过一层投影（`lib/agent-stream-projection.ts`），它是逐字段重列的：

```ts
case 'tool_started':
  return {
    type: 'debug',
    event: {
      type: 'toolStarted',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argumentsJson: event.argumentsJson,
    },
  };
```

顺手加两行 `span: event.span, startedAt: event.startedAt` 看起来天经地义。加完，四个投影测试全红了。

原因：对**没有 span 的旧事件**，这么写会产出 `span: undefined` 这个键。`assert.deepEqual`（在 `node:assert/strict` 下是严格版）认为 `{a:1}` 和 `{a:1, b:undefined}` 不相等——它说得对，**这确实是契约变了**。以后每个下游都得学会忽略一个恒为 undefined 的键。

改成只 spread 真正存在的字段：

```ts
function definedTraceFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
```

那四个测试**一个字没改就重新变绿了**。

这件事值得记住：**测试红了，第一反应不该是改测试。** 它们在告诉你"你以为的兼容改动，其实不兼容"。改测试就是把这个信号捂掉。

## 顺手做对的一件事

`tool_finished` 在工具**根本没跑**的路径上也会发——未知工具、权限拒绝、审批被拒。这些路径同样带完整的 span：

```ts
/**
 * 注意 `tool_finished` 也会在工具从未执行的路径上发出。它们照样带一个完整的
 * span：一个 span 是一条带两端的记录，所以被拒绝的调用在瀑布图里是一根很短
 * 的条，而不是凭空消失。
 */
```

为什么要特意这样：**"这里为什么什么都没有"是 trace 最难回答的问题。** 一次被权限拦下的 `write`，如果在图上不留痕迹，你只会觉得"模型没试过写文件"，而真相是"它试了，被拦了"。

---

← 上一节：[01 · 答不出来的那个问题](01-the-question-you-cant-answer.md) · [章目录](README.md) · 下一节：[03 · 两张图，不是一张](03-two-graphs.md)
