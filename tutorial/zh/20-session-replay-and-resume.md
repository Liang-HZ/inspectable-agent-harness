# 20. Session Replay 与 Resume

本章解释 harness 如何把"一次 JSONL session 只有一轮对话"变成"同一个 session 可以被多次继续，成为真正的多轮对话"。这是第 7 章引入 JSONL session store 之后，第一次真正利用它做 replay。

读完本章后，应该理解：

- 为什么"session"和"run"必须是两个不同的身份概念
- resume 时如何从 JSONL 重建 model-visible history
- 为什么 mid-turn crash 会破坏 function_call/function_call_output 的配对不变量，以及如何修复它
- 为什么 resume 只追加新增内容，而不是把整段历史重新写一遍
- 前端如何把"继续这个 session"变成一次点击

## 背景

第 7 章给每次 `/api/agent/stream` 调用建了一个 JSONL 文件，但从那之后到现在，`session.id` 和 `context.runId` 一直是同一个值——每次调用都创建一个全新 session，里面永远只有一轮对话。这意味着 JSONL session store 事实上只是一个"单轮 run 的审计日志"，还不是真正可以延续的会话。

调研 Codex CLI 和 Claude Code(见 [`docs/research-codex-claude-code.md`](../../docs/research-codex-claude-code.md))发现两者都把这两个身份分开：

- Codex 的 rollout 文件里，`SessionMeta` 只在会话开始时写一次，`TurnContext` 每个 turn 写一次；`codex resume` 从最近的 `Compacted` 检查点向后重建。
- Claude Code 用 `--continue`/`--resume` 恢复整个消息历史，`--fork-session` 可以从某个历史点开一个新会话分支。

这个项目现在做同样的分离，但保持教学尺寸：一个 `resumeAgentSession` 函数，一个 normalize 步骤，一个决定"追加什么"而不是"重写什么"的边界。

## 设计选择

### Session 身份和 Run 身份分开

之前：

```text
session.id === context.runId === turn 唯一标识
```

现在：

```text
sessionId   稳定不变,标识"这个对话",等于第一轮的 runId
runId       每次 /api/agent/stream 调用都新生成,标识"这一轮"
```

`AgentInput` 新增可选字段 `sessionId`。省略时行为和以前完全一样(新建 session,`sessionId = runId`)。传入时，runtime 会打开已有的 session 文件，把这一轮的新对话追加进去。

这个变化通过 `run_started` 事件对外暴露：

```ts
{ type: 'run_started', runId, sessionId, resumed: boolean, policy }
```

`runId` 继续用于事件关联、approval 注册表的 key 等所有"这一轮"相关的用途；`sessionId` 是浏览器 Session 面板用来定位 JSONL 文件、以及 sidebar 高亮"当前会话"该用的身份。

### 重建 history:从 JSONL 读，不是从内存读

`lib/agent-session-store.ts` 新增 `resumeAgentSession(sessionId)`:

```text
1. 用 sessionId 找到 JSONL 文件路径(复用第 7 章的 findAgentSessionPathById)
2. 读出全部 response_item 记录,按写入顺序还原成 AgentResponseItem[]
3. 重放 compaction(replayAgentResponseItemHistory):遇到 compaction_summary
   行,就对至此的历史重新应用同一个压缩变换,细节见第 21 章
4. 跑 normalize(见下一节)
5. 返回 { session, history, synthesizedItems }
```

读回的 response_item 不是原样照搬给模型的：如果这个 session 在之前的运行里发生过 context compaction，历史里会有 `compaction_summary` 行，resume 必须在读回时重放同样的压缩，才能重建出当时运行时内存里真正的 model-visible history（第 21 章展开这个交互）。重放之后再跑 normalize。

这里没有任何内存缓存——每次 resume 都是从磁盘重新读。这是有意的：进程重启、换一台机器、甚至换一个部署实例，只要 JSONL 文件还在，resume 就该工作。这也是 Codex/Claude Code 的模型：session 状态活在文件里，不活在进程里(和上一章 approval pending state 刻意相反的选择——那个必须活在进程里，因为它对应一个还在运行的 promise)。

### Normalize:修复被打断的 tool call

调研里提到 Codex 的 `context_manager/normalize.rs` 会做两件事：删除找不到 call 的孤儿 output，以及给找不到 output 的孤儿 call 插入 synthetic output。这个项目只需要后一种情况——runtime 提交 response item 的顺序保证了 output 不会在 call 之前出现，所以孤儿只可能是"有 call 没 output"。

`normalizeAgentResponseItemHistory` 做的事：

```text
扫描 history 里所有 function_call
对每个 function_call,检查后面是否存在同 callId 的 function_call_output
没有的话,在该 function_call 后面插入一条 synthesized function_call_output:
  isError: true
  output: "Error [SESSION_RESUME_INTERRUPTED]: This tool call did not
           finish before the previous run on this session ended..."
```

这个不变量必须保持的原因不是这个项目的偏好，是 provider 协议的硬要求：OpenAI Chat Completions 和 Responses API 都要求每个 tool call 必须有对应的 tool 响应，否则整个请求会被拒绝。如果不做这一步，resume 一个在工具调用中间被杀掉的 session，下一次模型请求会直接报错，而不是优雅地继续。

`callId` 用真实的原 `callId`，不是随机生成的——这样即使未来加了 prompt cache，同一个 callId 在 cache key 计算里也保持稳定，这也是调研里提到的 Codex 用 UUIDv5 稳定派生 synthetic id 的同一个动机(这个项目更简单，直接复用原 callId，因为一个 call 只可能对应一个 output)。

