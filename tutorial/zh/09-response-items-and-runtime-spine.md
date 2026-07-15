# 09. Response Items 与 Runtime Spine

本章说明 agent loop 如何从前端教学 steps 迁移到真正的模型可见 history。`AgentResponseItem` 是 runtime spine 的核心数据结构。

读完本章后，应该理解：

- response item 为什么比 UI step 更基础
- runtime spine 如何组织 model -> tool -> model 的循环
- scheduler 为什么要独立出来
- assistant runtime role 如何区分过程文本和最终输出

## 背景

早期 agent 有 steps 和 logs，但还缺少精确的模型可见 history。

真正 tool loop 需要让模型看到：

```text
assistant requested tool
tool returned output
assistant continues from that output
```

UI steps 不够。Runtime 需要 history items。

## AgentResponseItem

关键文件：

```text
lib/agent-response-items.ts
```

核心 union：

```ts
type AgentResponseItem =
  | { type: 'message'; role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { type: 'function_call_output'; callId: string; toolName: string; output: string; isError: boolean };
```

这是教学简化版：真实的 `message` 分支还有 `providerPhase`、`runtimeRole` 等可选字段（后续章节会引入），完整形态见 `lib/agent-response-items.ts`。

这是模型可见 history，独立于 frontend display。

## Runtime Spine

固定教学 flow 被替换成：

```text
initialize history
call model with history and tools
commit assistant message / function calls
execute tool batch
append function_call_output
repeat until no tool calls
```

主文件：

```text
lib/agent.ts
```

## Scheduler

Scheduler 位于：

```text
lib/agent-tool-scheduler.ts
```

它决定：

```text
all tools parallel-capable -> Promise.all
otherwise                 -> sequential
```

它不推断数据依赖。如果模型需要 tool B 依赖 tool A，就应该在 A 的 output 进入 history 后，在下一轮 sampling round 请求 B。

## Assistant Runtime Roles

Assistant messages 可以成为：

```text
working_message
final_response
```

这是 agent-level classification，不等同于 provider phase metadata。

## Git 证据

相关提交：

```text
e6ff55e Add agent runtime spine
```

## 为什么这是转折点

这一阶段让系统开始像 agent runtime，而不是“能调用工具的 service”。事实来源从 display steps 移到了 model-visible history。

## 常见误解

### 误解一：UI step 可以直接当模型 history

UI step 是展示结构，model history 是协议结构。二者目标不同，不能混用。

### 误解二：runtime spine 就是 agent loop 的全部

Runtime spine 是 loop 的骨架，但完整 run 还包括输入、事件、session、取消、调试和最终响应。

### 误解三：assistant text 不需要角色

同样是 assistant text，在工具前可能是 working message，在没有工具时可能是 final response。Runtime role 让 UI 和 debug 能表达这种差异。

## 本章小结

这一章把 agent 从 step-driven 推进到 history-driven：模型可见 response item 成为事实来源，scheduler 控制轮次，runtime spine 串起模型调用和工具执行。
