# 19. Approval 暂停与恢复

本章解释 harness 如何把一次 permission 决策的 `ask` 结果，从"直接失败"变成"挂起
等待用户批准，批准/拒绝后继续跑"。这是第 15 章埋下的 `AgentApprovalRequiredError`
第一次真正被兑现。

读完本章后，应该理解：

- 为什么 fail-closed 曾经是正确的临时方案，以及它在哪里不够用
- Codex 和 Claude Code 如何设计 approval 的暂停/恢复通道
- pending approval 为什么是进程内存状态，而不是 JSONL 持久化状态
- 拒绝时返回给模型的 tool output 为什么要专门措辞
- SSE 事件契约如何把 approval 从 debug-only 提升为一等公民

## 背景

第 15、16 章引入 permission 决策的三态模型(`allow` / `ask` / `deny`)时，`ask`
分支只有一条路：抛 `AgentApprovalRequiredError`,run 直接失败。教程当时明确写道
"interactive approval/resume is not implemented yet"——这是故意的边界，不是遗漏。

fail-closed 在那个阶段是对的：没有暂停机制时，让一个高风险工具调用"悄悄执行"远
比"直接失败"危险。但它意味着任何触发 `ask` 的策略组合(`strict` 审批、或默认
`on_request` 遇到没有明确 annotations 的工具)在实践中都不可用——run 一定会中断。

调研 Codex CLI 和 Claude Code 的实现(见 [`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))
发现两者的核心机制惊人地相似：approval 不是一个独立的"暂停/恢复系统"，而是**一个
挂起的 Promise**。

## 设计选择

### Pending approval = 内存里的一个 resolver

`lib/agent-approvals.ts` 是这一层的全部状态：

```text
waitForAgentApproval(input)   注册一个 pending approval,返回一个 Promise
resolveAgentApproval(...)     根据 runId + toolCallId 查找并 resolve 它
listPendingAgentApprovals()   列出当前所有待处理项(供 UI 恢复/轮询)
```

这直接对应调研结论：Codex 用 `oneshot::channel()` + `pending_approvals` map,
Claude Code 用 `canUseTool` 回调背后的挂起 Promise——都是**进程内存状态**，都不
持久化到磁盘。这不是偷懒，是设计：批准是 turn 内的临时状态，进程死了就等于拒绝，
这个语义反而是安全的默认值。

```ts
export function waitForAgentApproval(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  signal: AbortSignal | undefined;
  timeoutMs?: number;
}): Promise<AgentApprovalResolution>
```

三种 resolve 路径：

```text
用户批准     { type: 'approved', source: 'user' }
用户拒绝     { type: 'denied', source: 'user', reason }
超时         { type: 'denied', source: 'timeout', reason }  (默认 120000ms)
run 被中止   { type: 'denied', source: 'abort', reason }
```

超时和 abort 都归一到 `denied`——对模型来说，"没人来批准"和"用户明确拒绝"应该
走同一条恢复路径，不需要区分。

### 为什么注册用 `globalThis` 而不是模块级变量

registry 用 `Symbol.for('myJsTest.agentApprovalRegistry')` 存在 `globalThis`
上，而不是模块顶层的 `new Map()`。原因是 Next.js 在某些打包路径下会把同一个
`.ts` 文件加载成多个模块实例(stream route 和 approvals route 可能各自持有一份
"独立"的 `agent-approvals.ts`)。如果 registry 是模块级变量，两个路由各自看到
空 map，批准请求永远找不到对方注册的 pending 项。`globalThis` 保证同一个 Node
进程里只有一份 registry，与路由文件如何被打包无关。

### Runtime 集成：`ask` 分支从 throw 变成 await

`lib/agent-tool-runtime.ts` 里，`executeAgentToolCall` 原来的逻辑是：

```text
permissionDecision.type === 'ask'  ->  抛 AgentApprovalRequiredError
```

现在是：

```text
permissionDecision.type === 'ask':
  发 approval_requested 事件
  resolution = await waitForInteractiveToolApproval(...)
  发 approval_resolved 事件
  resolution.type === 'denied':
    返回 APPROVAL_DENIED 的 recoverable tool output(不抛异常)
  resolution.type === 'approved':
    继续走正常执行路径
```

`waitForInteractiveToolApproval` 是一个薄的分流层：

```ts
if (context.approvalMode !== 'interactive') {
  throw new AgentApprovalRequiredError(request, decision);
}
return waitForAgentApproval({...});
```

这保留了第 15 章的行为作为默认值——`AgentRunContext` 新增的 `approvalMode` 字段
默认是 `'fail_closed'`，只有显式传 `'interactive'` 才会真正挂起等待。非流式的
`/api/agent` 路由没有推送通道给用户看到 approval 请求，所以继续 fail-closed 是
正确的；`/api/agent/stream` 路由传 `approvalMode: 'interactive'`，因为 SSE 连接
本身就是通知用户"现在需要你决策"的通道。

### 同步注册保证：为什么测试不需要 sleep

`waitForAgentApproval` 的 Promise executor 是同步执行的——`registry.set(...)`
发生在 `new Promise((resolve) => {...})` 的 executor 内部，executor 本身没有
`await`。这意味着：从 `executeAgentToolCall` 调用
`await waitForInteractiveToolApproval(...)` 到真正 `await` 挂起之间，registry
已经写入完毕。JS 的 async 函数在遇到第一个真正让出控制权的 `await` 之前都是
同步执行的，所以调用方在拿到 pending promise 的同一个 tick 里就能安全地调用
`resolveAgentApproval`——不需要 `setTimeout`、`setImmediate` 或轮询。

这个保证让测试(见下文)可以写成：

```ts
const executionPromise = executeAgentToolCall(toolCall, context, callbacks);
const resolveResult = resolveAgentApproval(runId, toolCallId, 'approve');
assert.equal(resolveResult.ok, true);
const execution = await executionPromise;
```

唯一的例外是采样循环层面的集成测试：那里 approval 请求要经过 stream 消费、
tool batch 调度等好几层 await，才会真正调用到 `waitForAgentApproval`。测试用
`queueMicrotask` 把 resolve 调用推迟到下一个微任务，确保 registry 已经写入
(见 [`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts))。

