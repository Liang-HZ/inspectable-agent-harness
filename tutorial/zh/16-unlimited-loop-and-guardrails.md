# 16. Unlimited Loop 与 Guardrails

本章说明为什么固定最大轮数不是生产级 agent 的好边界，以及如何在取消轮数上限后仍然防止重复工具循环。

读完本章后，应该理解：

- 为什么 `maximum tool rounds: 5` 会误伤真实任务
- unlimited loop 仍然需要停止条件
- repeated call signature 如何识别重复循环
- 为什么 fatal stop 前要先提交可见输出

## 背景

真实使用时，agent 遇到：

```text
Agent exceeded maximum tool rounds: 5.
```

这个失败不对。五轮对 coding-agent task 来说可能很正常。

项目移除了固定轮数上限，但仍然需要处理幻觉导致的无限工具循环。

## 设计选择

移除 global round cap。

增加 narrow repeated-tool-call guard。

现在 loop 停止条件是：

- completed sampling round 没有 tool calls
- end-user abort
- fatal runtime error
- same tool call with same output 重复过多

## Repeated Call Signature

Guard 不用 hash。

它比较：

```text
tool name
normalized JSON arguments
model-visible tool output
```

Arguments 会解析 `argumentsJson`，然后用 key 排序的 stable stringify。

下面两份参数会被视为相同：

```json
{"path":"a.ts","limit":20}
{"limit":20,"path":"a.ts"}
```

## Input/Output Matching

Guard 用 `toolCallId` 匹配 tool requests 和 tool executions，而不是数组位置。

所以并行工具执行不会破坏匹配。

## Output Commit Before Fatal Stop

如果 repeated-call guard 触发，runtime 会先把当前 `function_call_output` append 到 history，然后再停止。

这保持了不变量：

```text
function_call -> function_call_output
```

这个不变量对未来 resume/replay 很重要。

## Self-Inspection

当前 read tool 可以读取定义 read tool 的源码文件：

```text
lib/agent-builtins.ts
```

这不是反射，而是通过 current project path policy 的普通文件访问。这意味着 agent 可以检查 runtime source code，是一种有用的诊断能力。

## Tests

`tests/agent-sampling-loop.test.ts` 验证：

- 超过五个 tool rounds 可以完成
- repeated identical `read` calls 会以 `REPEATED_TOOL_CALL` 停止
- fatal stop 前 tool output 仍然会 commit

## 当前状态

这一层移除了人为轮数上限，把安全兜底换成 runtime guardrails：abort、fatal error、no-tool completion 和 repeated-call guard 共同决定循环何时结束。

## 常见误解

### 误解一：unlimited 就是不设任何保护

Unlimited 只是不设人为轮数上限。Runtime 仍然有 abort、fatal error、no-tool completion 和 repeated-call guard。

### 误解二：判断重复只看工具名就够了

不够。重复签名需要包含工具名、输入和输出。否则同一个工具处理不同文件会被误判。

### 误解三：触发 guard 时可以直接丢弃最后一次输出

不应该。模型和 debug 都需要看到最后一次工具结果，然后 runtime 再报告 fatal stop。

## 本章小结

这一章把 agent loop 从教学限制推进到更真实的运行方式：不再用固定轮数截断任务，而是用语义化停止条件和重复调用 guard 控制失控循环。

## 本章验证点

repeated-call guard 有一条可以单独点名运行的用例，不需要 key：

```bash
npx tsx --test --test-name-pattern "repeated" tests/agent-sampling-loop.test.ts
```

实测输出：

```text
✔ stops repeated identical tool-call loops without a global round limit (10.282708ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

用例名本身就是本章的设计声明：没有全局轮数上限（同文件里的 `allows more than five tool rounds before the final response` 证明超过五轮可以正常完成），但同名、同参数、同输出的重复调用会以 `REPEATED_TOOL_CALL` 停止，且最后一次 tool output 在 fatal stop 之前仍然被提交进 history。