### 只追加新内容，不重写整段历史

这是最容易写错的一步。`resumeAgentSession` 返回的 `history` 是完整的历史(第一轮到现在的所有内容)，这份完整历史要发给模型。但**写回 JSONL 时绝不能把整份历史再 append 一遍**——那会让文件线性增长，且每次 resume 都会成倍膨胀。

`lib/agent.ts` 的 `initializeAgentSessionForStream` 把这两件事分开：

```ts
type AgentSessionInitResult = {
  session: AgentSession;
  history: AgentResponseItem[];        // 发给模型的完整历史
  sessionId: string;
  resumed: boolean;
  newItemsToPersist: AgentResponseItem[]; // 真正要写盘的,只有新增部分
};
```

新建 session 时，`history === newItemsToPersist`(都是 system+user 两条，和以前行为完全一致)。resume 时：

```text
history            = 重建的历史 + synthesizedItems(已经在 normalize 里生成) + 新的 user 消息
newItemsToPersist   = synthesizedItems + 新的 user 消息
```

`synthesizedItems` 会被写回磁盘，这样下次再 resume 这个 session 时，normalize 不需要重新推断——它已经是记录在案的真实历史的一部分了。这是幂等性设计：同一个中断点，只需要 normalize 一次。

### 为什么 resume 失败要 throw 而不是静默新建

如果 `sessionId` 指向一个不存在的 session,`initializeAgentSessionForStream` 直接 `throw`，不会静默 fallback 成"新建一个 session"。这个选择是为了让"用户以为在继续对话，实际上开了个新对话"这种静默数据丢失不可能发生。错误会被 `/api/agent/stream` 的 try/catch 捕获，变成一条 SSE `error` 事件，前端照常显示报错文案。

## 前端

Session 面板(第 14 章引入的 JSONL 浏览器)现在多了一个 **Continue this session** 按钮。点击后把当前查看的 session id 写进 Agent 表单的 `sessionId` 字段，composer 顶部出现一条提示：

```text
Continuing session 4786ba7e          Start new session
```

点击 "Start new session" 清空 `sessionId`，回到"新建对话"的默认行为。

Sidebar 的 "Current run" 卡片也加了一行 `continuing session ...` 标记，和 `SessionRail` 的高亮逻辑一起，从"按 runId 高亮"改成"按 sessionId 高亮"——这样 resume 之后，sidebar 里高亮的还是同一个 session，而不是每轮换一个。

## 权限与数据流矩阵

| 场景 | sessionId 输入 | session 文件行为 | history 来源 |
| --- | --- | --- | --- |
| 全新对话 | 不传 | 新建，写 `session_meta` | `system + user` 两条 |
| 继续已有对话 | 传入已存在的 id | 复用文件，追加 `turn_context` + 新内容 | 重建历史（含 compaction 重放）+ normalize + 新 user 消息 |
| 继续不存在的 id | 传入不存在的 id | 不创建任何文件 | 抛错，SSE 返回 `error` 事件 |
| 非流式 `/api/agent` | 传或不传都一样 | 不涉及 session(该路由从未持久化) | 每次都是全新 prompt |

## 还没做什么

- **非流式 `/api/agent` 路由不支持 resume。** 这条路由从第 4 章开始就没有 session 概念，这次也没有补上——resume 是流式路由的能力，和它依赖 SSE 才能把 approval 请求推给用户是同一个道理：非流式调用本来就是无状态的单次请求。
- **本章落地时还没有 context compaction。** 对话轮数多了之后 token 会线性增长直到超限。下一章解决这个问题，并回头给 resume 补上 compaction 重放——上文步骤 3 就是那次回补的结果。
- **没有"从某个历史点分叉"。** Codex 的 `fork` 允许从中间某条记录开一个新会话；这个项目目前只能从"最新状态"继续。
- **Session 面板还是展示单一 JSONL 流，不区分"第几轮"。** 想看清楚多轮结构需要自己读 `turn_context` 记录的顺序。

## 哪些测试证明它

- [`tests/agent-session-store.test.ts`](../../tests/agent-session-store.test.ts):`normalizeAgentResponseItemHistory` 的配对/孤儿/混合场景，以及 `resumeAgentSession` 的 not-found、空历史、干净重建、孤儿工具调用重建
- [`tests/agent-session-resume-init.test.ts`](../../tests/agent-session-resume-init.test.ts):`initializeAgentSessionForStream` 的新建路径、resume 路径(只追加新内容，不重写历史)、mid-turn 中断的 resume、未知 session id 报错
- 手动通过真实 HTTP 路由验证：`POST /api/agent/stream` 传入已存在的 `sessionId`，确认 `turn_context` 被追加而不是覆盖，`model_requested` 事件里模型看到的 `messages` 数组从 2 条(第一轮)变成 3 条(第二轮，包含两轮的 user 消息),JSONL 记录数从 8 条正确增长到 14 条而不是翻倍

## 本章小结

Session resume 的核心不是新写一个持久化系统——第 7 章的 JSONL store 已经足够。真正的工作是三件事：把 session 身份和 run 身份分开、把"重建"和"追加"分开、把"完整发给模型"和"只写新内容到磁盘"分开。这三处分离让"继续一个对话"从概念变成了可以点一下按钮就触发的真实能力。
