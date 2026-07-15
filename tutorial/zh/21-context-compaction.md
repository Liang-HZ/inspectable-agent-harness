# 21. Context Compaction

本章解释 harness 如何在对话变长之后，把发给模型的历史从"线性增长直到超限"变成"到达阈值就自动压缩，继续对话"。这是上一章 session resume 留下的明确缺口——resume 只解决了"如何找回历史"，没有解决"历史太长怎么办"。

读完本章后，应该理解：

- 为什么这个项目选择"完全替换"而不是"逐条裁剪"式压缩
- 压缩为什么必须复用同一个 model gateway，而不是新开一条调用路径
- 为什么 function_call/function_call_output 的配对不变量在这里几乎是免费的
- 压缩发生在 loop 的哪个边界，为什么必须是那个边界
- 为什么这不是一个可以直接套用到生产环境的阈值设计

## 背景

第 20 章让同一个 session 可以被多次继续，但 resume 的实现原则是"把重建的完整历史原样发给模型"。这在两三轮对话内没问题，但轮数一多，`responseItemsToModelMessages(history)` 产生的 messages 数组会线性增长，迟早超过模型的 context window，或者在到达上限前就已经把大部分 token 花在陈旧的工具输出上。

调研 Codex 和 Claude Code(见 [`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))发现两者做法不同但目标一致：

- Codex 的策略是**完全替换**:`initial_context + 最近的原始 user messages(预算内逆序回填)+ 一条 summary 消息`，由 `model_auto_compact_token_limit` 触发，支持 mid-turn compaction。
- Claude Code 有两层：轻量的 microcompact(不调模型，直接丢弃陈旧 tool_result 大块)和调模型生成九段式摘要的 full compact，在 ~92% context window 触发。

这个项目选择 Codex 的"完全替换"策略，原因很直接：这个项目的 `AgentResponseItem` 历史结构比 Claude Code 的 tool_use/tool_result 块结构更接近 Codex 的 response-item 模型，复用第 20 章 resume 时已经建立的"哪些内容值得单独保留"的判断(system message、最近的 user 消息)比再发明一套 microcompact 规则更省心。

## 设计选择

### 阈值判断：只在有真实 usage 数据时触发

`lib/agent-compaction.ts` 的 `decideAgentHistoryCompaction`:

```text
tokenUsage === null           -> 不压缩(provider 没报 usage,没法判断)
totalTokens < threshold       -> 不压缩
history.length < 4            -> 不压缩(system+user 两条都不到,没什么可压的)
否则                           -> 压缩,原因里带上具体的 token 数字
```

`tokenUsage` 可能是 `null`——不是所有 provider 都会在每次响应里报告 usage，流式响应的中间事件更是经常没有。这个项目选择在没有数据时**跳过检查而不是猜测**，这是一个保守选择：错过一次压缩机会，好过基于错误估算做出压缩决策。

默认阈值 `DEFAULT_COMPACTION_TOKEN_THRESHOLD = 8000` 是一个教学尺寸的常量，不是从任何模型的真实 context window 反推出来的——这个项目目前没有追踪"当前模型的 context window 有多大"这类元数据(`ModelConfig` 只有 `apiKey`/`baseURL`/`model`/`wireApi`)。生产环境需要按模型配置这个阈值，这里先用一个固定值把机制跑通。

### 压缩内容：完全替换，不是裁剪

`applyAgentHistoryCompaction` 的输出规则：

```text
保留:      history 开头的 system message(如果有)
新增:      一条 compaction_summary 消息,内容是模型生成的摘要
保留:      最近的 user 消息,从最新往旧回填,预算 20000 字符
丢弃:      所有 assistant 消息、function_call、function_call_output
```

`assistant`/`function_call`/`function_call_output` 全部被摘要吸收，不再单独保留在压缩后的历史里。这是有意的简化：比起挑选"哪些工具调用值得保留原文"，让模型把它们浓缩进摘要文字更符合这个项目的教学尺寸，也避免了"部分保留工具调用历史"可能引入的复杂裁剪逻辑。

保留最近 user 消息的理由是：**用户原始意图不应该经过摘要转述再传给模型**。摘要是压缩层对历史的复述，原始的 user 消息是压缩层不应该改写的输入。这个预算逻辑和第 20 章 resume 时"保留最近 user 消息"的做法几乎一样，复用了同一个判断。

### function_call/function_call_output 配对为什么几乎不用担心

第 20 章的 resume 需要专门写 `normalizeAgentResponseItemHistory` 来处理"有 call 没 output"的孤儿。压缩这里不需要——因为压缩的规则是"要么整段留下(summary + user messages)，要么整段丢弃(所有 function_call/function_call_output)"，没有"留一半"的情况。测试
（[`tests/agent-compaction.test.ts`](../../tests/agent-compaction.test.ts) 的 "never leaves an orphan function_call behind"）直接断言压缩后的历史里不存在任何 `function_call`。

### 压缩摘要请求复用同一个 model gateway

`buildCompactionSummaryRequest` 构造一个不带 tools 的请求(`tools: [], toolChoice: 'none'`)，系统指令要求模型输出一段"保留用户目标、关键决策、涉及文件、已完成/未完成工作、遇到的错误"的摘要，不要加"这是摘要"这类开场白。

调用方式是 `modelGateway.createResponse(...)`——非流式的那个方法，因为压缩摘要不需要像正常轮次那样把 delta 推给用户，只需要一次性拿到最终文本。这个方法一直存在于 `AgentModelGateway` 接口里(`lib/model-gateway.ts`)，但直到这一章才第一次被使用。

### 压缩发生在哪个边界

`runSamplingLoop` 里，压缩检查放在**一轮完整结束之后、下一轮开始之前**:

```text
round N 完成
  -> 提交 working message + function_call
  -> 执行工具
  -> 提交 function_call_output
  -> [压缩检查在这里]
round N+1 开始
```

这个位置是唯一安全的位置。压缩检查绝不会在一轮的中途触发——不会在模型还没决定要不要调用工具时压缩，也不会在工具已经被调用但输出还没写回时压缩。这保证了压缩永远看到的是一个"完整提交"的历史，不会撕裂正在进行中的 tool_call/output 配对。

触发压缩用的 `tokenUsage` 是**刚结束的那一轮**报告的 usage，不是压缩前瞬时再测一次——这样压缩决策和"为什么触发"的原因文案(`Reported token usage {n} reached the compaction threshold {threshold}`)是完全对应的，可审计。

### 压缩后立即持久化，但只写新增的一条

压缩替换了内存里的 `history` 数组内容(`history.length = 0; history.push(...)`)，但写回 JSONL 时只 `appendAgentResponseItem` 那一条新的 `compaction_summary` 记录——被丢弃的旧 `assistant`/`function_call`/`function_call_output` 记录早就在提交时写过一次了，JSONL 依然是完整的 append-only 审计轨迹，只是内存里代表"发给模型的当前历史"变短了。这和第 20 章"只追加新内容"的设计原则完全一致。

## 事件与前端

新增内部事件 `history_compacted`，投影为一等的 debug 事件 `historyCompacted`(不是主链路事件——压缩不需要用户决策，只需要可观测)。Debug Console 新增一个 "Compactions" 统计格和专门的卡片区，展示每次压缩的 token 数、移除/保留的条目数、触发原因，以及一个可展开的 "Summary sent to the model" 详情。

## 权限与数据流矩阵

| 场景 | tokenUsage | history 长度 | 结果 |
| --- | --- | --- | --- |
| Provider 没报 usage | `null` | 任意 | 不检查 |
| 低于阈值 | 数字 < threshold | 任意 | 不压缩 |
| 历史太短 | 任意 | < 4 条 | 不压缩(没什么可压) |
| 达到阈值且历史够长 | 数字 >= threshold | >= 4 条 | 压缩：调用 createResponse 生成摘要，替换 history，持久化摘要，发 `history_compacted` |

## 还没做什么

- **阈值是固定常量，不是按模型配置的。** 生产环境需要为不同模型的真实 context window 配置不同阈值；这个项目目前没有存储这类元数据的地方。
- **没有 microcompact。** Claude Code 那种"不调模型、直接丢弃陈旧 tool_result 大块"的轻量路径没有实现——这个项目的压缩总是需要一次额外的模型调用。
- **摘要生成失败没有重试或降级。** 如果 `createResponse` 抛错，整个 run 会失败；没有 Claude Code 式的"连续失败 N 次就停用 auto-compact"熔断器。
- **assistant 消息和工具调用细节压缩后不可恢复。** 一旦压缩，原始的工具调用参数和输出只存在于 JSONL 的历史记录里，不会再出现在模型看到的上下文中——如果后续对话需要引用某次具体的工具调用细节，只能靠摘要里提到的内容。

## 哪些测试证明它

- [`tests/agent-compaction.test.ts`](../../tests/agent-compaction.test.ts):`decideAgentHistoryCompaction` 的 null/低于阈值/历史太短/触发四种路径；`serializeAgentHistoryForSummaryPrompt` 对每种 item 类型的渲染；`buildCompactionSummaryRequest` 不带 tools;`applyAgentHistoryCompaction` 保留 system+summary+近期 user、不留孤儿 function_call、预算内保底保留最新 user 消息、预算耗尽丢弃更旧的、没有 leading system message 时依然工作
- [`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts) 新增集成测试：usage 报告达到阈值后，`runSamplingLoop` 真的调用了 `createResponse`，历史被替换，`history_compacted` 事件正确记录 token 数和摘要文本，**下一轮**的 `streamResponse` 请求收到的确实是压缩后的 messages 数量(3 条，而不是压缩前的 4 条)
- Debug Console 的可视化通过临时注入假状态手动验证(截图记录):Compaction 卡片正确展示 token 数、移除/保留计数、原因和可展开摘要

## 本章小结

Context compaction 的核心工作不是"写一个通用摘要引擎"，而是三个边界判断：什么时候触发(有真实 usage 数据且过了阈值)、压缩之后留下什么(system + summary + 预算内的近期 user 消息，其余全部吸收进摘要)、以及在哪个安全点触发(两轮之间，永远不撕裂进行中的工具调用)。这三处判断做对了，配对不变量和持久化正确性几乎是自动满足的。
