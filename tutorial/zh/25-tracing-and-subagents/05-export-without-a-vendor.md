← 上一节：[04 · 子代理跑在别的文件里](04-the-subagent-problem.md) · [章目录](README.md) · 下一节：[06 · 这一章花了多少钱](06-what-it-cost.md)

# 05 · 不绑厂商的出口

到这里，harness 自己已经能画瀑布图了。那还要外部后端干什么？

因为自建的图只能看**这一次** run。跨 run 的对比、"这个月哪个工具最常失败"、"换了模型之后 p95 有没有变"，这些要的是一个真正的观测后端。而这类东西自己写就是重造轮子——成熟方案早就有了。

问题只剩一个：**接哪个，以及接的时候绑住的是什么。**

## 先排除一个

LangSmith 常被拿来当默认选项。但它的 SDK 开源、后端 / UI / 存储都不开源，自托管是 Enterprise-only，要 license key。

对个人开发者来说这一条就够了：**它不是"重"的问题，是根本不能自托管。**

开源可自托管的选项里，两个有代表性的：

- **Langfuse** — 功能最全（trace + 评测 + prompt 管理 + 成本），但自托管是 6 个容器：web、worker、Postgres、ClickHouse、Redis、MinIO。官方给生产的建议是 4 核 16G。
- **Arize Phoenix** — Apache-2.0，一个容器，本地跑起来大约 400 MiB 内存、十几秒就绪。

## 关键的一层：绑语义约定，不绑后端

这两个后端有个共同点：**都原生吃 OTLP**。

这件事决定了整个接入方式。你在 harness 里要写死的东西，不是"Langfuse 的 SDK"，也不是"Phoenix 的 SDK"，而是：

1. **OpenTelemetry 的 id 格式** — 第 02 节已经做了，那时候还没提为什么。
2. **GenAI 语义约定** — 属性叫什么名字。

绑住这两层，后端就是可插拔的：

```ts
export type OtlpExportTarget = {
  endpoint: string;                      // 换后端 = 换这一行
  headers?: Record<string, string>;      // Langfuse Cloud 的 Basic auth 放这儿
  serviceName?: string;
  encoding?: OtlpEncoding;
};
```

如果反过来——在主循环里 `import { Langfuse } from 'langfuse'`——那换后端就是改主循环，而且 README 上"no agent framework, no LangChain, no agent SDK"那句话也不用写了。

**属性名同时发两套**：

```ts
function llmAttributes(model: string): OtlpAttributeInput[] {
  return [
    stringAttribute('gen_ai.system', 'openai'),
    stringAttribute('gen_ai.operation.name', 'chat'),
    stringAttribute('gen_ai.request.model', model),
    stringAttribute('openinference.span.kind', 'LLM'),
    stringAttribute('llm.model_name', model),
  ];
}
```

`gen_ai.*` 是 OTel 的 GenAI 语义约定，Langfuse 读它；`openinference.*` / `llm.*` 是 OpenInference，Phoenix 原生渲染它。两套不冲突，多发几个属性的成本可以忽略，换来的是同一次 run 打到哪个后端都好看。

## 导出器是读者，不是第二个写者

这是整套设计里最该守住的一条：

```ts
export function buildSpansForSession(sessionPath: string): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  buildSpansFromRecords(readAgentSessionRecords(sessionPath), spans);

  for (const child of listSubagentSessionSummaries(sessionPath)) {
    buildSpansFromRecords(readAgentSessionRecords(child.path), spans);
  }

  return spans;
}
```

导出器**读**会话文件，然后 POST。它不参与 run，不在热路径上，不持有状态。

这带来三个性质：

- 导出可以**重跑**。后端挂了？改天再导一次。
- 导出可以**换目标**。今天 Phoenix，明天 Langfuse Cloud，同一批历史数据。
- 关掉导出**不丢数据**。因为数据从来没有"只在飞往厂商的路上"过。

如果反过来做成"运行时同步往后端打点"，上面三条全没了，而且后端超时会拖慢 agent。

## 实测踩到的坑：JSON 不够用

写完 JSON 版本，打到 Phoenix：

```
{"ok":false,"spanCount":8,"status":415,"error":"Unsupported content type: application/json"}
```

`415`。验一下：

```
JSON 到 /v1/traces         → 415
protobuf content-type      → 200
```

**Phoenix 的 OTLP HTTP 端点只收 protobuf。** 而 Langfuse 两种都收。

这种事只有真跑一次才知道——文档上"支持 OTLP/HTTP"这句话，两边写的一样。

于是要么放弃 Phoenix，要么会写 protobuf。选了后者，因为 OTLP 的 trace schema 我们只用到很小一个子集，手写编码器大约 190 行：

```ts
function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}
```

protobuf 的线格式就这么点东西：字段 = varint 标签 `(字段号 << 3) | 线类型`，后面跟值，一共用到四种线类型。

**为什么不装个 protobuf 库**：`@opentelemetry/exporter-trace-otlp-proto` 会带进来一棵依赖树和一个全局 tracer-provider 单例，而这个仓库的全部卖点是"你能读完它"。190 行可读的编码器，比一棵不可读的依赖树更符合这个定位。

编码器里有两个地方特别容易错，都写了注释：

```ts
// trace_id 和 span_id 在线上是裸字节，不是 JSON 编码里用的 hex 文本——
// 这是 span 被静默丢弃的常见原因。
encodeBytesField(1, Buffer.from(span.traceId, 'hex')),
```

```ts
/** 时间戳在 OTLP schema 里是 fixed64，不是 varint。 */
function encodeFixed64Field(fieldNumber: number, value: bigint): Buffer {
```

搞错任何一个，后端要么报错要么静默吞掉 span，都很难查。

## 验收长什么样

导一次带子代理的 run 进 Phoenix，然后问它要 span 列表：

```
agent run          CHAIN     parent=None
├─ chat gpt-4o-mini  LLM     parent=agent run
├─ read              TOOL    parent=agent run
├─ chat gpt-4o-mini  LLM     parent=agent run
└─ task              TOOL    parent=agent run
   └─ subagent       AGENT   parent=task        ← 来自另一个文件
      ├─ chat        LLM     parent=subagent
      └─ grep        TOOL    parent=subagent
```

子代理躺在 `subagents/agent-<id>.jsonl` 里，从来没和主会话在同一个文件出现过，但它落在了 `task` 底下。

接起来的东西只有一个：`createChildSpanContext` 继承下来的那个 traceId。

---

← 上一节：[04 · 子代理跑在别的文件里](04-the-subagent-problem.md) · [章目录](README.md) · 下一节：[06 · 这一章花了多少钱](06-what-it-cost.md)
