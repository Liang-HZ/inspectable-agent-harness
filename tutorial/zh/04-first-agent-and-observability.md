# 04. 第一个 Agent 与 Observability

本章说明项目如何从普通 chat API 迈向第一个可检查的 agent endpoint。这里的重点不是 agent 有多聪明，而是每一步都能被表示、记录和验证。

读完本章后，应该理解：

- `/api/agent` 和 `/api/chat` 的职责差异
- `AgentStep` 为什么先作为教学结构出现
- structured logs 如何帮助定位一次 run
- toy tool 为什么只能作为临时脚手架

## 背景

`/api/chat` 之后，下一个问题是：最小 agent-like backend path 是什么？

第一版答案不是完整 loop，而是一个小型可检查 agent service：

- 构造 prompt
- 询问模型
- 可选调用本地工具
- 询问或返回 answer
- 展示 steps

这明确是 scaffold。

## 引入的文件

```text
app/api/agent/route.ts
lib/agent-input.ts
lib/agent-api-types.ts
lib/agent.ts
lib/agent-log.ts
lib/agent-tools.ts
```

Route 沿用 `/api/chat` 的模式：parse input、read config、call service、return JSON。

## AgentStep

早期展示 contract 是 `AgentStep`：

```ts
type AgentStep = {
  order: number;
  title: string;
  detail: string;
  output?: unknown;
};
```

Steps 让第一版 agent 可检查，但它从来不是最终 runtime truth。

后面 `AgentResponseItem`、Debug Console、JSONL sessions 成为更深的事实 surface。`AgentStep` 保留下来作为展示摘要。

## 结构化日志

为了让 agent 的每一步可以被追踪，项目加入带 `runId` 的 structured JSON logs。

日志逐步扩展到：

- parsed input
- prompt text
- step output
- final answer
- model id
- usage presence

规则是：日志可以暴露 runtime behavior，但不暴露 secrets。

## 临时 Toy Tool

最早工具是一个 toy text-inspection tool。它用于证明链路：

```text
model requests tool
runtime executes tool
tool result goes back to model
model answers
```

后来真实文件探索工具出现后，这个 toy tool 被移除。这个移除很重要：保留 toy tool 会让系统一直围绕假能力测试。

## 取舍

第一版 agent 故意不是 production-shaped。它给项目一个可以观察和批评的 artifact。

这些批评推动了后续变化：

- 不再额外调用 final-answer model call
- 显式建模 model-visible history
- 分离 provider events 和 round results
- tools 移到 runtime boundaries 后面
- frontend 拆出 Debug 和 Agent views

## 验证

这个阶段主要靠：

```bash
curl -s -X POST http://localhost:3000/api/agent ...
npm run typecheck
npm run build
```

后面的章节会加入 deterministic tests，不靠真实 provider 也能证明 runtime。

## 常见误解

### 误解一：第一个 agent 必须已经能改代码

第一个 agent 的目标是建立可观察链路。只要能展示模型输出、工具步骤和结构化结果，就已经为后续真实工具准备好了位置。

### 误解二：steps 就是最终架构

`AgentStep` 是早期教学结构。后面会被 response item、runtime event 和 debug projection 取代。

### 误解三：toy tool 可以长期保留

Toy tool 只能验证链路，不能代表生产级能力。真实工具出现后，它应该被移除，避免模型学到不真实的能力边界。

## 本章小结

这一章建立了第一个 agent 可观察闭环：输入进入 `/api/agent`，runtime 产生步骤，日志带 `runId`，前端能看到 agent 的行动轨迹。
