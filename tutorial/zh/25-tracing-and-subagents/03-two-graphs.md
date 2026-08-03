← 上一节：[02 · 事件流不等于 trace](02-events-are-not-a-trace.md) · [章目录](README.md) · 下一节：[04 · 子代理跑在别的文件里](04-the-subagent-problem.md)

# 03 · 两张图，不是一张

上一节加完 span，很容易得出一个结论：**既然 span 树能表达"什么包着什么"，那消息之间的先后关系是不是就不用单独存了？**

不能。这一节讲为什么，以及为什么这个判断值得单独占一节。

## 先看别人怎么存的

Claude Code 自己的会话文件就在你机器上，`~/.claude/projects/<项目>/<sessionId>.jsonl`。捞一条出来看看键：

```json
{
  "parentUuid": "d572a37b-5809-470d-b23d-00886f7c8552",
  "isSidechain": true,
  "agentId": "a50ec970333ec68c4",
  "type": "attachment",
  "uuid": "5effcb66-ffcc-459e-be69-31d8f0bddae9",
  "timestamp": "2026-07-29T02:19:52.920Z",
  "cwd": "...",
  "sessionId": "816fab5f-aa24-489a-9833-39c412f7025b",
  "gitBranch": "HEAD"
}
```

注意 `uuid` 和 `parentUuid`：每条记录指向它的前驱，整个文件是一棵**树**，不是一个数组。

而且里面**没有任何 span 字段**——没有 traceId，没有耗时。

## 两个轴，量的是不同的东西

| | 表达什么 | 少了它答不出 |
| --- | --- | --- |
| `uuid` / `parentUuid` | **消息血缘**：这条记录接在谁后面 | 压缩后重放、从某条消息分叉、"这次编辑基于哪个版本的历史" |
| `traceId` / `spanId` / `parentSpanId` | **跨度树**：什么跑在什么里面，各多久 | 哪一步慢、谁调了谁、token 花在哪 |

它们看起来都在讲"父子关系"，但父子的含义完全不同：

- 消息血缘的父，是**时间上的前一条**。第 21 章做上下文压缩时，一堆消息被一条摘要替换掉——这个替换关系是血缘图上的事，span 树完全看不见。
- span 的父，是**逻辑上的包含者**。一次 `grep` 的父是"这一轮模型决策"，但在消息序列里，它俩之间可能隔着好几条别的记录。

**一张图推不出另一张。** 硬要用 span 树表达血缘，你会发现"压缩"这个操作没法画：它不是"一段工作包着另一段工作"，它是"历史被重写了"。

所以两套都留。

## 我们的取法

harness 的会话记录本来就是 append-only 的 JSONL，顺序即血缘（第 07 章）。这一章加的是 span 那一套：

```
data/agent-sessions/2026/07/29/
  rollout-<ts>-<id>.jsonl                    # 主会话，顺序即血缘
```

每条 `agent_event` 记录的 payload 里带 span 字段。两个轴共存在同一个文件里，互不干扰。

## 一个反例：为什么不把 span 塞进 parentUuid

有个看起来很省事的想法：既然都是树，让 `parentUuid` 直接指向"逻辑父"不就行了？一棵树两用。

试一下就知道不行：

```
model_requested(轮1)  ← 血缘父：run_started
tool_started(ls)      ← 血缘父：model_completed(轮1)
                      ← 逻辑父：model_completed(轮1)    ✓ 碰巧一样
tool_started(grep)    ← 血缘父：tool_finished(ls)       ← 前一条
                      ← 逻辑父：model_completed(轮1)    ✗ 不一样了
```

并行工具调用的时候，四次调用的血缘父是各自的前一条记录，逻辑父却是同一轮模型决策。**一个字段塞不下两种含义**，一塞就得在读的时候猜，猜就会错。

分开存，两个字段，各自诚实。

## 这一节的结论

多存一份 id 的成本，是每条记录多几十字节。

省掉它的成本，是有一类问题你永远答不出来——而且是等你真的需要回答的时候，才发现历史数据里没有。

下一节进入真正的考验：当一段工作跑在**另一个文件**里的时候，这两张图还接得起来吗。

---

← 上一节：[02 · 事件流不等于 trace](02-events-are-not-a-trace.md) · [章目录](README.md) · 下一节：[04 · 子代理跑在别的文件里](04-the-subagent-problem.md)
