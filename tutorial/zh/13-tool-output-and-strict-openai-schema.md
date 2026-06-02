# 13. Tool Output 与 OpenAI Strict Schema

本章说明工具结果应该如何同时服务模型、前端 debug 和 runtime telemetry。核心原则是：模型看到文本，runtime 保留结构化 metadata。

读完本章后，应该理解：

- tool output 的内部契约和模型可见内容为什么要分开
- 错误为什么可以写入 history，但 fatal error 不应该伪装成工具结果
- timeout 与 abort 应该怎样进入统一输出路径
- OpenAI strict schema 为什么会影响 optional 参数表达

## 背景

真实工具带来两个实践问题：

1. Tool 内部到底返回什么？
2. OpenAI strict function calling 应该收到什么 schema？

这两个问题都会影响生产行为。

## Tool Output Contract

项目引入：

```text
lib/agent-tool-output.ts
```

内部 output shape：

```ts
type AgentToolOutput =
  | { type: 'success'; contentText: string; details?: unknown; notice?: string; truncated?: boolean }
  | { type: 'respond_to_model'; error: AgentToolError; details?: unknown }
  | { type: 'fatal'; error: AgentToolError; details?: unknown };
```

## Model-Visible Serialization

模型不会收到这个 envelope。

模型收到 plain text：

```text
success:
  contentText
  [optional notice]

respond_to_model:
  Error [CODE]: message

fatal:
  no function_call_output; stop the run
```

这样模型输入保持可读，同时 logs、debug UI 和未来 telemetry 保留 structured details。

## Timeout And Abort

Runtime 把 timeout 和 abort 转换成 recoverable model-visible tool outputs：

```text
Error [TIMEOUT]: ...
Error [ABORTED]: ...
```

这让模型知道工具没有完成。

## OpenAI Strict Schema 问题

第一次用真实工具跑前端时遇到 upstream error：

```text
Invalid schema for function 'read': ... 'required' is required ...
```

OpenAI strict tools 要求每个 property 都出现在 `required` 中。Optional fields 必须用允许 `null` 表示。

## 正确修复边界

修复属于：

```text
lib/openai-tool-schema.ts
```

而不是 agent-owned tool contract。

Agent tool 可以表达：

```text
path required
offset optional
limit optional
```

OpenAI adapter 编译成：

```text
required: ['path', 'offset', 'limit']
offset.type = ['number', 'null']
limit.type = ['number', 'null']
```

Runtime Zod parser 接受 strict-mode optional fields 的 `null`，并 normalize 为 `undefined`。

## Git 证据

相关提交：

```text
ec40dc3 Add structured tool output contract
```

Strict schema fix 和 tests 来自这层后第一次真实 frontend run。

## Tests

相关 tests：

```text
tests/openai-tool-schema.test.ts
tests/agent-builtins.test.ts
tests/agent-sampling-loop.test.ts
```

## 常见误解

### 误解一：工具应该把 JSON envelope 直接给模型

模型通常更适合读简洁文本。`ok`、`metadata`、duration、truncation details 适合 runtime 和 debug，不一定适合进入模型上下文。

### 误解二：错误都应该抛 fatal

可恢复错误应该写成 tool output 让模型看到，例如路径不存在或 validation 失败。Fatal 只用于 runtime 无法继续的错误。

### 误解三：OpenAI strict schema 只是 provider 小细节

Strict schema 会影响工具参数怎么声明。内部契约必须能表达 optional，但 OpenAI wire schema 可能需要用 required + nullable 编译出来。

## 本章小结

这一章把 tool output 分成两层：模型可见文本和 runtime/debug metadata。它同时修正了 timeout、abort、错误序列化和 OpenAI strict schema 的边界。
