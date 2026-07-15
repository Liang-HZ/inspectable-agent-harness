# 10. 流式采样与提交语义

本章解释 agent loop 里最容易混淆的一层：模型输出可以边生成边展示，但这段输出到底是“过程说明”还是“最终答案”，必须等本轮模型调用结束后才能确定。

读完本章后，应该理解四件事：

- `sampling round` 和 `sampling loop` 分别是什么意思
- 为什么流式文本不能一开始就标记为最终答案
- provider 的 `final_answer` 元数据为什么不能直接等同于 agent 最终答案
- 前端为什么需要先展示 live text，再在 commit 后重新归类

## 问题背景

前一阶段已经有了 provider-neutral 的 runtime spine：模型可以请求工具，runtime 执行工具，再把工具结果写回 history，继续下一轮模型调用。

新的问题出现在流式输出上。

模型生成文本时，前端希望立即看到内容；但在同一轮输出的后半段，模型可能又请求工具。于是这一轮早先流出来的文本就不是最终答案，而是工具调用前的工作说明。

因此 runtime 需要区分两个时刻：

```text
stream time  -> 文本正在到达，只能先展示
commit time  -> 本轮模型调用结束，可以判断它的语义
```

## 术语

本项目使用两个词：

```text
sampling round = 一次模型生成调用
sampling loop  = 多次模型生成调用 + 工具执行
```

也就是说：

- 一次 `sampling round` 对应一次 provider API 调用
- 一次 `sampling loop` 可能包含多次 round
- agent run 包含 sampling loop，但还包括输入解析、事件投影、session 写入、取消处理和最终响应组装

这个命名来自模型推理领域里“从模型分布中采样生成下一个输出”的语义。在 agent 里，它更具体地表示“一次模型生成步骤”。

## 核心事件

不同 provider 的流式协议不一样。Runtime 不直接依赖 provider 原始事件，而是先通过 dialect 转成内部事件：

```text
text_delta
assistant_message_done
tool_call_delta
tool_call_committed
completed
```

这些事件的职责不同：

```text
text_delta              -> 临时文本增量，可立即展示
assistant_message_done  -> assistant message 已完整提交
tool_call_delta         -> 工具参数仍在流式拼接
tool_call_committed     -> 工具调用已完整，可以执行
completed               -> 本轮 provider response 完成，带 usage 等收尾信息
```

这里最关键的是：`text_delta` 是临时的，`assistant_message_done` 和 `tool_call_committed` 才是提交点。

## 数据流

一轮 sampling 的数据流可以写成：

```text
provider stream
  -> dialect converts provider events
  -> runtime emits assistant_delta for live UI
  -> dialect commits assistant message / tool calls
  -> sampling round completes
  -> runtime decides whether tools are needed
```

决策规则是：

```text
if 本轮 committed tool calls 不为空:
  本轮 assistant text = working message
  tool calls 写入 model-visible history
  执行工具
  tool outputs 写入 model-visible history
  进入下一轮 sampling
else:
  本轮 assistant text = final response
  agent run 完成
```

这就是“先流式展示，后提交归类”的核心。

## OpenAI Chat 与 Responses 的差异

OpenAI Chat Completions 的流式事件大致映射为：

```text
delta.content                 -> text_delta
stream end                    -> assistant_message_done
delta.tool_calls reconstruction -> tool_call_committed
```

OpenAI Responses 的流式事件大致映射为：

```text
response.output_text.delta             -> text_delta
response.output_item.done(message)     -> assistant_message_done
response.output_item.done(function_call) -> tool_call_committed
response.completed                     -> completed
```

这两个 provider mode 的 wire format 不一样，但 runtime 看到的是同一组内部事件。这样 agent loop 不需要知道当前模型来自 Chat Completions 还是 Responses。

## Provider Finality 不是 Agent Finality

Responses 里可能有类似 `phase: final_answer` 的字段。这个字段可以说明 provider 如何分类单条 message，但它不能直接决定整个 agent run 是否结束。

Agent 层面的停止条件更简单，也更稳定：

```text
本轮模型调用完成，并且没有提交任何工具调用
```

原因是 agent finality 属于 runtime 语义，而不是单条 provider message 的格式语义。

一个 provider 可以把某条 message 标成 final，但如果同一轮或后续状态仍然涉及工具、history 修正或 runtime 错误，agent 仍然需要按自己的 loop 规则处理。

## 前端展示语义

前端需要支持两个阶段：

```text
live stage:
  追加显示 assistant_delta

commit stage:
  根据本轮是否请求工具，把文本归类为 working message 或 final response
```

这解释了为什么早期 UI 会出现“文本先显示，随后被替换或重排”的感觉。问题不在流式本身，而在 UI 用内部 round 结构重建展示。后来 Agent 页面的展示改成按用户可见流程串联：

```text
assistant text
tool batch
assistant final answer
```

调试页面仍然可以保留 round、request、response、usage 等底层信息，因为它面向开发者。

## Git 证据

相关提交：

```text
34e2d5c Add streaming agent sampling loop
```

它把 agent loop 推进到真正流式的 sampling 结构：文本增量即时投影到前端，assistant message 和 tool call 在 round 完成后提交，最终答案由“没有工具调用的完成轮次”决定。

## 常见误解

### 误解一：没有工具调用的 assistant message 一定是最终答案

在本项目的 agent loop 中，结束判断确实是“完成轮次没有工具调用”。但这不是随便看某个中间 partial message，而是看 committed sampling round 的结果。

### 误解二：provider 的 `final_answer` 就是 agent 的 final answer

Provider 的 `final_answer` 是 provider message 级别的元数据。Agent 的 final answer 是 runtime loop 级别的结果。两者可能一致，但不能混为一谈。

### 误解三：流式输出一定能马上知道最终语义

不能。流式刚开始时只知道“模型正在输出文本”，不知道后面是否会继续请求工具。最终语义必须等 round commit 后判断。

## 本章小结

这一章建立了真正 agent streaming 的关键规则：

- `text_delta` 先用于 live UI
- committed assistant message 才写入 history
- committed tool call 才触发工具执行
- 没有工具调用的 completed round 才产生 final response
- provider dialect 负责格式转换，agent loop 负责语义判断

这个设计让过程输出可以真正流式，同时保留确定性的工具执行和最终答案判断。

## 本章验证点

验证 commit 语义的两条规则：没有提交点的 delta 是协议错误；没有工具调用的完成轮次才产生最终答案。以下命令都无需 key。

1. 协议错误用例——delta 缺少 commit 必须报错：

```bash
npx tsx --test --test-name-pattern "commit|deltas" tests/agent-sampling-loop.test.ts
```

实测输出：

```text
✔ rejects streamed text without an assistant message commit
✔ rejects tool argument deltas without a completed tool call
ℹ pass 2
```

2. 最终答案判定用例——无工具调用的完成轮次即 final response：

```bash
npx tsx --test --test-name-pattern "no-tool" tests/agent-sampling-loop.test.ts
```

实测输出：`✔ uses a no-tool assistant message as the final response`，`pass 1`。

这三个用例分别对应本章的提交点规则（`assistant_message_done` / `tool_call_committed`）和 agent finality 规则。
