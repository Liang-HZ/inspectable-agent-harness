# 构建一个可检查的 Agent Harness

这套教程按项目真实演化路径重建当前 runtime。它基于 git 历史、当前工作区，以及已经沉淀到代码里的设计取舍。

它不是源码索引，而是解释：为什么代码会被拆成现在这些边界。

English mirror: [../en/README.md](../en/README.md)

## 章节地图

| 章节 | 主题 | 为什么存在 |
| --- | --- | --- |
| [00](00-environment-and-first-run.md) | 环境准备与第一次跑通 | 面向跨行读者：装好环境、拿到 API key、在界面和 curl 上第一次跑通 Chat 和 Agent。 |
| [01](01-project-starting-point.md) | 项目起点与约束 | 建立学习型 repo、显式代码风格和最小可运行 API 路径。 |
| [02](02-api-contracts-and-validation.md) | API contract 与 validation | 在 agent 复杂度出现前，让 HTTP、DTO、config、service 边界清晰。 |
| [03](03-living-architecture-and-workbench.md) | Living architecture 与 workbench | 让项目在成长过程中持续解释自己。 |
| [04](04-first-agent-and-observability.md) | 第一个 agent 与 observability | 加入 `/api/agent`、steps、结构化日志和第一条可检查工具链路。 |
| [05](05-streaming-cancellation-and-events.md) | Streaming、取消与 events | 把 agent 变成 live run，并加入 abort 与内部 runtime events。 |
| [06](06-tool-runtime-and-permission-skeleton.md) | Tool runtime 与 permission skeleton | 在添加高风险工具前，把执行放进 runtime boundary。 |
| [07](07-jsonl-sessions-and-usage.md) | JSONL sessions 与 usage | 持久化 run，并区分 raw provider usage 和 normalized totals。 |
| [08](08-provider-dialect-boundary.md) | Provider dialect boundary | 让 OpenAI Chat/Responses 的差异不要泄漏进 agent loop。 |
| [09](09-response-items-and-runtime-spine.md) | Response items 与 runtime spine | 用 provider-neutral 模型可见 history 替换固定教学 steps。 |
| [10](10-streaming-sampling-and-commit-semantics.md) | Streaming sampling 与 commit 语义 | 解释 delta、committed assistant message、tool call 和 final answer 判断。 |
| [11](11-deterministic-runtime-tests.md) | Deterministic runtime tests | 不调用真实 provider 也能证明 loop 行为。 |
| [12](12-real-readonly-tools.md) | 真实只读工具 | 用 `ls`、`find`、`grep`、`read` 替换 toy capability。 |
| [13](13-tool-output-and-strict-openai-schema.md) | Tool output 与 OpenAI strict schema | 分离内部 metadata 与模型可见文本，并处理 OpenAI strict schema。 |
| [14](14-debug-console-and-session-viewer.md) | Debug Console 与 session viewer | 拆分最终用户 transcript、runtime debug 和 persisted JSONL 视图。 |
| [15](15-tool-contract-boundary-and-toy-removal.md) | Tool contract boundary 与 toy 移除 | 加入 source/group/path/execution metadata，并移除 toy tool。 |
| [16](16-unlimited-loop-and-guardrails.md) | Unlimited loop 与 guardrails | 移除人为 round cap，同时阻止重复相同工具循环。 |
| [17](17-current-state-and-next-steps.md) | 当前状态与下一步 | 总结哪些能力已经真实存在，以及下一步应该补什么。 |
| [18](18-shell-tool-and-command-safety.md) | Shell 工具与命令安全分类 | 在 safe-command 分类器和 tool-level permission override 后面给模型一个 shell。 |
| [19](19-approval-pause-and-resume.md) | Approval 暂停与恢复 | 把 `ask` 决策从直接失败变成挂起等待批准/拒绝后继续。 |
| [20](20-session-replay-and-resume.md) | Session Replay 与 Resume | 把单轮 JSONL session 变成可以多次继续的真正多轮对话。 |
| [21](21-context-compaction.md) | Context Compaction | 到达 token 阈值就自动压缩历史，让长对话不会无限增长。 |
| [22](22-frontend-dark-mode-and-polish.md) | 前端 Dark Mode 与页面打磨 | 补上系统级 dark mode，并逐页验证 Agent/Chat 工作台的可用性。 |
| [23](23-production-harness-gap-map.md) | 与生产 harness 的差距总表 | 主动画出全书边界：对照 Codex/Claude Code 列出缺哪些机制、为什么不做、何时值得做。 |
| [24](24-os-level-sandbox.md) | OS 级沙箱 | 把第 18 章的词法分类器升级为内核强制：macOS `sandbox-exec` + Linux `bwrap`,fail-closed,carveout 保护 `.git`/`.env`/sessions。 |

章节表之外还有一份[附录：前置知识桥](appendix-prerequisites.md)，给跨行读者补 TypeScript union、Zod、App Router、SSE、tool-calling 协议和 async 时序六座桥。

## 如何阅读

如果你从其他技术栈跨行而来(比如 Java/Python 背景)，先读 00 把环境和 API key 跑通；读正文时遇到概念断层，随时查[前置知识附录](appendix-prerequisites.md)，不必从头补课。

如果是第一次看项目，先读 01 到 05。它们解释这个 repo 为什么重视显式边界和可检查性。

如果要理解当前 agent runtime，读 08 到 16 加 18 到 21。它们覆盖 provider-neutral loop、真实工具、debug surface、session records、loop guardrails、shell 边界、approval 暂停/恢复、session resume 和 context compaction。第 22 章是前端打磨，独立于 runtime 演进线，可以单独阅读。

如果要继续加能力，先读 17。下一个能力也应该遵守同样纪律：定义边界、暴露数据流、写真实测试、更新教程。

## 主线

核心观点是：

```text
模型提供推理。
harness 提供让推理安全行动的 runtime。
```

在这个项目里，harness 负责：

- route boundaries
- input validation
- provider dialects
- streaming events
- model-visible history
- tools
- permissions
- cancellation
- debug surfaces
- session records
- loop guardrails

所以这套教程讲边界的篇幅会比讲 prompt 的篇幅多。
