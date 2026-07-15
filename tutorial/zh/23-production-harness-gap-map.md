# 23. 与生产 harness 的差距总表

第 17 章回答的是"本项目已有什么、下一步做什么"。这一章回答懂行读者的另一个问题：和 Codex CLI、Claude Code 这类生产 harness 相比，这个项目还缺哪些机制，为什么选择不做。

这是全书的"地图边缘"一章。这些缺口必须由作者先说出来，而不是留给读者自己发现——主动画出边界是可信度资产，也是这本书的方法论本身："被声明的简化"和"没意识到的遗漏"是两种完全不同的东西。下面每一条都对照过当前代码，不是从记忆里写的。

读完本章后，应该理解：

- 当前 harness 与生产 harness 的差距集中在哪几类机制
- 每个缺口在生产系统里是怎么补的
- 为什么这个项目对每个缺口的回答是"现在不做"，以及什么时候值得做
- 如果要继续加能力，推荐的顺序和理由

## 总表

| 机制 | 本项目现状 | 生产 harness 的做法 |
| --- | --- | --- |
| OS 级沙箱 | path policy + 词法级参数筛查，无内核强制 | Codex：macOS Seatbelt / Linux Landlock；Claude Code：sandbox 模式 |
| 环境上下文注入 | system prompt 是写死常量，无 cwd/日期/目录摘要 | 自动注入环境块 + AGENTS.md / CLAUDE.md 项目记忆 |
| 模型调用重试 | 429/5xx/断流直接 `run_failed` | 可重试错误分类 + 指数退避 |
| Provider 覆盖 | 仅 OpenAI 两形态；capabilities 声明了但无人消费 | 多 provider dialect，Anthropic Messages 是真正试金石 |
| MCP | source 枚举里的 `'mcp'` 是占位 | 完整 discovery/dispatch/lifecycle |
| Subagent | 无 | Claude Code Task 工具派生子任务 |
| Hooks 与持久规则 | decision source 里 `hook`/`guardian` 占位；每次 ask 单独批 | settings allowlist、"approved for session"、hook 链 |
| Prompt caching | 只被动记账 `cachedInputTokens` | cache 断点控制、稳定前缀工程 |
| Steering | 运行中无法注入新消息，取消是唯一干预 | 运行中排队/插入用户输入 |
| 其他 | 阈值写死、无 microcompact/fork/durable approvals/SSE 重连 | 见下文杂项一节 |

表格给的是索引，下面按主题展开。每条按同一结构：本项目现状 → 生产 harness 的做法 → 为什么这里不做、何时值得做。

## 1. OS 级沙箱

**现状**：这个项目的执行边界是两层叠加——文件工具走 path policy（`lib/agent-path-policy.ts`），shell 走参数级 safe-command 分类器（`lib/agent-shell-safety.ts`）加 permission 合成规则。第 18 章已经把话说透了：分类器是**词法的**，它看命令字符串长什么样，跟不进符号链接，也看不见运行时行为。`cat ./innocent.txt` 词法上干净，但如果那是指向 `/etc/passwd` 的链接，读到的还是项目外的文件。

**生产做法**：Codex 在 macOS 用 Seatbelt、Linux 用 Landlock，把文件系统和网络访问在内核层锁死——命令字符串骗得过词法分析，骗不过内核。Claude Code 也有 sandbox 模式做同类隔离。在那种架构里分类器只负责省审批，沙箱负责兜底。

**为什么不做**：OS 沙箱是平台相关的深水区（每个平台一套机制，且和教学主线无关），而"分类器省审批、permission 边界做决策、真正的执行强制缺位"这个结构本身就是要教的内容。什么时候值得做：当这个 harness 要在不受信任的输入上运行时——那一刻它就不再是可选项。

## 2. Context 组装的另一半

**现状**：`lib/agent.ts` 的 `AGENT_SYSTEM_MESSAGE` 是一个写死的字符串常量；user prompt 由 `buildAgentPrompt` 拼 Task/Goal/Context 三段，其中 Context 是**用户手动传的**，不是 runtime 采集的。没有 cwd 注入、没有当前日期、没有目录结构摘要、没有 git 状态，也没有 AGENTS.md / CLAUDE.md 式的项目记忆机制——模型对"自己在哪"的全部认知来自工具调用的探索结果。