### 拒绝时给模型的措辞

`APPROVAL_DENIED` 的错误消息刻意写成：

```text
{reason} The action was not performed. Do not retry the same call;
take a different approach or explain what you need in the final answer.
```

这直接对应调研里 Codex(`"rejected by user"`)和 Claude Code("The tool use was
rejected... take a different approach")的共同模式：拒绝不是普通的工具错误，
它需要**明确引导模型换路**，否则模型很容易在下一轮又发起同一个调用，重新触发
approval，陷入循环。第 16 章的 repeated-call guard 会兜底这种情况，但更好的是
一开始就在文案里把"不要重试"说清楚。

## API 层

新增两个路由：

```text
GET  /api/agent/approvals?runId=...
POST /api/agent/approvals/{runId}/{toolCallId}   body: { decision: "approve" | "deny" }
```

`GET` 用于恢复/轮询——如果前端刷新页面或错过了 SSE 事件，可以主动查询当前还有
哪些 pending approval。`POST` 是核心动作，响应里带上被 resolve 的 `pending`
快照和最终 `resolution`，方便前端在没有等到 SSE 回声时也能确认状态。

请求体校验走项目一贯的 Zod 约定(`lib/agent-approval-input.ts`)，复用
`formErrors`/`fieldErrors` 的错误形状。

## Stream 事件契约

`approval_requested` 和 `approval_resolved` 在内部 `AgentEvent` 里始终存在
(第 15 章就有前者)，但投影到 SSE 的方式变了。之前 `approval_requested` 被塞进
`debug` 事件里；现在两者都提升为**一等 stream event**:

```text
type AgentStreamEvent =
  | { type: 'approvalRequired'; request: AgentApprovalStreamRequest }
  | { type: 'approvalResolved'; runId; toolCallId; toolName; resolution }
  | ... (原有的 step / assistantDelta / debug / done / error)
```

这个变化不是装饰性的。debug 事件是给"运行时观察"用的，前端的 Debug Console
展示它们但不依赖它们驱动核心 UI。而 approval 请求需要驱动一个真实的用户交互
(点击 Approve/Deny)，它必须是主链路上前端一定会处理的事件类型，而不是一个可以
被过滤掉的调试细节。

## 前端

`AgentApprovalBar` 组件订阅 `onApprovalRequired`/`onApprovalResolved` 回调，
把 pending approval 存进 `agentView.pendingApprovals`(只在 `streaming` 状态下
有意义)。每张卡片展示工具名、格式化后的参数 JSON、拒绝原因，以及 Approve/Deny
两个按钮，点击后调用 `submitAgentApprovalDecision` 发 POST。

卡片的移除不是在 POST 成功回调里做的，而是等 SSE 推回 `approvalResolved` 事件
再移除——这保证前端状态和 runtime 的真实状态永远一致，即便 POST 响应和 SSE 事件
的到达顺序不确定。

## 权限行为矩阵

| approvalMode | 决策 | 结果 |
| --- | --- | --- |
| `fail_closed`(默认，非流式 API) | `ask` | 抛 `AgentApprovalRequiredError`,run 失败 |
| `interactive`(`/api/agent/stream`) | `ask` | 挂起，等待 approve/deny/timeout/abort |
| 任意 | `deny` | 直接返回 recoverable tool output，不经过 approval 通道 |
| 任意 | `allow` | 正常执行，不触碰 approval 系统 |

## 还没做什么

- **进程重启后不能恢复 pending approval。** 这是有意的权衡，和 Codex/Claude
  Code 一致；如果未来需要跨进程持久化，需要把 pending state 写入 JSONL 并在
  session resume 时重建。
- **没有 "approved for session" 快捷方式。** Codex 的 `ApprovedForSession` 和
  Claude Code 的 "don't ask again" 规则持久化都还没有对应实现；每次 `ask` 都要
  单独批准。
- **没有 approval 超时后的自动重试。** 120 秒超时后直接判定为拒绝，模型需要自己
  决定下一步。

## 哪些测试证明它

- [`tests/agent-approvals.test.ts`](../../tests/agent-approvals.test.ts):
  approvals 模块的注册/解决/超时/abort/未知 pending，以及
  `executeAgentToolCall` 在 interactive 模式下的批准、拒绝、run-abort 三条路径
- [`tests/agent-sampling-loop.test.ts`](../../tests/agent-sampling-loop.test.ts)
  新增的两个集成测试：approval 批准后循环产出最终答案；拒绝后循环带着
  recoverable error 继续产出最终答案
- 现有的 fail-closed 测试(`risky tools request approval and fail closed...`)
  保持不变，证明默认行为没有被破坏

## 本章小结

Approval resume 的核心不是新增一个状态机，而是把"等待用户"这件事建模成一个
普通的、可以被 resolve 或超时的 Promise，再让 runtime 在 `ask` 分支里老实地
`await` 它。pending 状态活在内存里而不是磁盘上，这是从 Codex 和 Claude Code
的实现里学到的，也是这个边界目前应该停在哪里的判断——持久化 pending state 是
一个更大的能力(它牵涉进程重启语义)，留给需要它的时候再做。

## 本章验证点

Approval 的模块行为和循环集成各有一组不需要 key 的测试。先跑模块层：

```bash
npx tsx --test tests/agent-approvals.test.ts
```

实测尾部输出：

```text
✔ interactive tool runtime executes the tool after approval (0.750166ms)
✔ interactive tool runtime returns a recoverable error after denial (0.245958ms)
✔ interactive tool runtime denies when the run aborts while waiting for approval (0.169791ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

再点名跑两条采样循环集成用例——批准后继续、拒绝后带 recoverable error 继续：

```bash
npx tsx --test --test-name-pattern "interactive" tests/agent-sampling-loop.test.ts
```

实测输出是 `✔ resumes the loop after an interactive approval is granted` 和 `✔ resumes the loop with a recoverable error after an interactive denial`。另外可以不带 key 验证 API 边界：启动 dev server 后 `curl "http://localhost:3102/api/agent/approvals?runId=demo"` 返回 `{"ok":true,"pending":[]}`，对不存在的 pending 提交决策则返回 404 和 `"No pending approval found for run demo-run and tool call demo-call. It may have already been resolved or timed out."`。
