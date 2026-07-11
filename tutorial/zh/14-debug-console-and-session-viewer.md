# 14. Debug Console 与 Session Viewer

本章说明前端如何从单一 transcript 拆成三个视图：面向最终用户的 Agent 页面、面向开发者的 Debug Console、面向持久记录的 Session Viewer。

读完本章后，应该理解：

- Agent page、Debug page、Session page 分别面向谁
- 为什么 model input 和 model output 都要进入 debug
- 为什么 JSONL session 不是 Debug Console 的内部状态
- 为什么 permission audit 属于 Debug，而 run policy 同时属于 API、Debug 和 Session
- 工具输入输出为什么默认收起

## 背景

Runtime 有 streaming rounds 和真实工具后，前端需要展示的不只是 final answer。

第一版 Debug Console 暴露了一个语义缺口：它展示了 model requests，但还不够展示对应的 model output 和 committed history。

## 三个视图

前端现在拆成：

```text
Agent page    end-user-facing transcript
Debug page    runtime inspection
Session page  persisted JSONL records
```

这个拆分防止 debug terminology 泄漏到正常 agent experience。

## Agent Page

Agent page 展示：

- assistant text
- grouped tool batches
- final answer
- collapsed run details

它不展示 "round 1"、"round 2" 这种 runtime labels。

Assistant text 用 Markdown + GFM 渲染，因为模型常输出列表、表格、代码块。

## Debug Page

Debug page 展示：

- run policy
- permission audit decisions
- model input
- model output
- assistant deltas
- committed assistant messages
- tool calls
- tool arguments
- tool results
- model-visible `modelOutput`
- internal tool details
- usage and raw usage
- history commits

Debug data 来自 runtime events 加 stream-only debug events。

## Session Page

Session page 通过下面接口浏览 persisted JSONL：

```text
GET /api/agent/sessions
GET /api/agent/sessions/[id]
```

它先列出本地 sessions，再加载选中 session 的 raw records，因为这个页面用于直接检查 replay substrate。

Session list 会展示 model、session id 尾号、`approvalPolicy` 和
`sandboxMode`。完整 JSONL 仍然原样显示，不改造成 Debug Console 的事件视图。

## 为什么 Debug 和 Session 分开

Debug 是 operational。Session 是 durable。

`debug.historyCommitted` 不存成另一个 `agent_event`，因为 session 已经存了权威 `response_item` records。

这避免未来 resume state 被 debug-only duplication 污染。

Permission audit 也遵循同一个边界：Debug page 用它帮助开发者看清楚
`allow/ask/deny` 的决策原因；Session page 只展示实际写入 JSONL 的
`agent_event` 和 `response_item` 记录。

## Frontend Implementation

主文件：

```text
components/chat-playground.tsx
```

支持类型和 clients：

```text
lib/agent-api-types.ts
lib/agent-api-client.ts
lib/agent-stream-projection.ts
```

## 当前状态

这一层当前还没有进入 git commit，但已经在 working tree 中，是当前真实能力的一部分。

## 验证

这里手动验证很重要：

1. 启动 dev server
2. 运行一个会使用 `ls/find/grep/read` 的 agent task
3. 检查 Agent page 是否是 readable transcript
4. 检查 Debug page 是否有 model input/output 和 tool details
5. 检查 Debug page 是否有 permission audit
6. 检查 Session page 是否能列出 sessions 并打开 JSONL records

## 常见误解

### 误解一：Debug 信息应该直接放在 Agent 页面

Agent 页面面向最终用户，应展示自然过程：模型输出、工具批次、最终答案。Round、raw request、usage、JSONL 属于 debug/session 视图。

### 误解二：只展示 model input 就够了

不够。模型输出、committed assistant message、tool call 和 usage 都是 telemetry 的核心事实。Debug Console 必须能看到输入和输出的对应关系。

### 误解三：工具详情应该默认展开

工具输入输出可能很长。默认收起可以保护阅读节奏，需要时再展开查看细节。

## 本章小结

这一章把前端观察面分层：Agent 页面讲用户可见故事，Debug Console 看 runtime 细节，Session Viewer 看持久 JSONL 记录。