**生产做法**：Codex 和 Claude Code 都在每个 turn 自动组装环境块（cwd、日期、平台、目录概览、git 状态），并把项目根的 AGENTS.md / CLAUDE.md 内容作为持久指令注入。这是 harness 叙事里常被忽略的另一半：工具决定模型能**做**什么，context 组装决定模型**知道**什么。

**为什么不做**：不是难，是还没轮到——教程主线先补的是行为边界（shell/approval/resume/compaction）。这也是所有缺口里**最便宜能补**的一个：一个纯函数把环境事实拼进 system message，一组测试断言注入内容，一章教程。这就是为什么它排在推荐顺序第一位。

## 3. 模型调用重试与退避

**现状**：model gateway（`lib/model-gateway.ts`）没有任何重试逻辑。429、5xx、网络断流都会一路抛到采样循环，变成终态 `run_failed` 事件。终态事件本身是完备的（这是修过的地方——run 不会静默挂着），但恢复策略为零：一次瞬时抖动就终结整个 run。

**生产做法**：生产 harness 把错误分成可重试（429、5xx、断流、超时）和不可重试（4xx 语义错误、鉴权失败），对前者做带抖动的指数退避，并把重试次数记进 telemetry。

**为什么不做**：教学上"失败要可见"比"失败要自愈"优先——重试逻辑写早了会掩盖边界问题。但这个缺口在真实使用里最先疼：长对话跑到第十轮因为一次 429 全部作废，compaction 摘要调用失败整个 run 跟着失败（第 21 章已声明）。它排在推荐顺序第二位。

## 4. Provider 覆盖

**现状**：provider-neutral 的 `AgentResponseItem` IR 只被 OpenAI 的两种 wire 形态（Chat Completions、Responses）验证过。`AgentModelCapabilities`（tools/streaming/streamingUsage/parallelToolCalls）每个 dialect 都声明了，但**当前没有任何 runtime 代码读它**——声明了的契约无人消费，这是诚实的现状。

**生产做法**：多 provider 支持不是加一个 baseURL，而是让 IR 经受结构不同的协议考验。Anthropic Messages API 是真正的试金石：content 是 block 数组而不是字符串、tool 结果作为 user 消息里的 `tool_result` block 回传、system 是顶层参数而不是 messages 里的一条。IR 里任何 OpenAI 形状的偷懒都会在这三处暴露。

**为什么不做**：两种 OpenAI 形态已经足够建立 dialect 边界的教学价值。但"provider-neutral"目前是一个未被第二方检验的主张——加 Anthropic dialect 是检验它的最短路径，排在推荐顺序第三位。

## 5. MCP

**现状**：`AgentToolSource` 枚举包含 `'mcp'`（以及 `'dynamic'`、`'hosted'`），但只有 builtin groups 是 active 的。`'mcp'` 是一个预留的类型占位，没有 discovery、没有 dispatch、没有 server lifecycle。

**生产做法**：Codex 和 Claude Code 都有完整 MCP client：启动/握手/工具枚举/调用转发/错误与超时边界，外部工具与内置工具在 permission 层同权对待。

**为什么不做**：MCP 的复杂度在协议 client 工程（进程管理、握手、能力协商），教学增量却不大——tool contract 边界已经把"工具从哪来"抽象掉了。占位枚举的存在就是设计意图的表达：接入点已经预留，需要时不用重构。

## 6. Subagent 与任务派生

**现状**：没有，明确范围外。一个 run 就是一个采样循环，没有派生子任务的机制。

**生产做法**：Claude Code 的 Task 工具可以派生独立上下文的 subagent 处理子任务，结果汇回主循环——本质是用独立 context window 换取主对话的 token 预算。

**为什么不做**：subagent 是"多个 harness 实例的编排"，在单循环还在打磨的阶段引入它只会稀释主线。等单循环的所有边界（尤其 steering 和重试）稳定后再考虑。

## 7. Hooks 与持久化用户规则

**现状**：`AgentPermissionDecisionSource` 枚举里 `hook`、`user`、`guardian` 都是占位——实际出现在决策里的只有 `annotation`、`policy`、`tool_override`。没有 settings 式 allowlist（Claude Code 的 `permissions.allow` 前缀规则），没有 "approved for session"（Codex 的 `ApprovedForSession`）：同一条命令每次触发 ask 都要重新批准。

**生产做法**：调研笔记（`docs/research-codex-claude-code.md`）记了两家的完整规则系统：Claude Code 的 deny → ask → allow 固定判定顺序加前缀通配，Codex 的 execpolicy 扩展和批准时持久化前缀规则。

