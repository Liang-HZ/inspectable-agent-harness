# 08. Provider Dialect Boundary

本章说明为什么 agent runtime 不能直接绑定 OpenAI Chat 或 Responses 的 wire format。Provider dialect 把外部协议转换成内部稳定模型，让 agent loop 保持模型供应商无关。

读完本章后，应该理解：

- Model IR 是什么
- dialect contract 如何隔离 provider 差异
- 工具 schema 为什么应该从 agent 自己的契约编译出来
- 为什么 Anthropic 适配可以推迟，但边界必须现在存在

## 背景

Runtime 最开始偏向 OpenAI Chat Completions shape。这个方向无法支撑多个 wire API。

OpenAI Chat Completions、OpenAI Responses 和未来 Anthropic API 在这些方面不同：

- request body shape
- tool schema shape
- streaming event names
- tool-call delta format
- usage fields
- assistant message commit points

Agent loop 不应该知道这些差异。

## Model IR

项目引入 provider-neutral model types：

```text
AgentModelMessage
AgentModelToolDefinition
AgentModelToolCall
AgentModelRequest
AgentModelResponse
AgentModelStreamEvent
AgentModelUsageSnapshot
```

它们位于：

```text
lib/agent-model-types.ts
```

## Dialect Contract

Dialect interface 位于：

```text
lib/model-provider-dialect.ts
```

已实现 dialects：

```text
lib/openai-chat-completions-dialect.ts
lib/openai-responses-dialect.ts
```

Gateway 选择 dialect：

```text
lib/model-gateway.ts
```

## 数据库类比

这个设计类似 SQL dialect：

```text
Runtime IR -> Dialect -> Provider wire format
```

Agent loop 像 query planner。Dialect 像 SQL compiler。Provider quirks 留在 compiler 后面。

## Tool Schema Boundary

Agent tools 使用 provider-neutral `inputSchema` 和 `schemaStrict`。

OpenAI dialect 把它编译成 OpenAI 需要的 wire schema。未来 Anthropic dialect 应该做 Anthropic 对应的转换。

## 重要规则

`lib/agent.ts` 不应该 import provider SDK wire types，例如：

```text
ChatCompletionMessage
ResponseStreamEvent
```

如果这些类型出现在 agent loop，说明 dialect boundary 泄漏了。

## Git 证据

相关提交：

```text
837f89f Add provider dialect architecture
```

## 为什么推迟 Anthropic

架构已经为 Anthropic 做准备，但 runtime 需要先变强：

- model-visible history
- streaming commit semantics
- real tools
- debug visibility
- tests

在这些稳定前增加另一个 provider 会放大不确定性。

## 常见误解

### 误解一：现在只接 OpenAI，所以不需要 dialect

即使只在 OpenAI 内部，Chat Completions 和 Responses 也已经是两种不同协议。Dialect 不是为了抽象而抽象，而是为了让 agent loop 不关心 wire format。

### 误解二：工具定义可以直接用 OpenAI schema 当内部格式

OpenAI strict schema 有自己的限制。内部工具契约应该表达 agent runtime 的真实语义，再由 OpenAI dialect 编译成 OpenAI 需要的 schema。

### 误解三：新增 provider 只需要换 URL

不同 provider 的 message、tool call、stream event、usage 和 stop reason 都可能不同。真正可扩展的是 dialect boundary，不是 baseURL。

## 本章小结

这一章把 provider 差异隔离到 dialect 层：runtime 使用稳定 IR，dialect 负责编译 request、解析 stream、转换 tool schema 和 usage。

## 本章验证点

验证 dialect 层的两条硬规则：tool schema 由 dialect 编译；agent loop 不 import provider wire types。

1. OpenAI strict tool schema 编译测试（无需 key）：

```bash
npx tsx --test tests/openai-tool-schema.test.ts
```

实测输出：

```text
✔ OpenAI strict tool schema marks every property as required
✔ OpenAI strict tool schema represents optional properties with null type
ℹ pass 2
```

这两个用例证明的正是本章的 Tool Schema Boundary：内部 `inputSchema` 是 provider-neutral 的，strict 模式下"全字段 required、可选字段用 null type 表达"由 OpenAI dialect 编译出来，而不是写进工具契约本身。

2. 检查 boundary 没有泄漏（实测无输出，命令退出码为 1 即通过）：

```bash
grep -n "ChatCompletionMessage\|ResponseStreamEvent" lib/agent.ts
```

如果这条 grep 有输出，按本章"重要规则"，说明 dialect boundary 已经泄漏进 agent loop。
