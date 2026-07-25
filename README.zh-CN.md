# Inspectable Agent Harness

**从裸 OpenAI 兼容 API 起步、从零构建的 coding agent 运行时，外加 25 章教程解释每一条边界为什么落在这里。**

[English](README.md) · [中文教程](tutorial/zh/README.md) · [English tutorial](tutorial/en/README.md)

TypeScript · Next.js · 141 个确定性测试 · 不依赖任何 agent 框架、LangChain 或 agent SDK

---

## 这个项目解决什么

大多数 agent 教程停在"把模型调用放进一个循环里"。但让 coding agent 真正变难的东西在别处：

- 流式输出还没结束时，assistant 消息在哪个时刻**提交**才是安全的
- 取消边界切在哪里，才不会把 transcript 弄坏
- 工具契约怎么在 provider 的 strict JSON schema 模式下活下来
- 一次 run 中途因为需要人工审批而暂停，它的状态存在哪、怎么恢复
- 上下文压缩怎么做，才不会破坏 tool_call 与 tool_result 的配对
- shell 工具到底怎么在操作系统层面被关住

这个项目按真实工程会撞上它们的顺序，一个一个实现。教程是配套的设计日志：每一章解释的是"什么问题逼出了下一条边界"。

它是**用来读、用来学的参考实现**，不是生产级 CLI。第 23 章是一张明确的差距总表——对照生产 harness（Codex CLI / Claude Code）还差什么，补上要付出什么。

## 里面有什么

| 能力 | 代码位置 | 章节 |
| --- | --- | --- |
| 流式采样循环与提交语义 | `lib/agent.ts`、`lib/agent-model-stages.ts` | [10](tutorial/zh/10-streaming-sampling-and-commit-semantics.md) |
| 取消边界与运行时事件 | `lib/agent-run-context.ts`、`lib/agent-events.ts` | [05](tutorial/zh/05-streaming-cancellation-and-events.md) |
| Provider dialect —— OpenAI Chat Completions / Responses、Anthropic Messages | `lib/model-provider-dialect.ts`、`lib/anthropic-messages-mapping.ts` | [08](tutorial/zh/08-provider-dialect-boundary.md) |
| Provider 中立的 response items（运行时主干） | `lib/agent-response-items.ts` | [09](tutorial/zh/09-response-items-and-runtime-spine.md) |
| 工具运行时边界、工具契约、strict schema 适配 | `lib/agent-tool-runtime.ts`、`lib/agent-tool-contracts.ts`、`lib/openai-tool-schema.ts` | [06](tutorial/zh/06-tool-runtime-and-permission-skeleton.md) · [13](tutorial/zh/13-tool-output-and-strict-openai-schema.md) · [15](tutorial/zh/15-tool-contract-boundary-and-toy-removal.md) |
| 权限策略、路径策略、read-before-edit | `lib/agent-permissions.ts`、`lib/agent-path-policy.ts` | [06](tutorial/zh/06-tool-runtime-and-permission-skeleton.md) · [12](tutorial/zh/12-real-readonly-tools.md) |
| shell 工具与安全命令分类器 | `lib/agent-shell-builtins.ts`、`lib/agent-shell-safety.ts` | [18](tutorial/zh/18-shell-tool-and-command-safety.md) |
| OS 级沙箱 —— macOS `sandbox-exec`、Linux `bwrap`，fail-closed | `lib/agent-shell-sandbox-macos.ts`、`lib/agent-shell-sandbox-linux.ts` | [24](tutorial/zh/24-os-level-sandbox.md) |
| 审批暂停与恢复 | `lib/agent-approvals.ts` | [19](tutorial/zh/19-approval-pause-and-resume.md) |
| JSONL 会话存储、回放、恢复 | `lib/agent-session-store.ts` | [07](tutorial/zh/07-jsonl-sessions-and-usage.md) · [20](tutorial/zh/20-session-replay-and-resume.md) |
| 上下文 compaction | `lib/agent-compaction.ts` | [21](tutorial/zh/21-context-compaction.md) |
| 环境上下文注入、重试与退避 | `lib/agent-environment-context.ts`、`lib/model-retry.ts` | [23](tutorial/zh/23-production-harness-gap-map.md) |
| Debug Console 与会话查看器 | `app/` | [14](tutorial/zh/14-debug-console-and-session-viewer.md) |
| 确定性运行时测试 | `tests/` | [11](tutorial/zh/11-deterministic-runtime-tests.md) |

## 快速开始

```bash
git clone https://github.com/Liang-HZ/inspectable-agent-harness.git
cd inspectable-agent-harness
npm install
cp .env.example .env.local   # 填 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
npm run dev                  # → http://localhost:3000
```

任何 OpenAI 兼容 provider（OpenAI、DeepSeek、Qwen……）都能跑，Anthropic 走 Messages 映射层。第 [00](tutorial/zh/00-environment-and-first-run.md) 章把环境准备完整走了一遍，包括用 `curl` 的第一次跑通。

```bash
npm test         # 141 个确定性测试，不联网
npm run typecheck
```

## 教程

25 章，中英双语，按项目真实演化路径重建——依据 git 历史、当前工作区，以及已经沉淀进代码的设计取舍。

- **[中文教程](tutorial/zh/README.md)** —— 章节地图与阅读顺序
- **[English tutorial](tutorial/en/README.md)**

它不是源码索引，回答的是另一个问题：*为什么代码被切成现在这些边界，而不是别的。* 每章末尾都有可以自己动手验证的"本章验证点"。

## 架构文档

- [`docs/architecture.md`](docs/architecture.md) —— 当前模块地图与边界
- [`docs/evolution.md`](docs/evolution.md) —— 这些边界怎么长出来的
- [`docs/research-codex-claude-code.md`](docs/research-codex-claude-code.md) —— Codex CLI 与 Claude Code harness 机制调研笔记（2026-07）

## API

```text
POST /api/chat            单次模型调用
POST /api/agent           一次 agent run，返回最终回答 + 可检查的 steps + usage
POST /api/agent/stream    同一次 run 的 SSE 流（step / assistantDelta / done / error）
```

响应用显式判别字段（`{ ok: true, result }` / `{ ok: false, error }`）。route 保持薄：解析、校验、调 service、返回 JSON。

## 许可

MIT，见 [LICENSE](LICENSE)。