**为什么不做**：规则系统的难点在**规则语言的设计**（前缀匹配的安全性、deny 不可覆盖的层级），做浅了是安全隐患，做深了是一个独立项目。当前"每次都问"烦但安全，方向正确。

## 8. Prompt caching

**现状**：两个 OpenAI dialect 都从响应里读 `cachedInputTokens` 并在 usage 汇总里记账——仅此而已。没有 cache 断点控制，没有为命中率做稳定前缀工程，也没有把命中率暴露成可观测指标。

**生产做法**：生产 harness 主动经营缓存：Anthropic 的 `cache_control` 显式断点、system prompt 与工具定义保持字节稳定、Codex 用 UUIDv5 派生 synthetic call id 就是为了不打破 cache key。长对话场景下这是数量级的成本差异。

**为什么不做**：缓存优化只有在调用量大到成本可感时才有回报，教学项目感知不到。但值得注意：第 20 章 resume 复用原 callId 的设计已经顺手保住了缓存友好性——边界画对了，后续优化不需要返工。

## 9. Steering

**现状**：run 一旦开始，用户能做的只有两件事：回应 approval 请求、取消整个 run。没有"运行中补一句话"的通道——发现模型跑偏时，唯一选项是 abort 后带着更好的 prompt 重来（resume 机制让重来不丢历史，但中间轮次的工作丢了）。

**生产做法**：Codex 支持 turn 内注入用户输入，Claude Code 允许运行中继续输入（排队为下一轮 user 消息或直接打断当前采样）。steering 是交互式 agent 的核心体验差异之一。

**为什么不做**：steering 触碰采样循环最敏感的不变量——消息注入点必须与 function_call/output 配对边界对齐，否则会撕裂 history。这个项目里它是一个真实但深的改动，值得做成一章，而不是顺手加的功能。

## 10. 杂项清单

以下缺口在各章"还没做什么"里声明过，集中列一遍：

- **Compaction 阈值写死 8000 token**（`DEFAULT_COMPACTION_TOKEN_THRESHOLD`）。这个数字远小于现代模型的 context window——对 200K 窗口的模型，它会在用掉 4% 时就触发压缩，过早丢弃可用上下文。生产做法是按模型元数据配置（Codex 的 `model_auto_compact_token_limit`）。
- **无 microcompact**。每次压缩都要多一次模型调用；Claude Code 的轻量路径（不调模型，直接置换陈旧 tool_result）没有对应实现。
- **无 session fork**。只能从最新状态续接，不能从历史中间分叉（Codex 的 `fork`）。
- **无 durable approvals**。pending approval 是进程内存，重启即拒绝——与两家生产实现一致，但它们的规则持久化（见第 7 条）缓解了重批成本，这里没有。
- **无 SSE 断线重连**。stream 断了没有 Last-Event-ID 式续传，run 的实时观察窗口一次性。
- **权限只看单个路径参数**。`AgentPermissionRequest` 只携带一个 `pathArgumentName`/`requestedPath`；未来出现 copy/move 这类双路径工具时，permission 层需要先扩展。

## 如果要继续加能力

推荐顺序及理由：

1. **环境上下文注入**——最便宜、无风险、立刻提升每一次真实使用；纯函数 + 测试 + 一章教程的标准节奏。
2. **模型调用重试**——真实使用里最先疼的缺口；错误分类本身是有教学价值的边界设计。
3. **Anthropic dialect**——检验"provider-neutral"这个核心主张的最短路径；顺手让 capabilities 声明第一次被 runtime 消费。
4. **OS 沙箱**——在前三项让 harness 值得日常使用之后，安全边界从教学声明升级为内核强制。
5. **MCP**——工具生态的接入点，占位枚举兑现之时。

顺序的逻辑：先补"让它好用"的（1、2），再补"检验核心主张"的（3），再补"让它可信"的（4），最后是"让它开放"的（5）。每一步都遵守第 17 章的纪律：定义边界、暴露数据流、写真实测试、更新教程。

## 本章小结

这一章不是道歉清单，是边界地图。每个缺口都有三个坐标：本项目停在哪、生产系统走到哪、为什么这里选择停下。一个教学 harness 的价值不在于假装完整，而在于每一处不完整都被声明、被解释、被标注了升级路径——读者带着这张地图去读 Codex 和 Claude Code 的源码时，知道该看什么。
