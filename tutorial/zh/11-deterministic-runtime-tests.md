# 11. Deterministic Runtime Tests

本章说明为什么 agent runtime 需要不依赖真实模型的确定性测试。模型调用可以验证集成，但不能作为 runtime 语义的唯一证明。

读完本章后，应该理解：

- fake model gateway 为什么是测试基础设施
- 哪些 loop 行为必须用真测试覆盖
- 为什么测试应该断言 history、tool call 和 final response
- 真实工具集成测试与 fake gateway 测试分别解决什么

## 背景

如果每个测试都调用真实模型，agent 行为很难测试。

Runtime 需要不依赖这些因素的测试：

- 网络可用性
- provider behavior
- model randomness
- API keys

## Fake Gateway

`tests/agent-sampling-loop.test.ts` 创建 fake `AgentModelGateway`。

Fake gateway 返回脚本化的 `AgentModelStreamEvent[]` rounds。

这让测试可以精确断言：

- no-tool final answers
- tool calls
- tool outputs
- malformed provider streams
- recoverable tool errors
- repeated-call guardrails

## 测试证明什么

关键 case：

```text
no tool call
  -> assistant message becomes final_response

tool call
  -> assistant message becomes working_message
  -> function_call is written
  -> function_call_output is written
  -> later no-tool message becomes final_response

text_delta without assistant_message_done
  -> protocol error

tool_call_delta without tool_call_committed
  -> protocol error
```

## 为什么重要

这些不是 helper function unit tests，而是 runtime 最重要 invariant 的 contract tests：

```text
provider stream -> sampling round result -> model-visible history
```

## 真实工具集成

真实 read-only tools 加入后，sampling-loop tests 更新为 fake model 请求 `read`，然后真实 tool runtime 执行它。

这证明链路：

```text
fake model tool call
  -> permission/runtime boundary
  -> concrete built-in tool
  -> function_call_output history
```

## Git 证据

相关提交：

```text
f8652ee Add deterministic sampling loop tests
```

## 测试哲学

项目避免永远不会失败的假测试。测试应该锁定具体 history shape 和 error message。发现 runtime bug 时，第一步应该是写可复现测试。

## 常见误解

### 误解一：agent 行为没法稳定测试

模型智能不可预测，但 runtime contract 可以稳定测试。Fake gateway 固定模型事件后，loop、history、tool execution 和 final response 都可以断言。

### 误解二：只跑真实 provider 更可靠

真实 provider 测试容易受网络、额度、模型版本和中转站影响。它适合冒烟测试，不适合作为 runtime 语义的主要保障。

### 误解三：测试只需要覆盖成功路径

Agent runtime 的关键风险常在错误路径：工具失败、取消、重复调用、没有 committed message、schema 不合法。这些都应该被确定性测试覆盖。

## 本章小结

这一章建立了 agent runtime 的测试地基：用 fake gateway 固定模型行为，用真实工具测试验证集成，用断言证明 loop 语义而不是模型质量。
