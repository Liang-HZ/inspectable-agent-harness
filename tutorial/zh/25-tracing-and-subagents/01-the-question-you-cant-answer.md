← [章目录](README.md) · 下一节：[02 · 事件流不等于 trace](02-events-are-not-a-trace.md)

# 01 · 答不出来的那个问题

先不讲设计。跑一次 run，然后问它一个很普通的问题。

## 一次普通的 run

给 agent 一个任务，让它跑完：

```
帮我看看 lib/ 下面哪个模块最大，再确认一下它有没有对应的测试
```

它做了这些事：想一下 → 调 `ls` → 想一下 → 调 `grep` → 想一下 → 调 `read` → 给答案。

一共 40 秒。

## 现在问一个问题

**这 40 秒花在哪儿了？**

你手上有什么？打开 `data/agent-sessions/` 里那个 JSONL，几百行，每行一条记录：

```jsonl
{"timestamp":"...","type":"agent_event","payload":{"type":"model_requested",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"model_completed",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"tool_started","toolName":"ls",...}}
{"timestamp":"...","type":"agent_event","payload":{"type":"tool_finished","toolName":"ls",...}}
```

数据全在。每条记录都有 `timestamp`。

那就自己算吧：

1. 找到第一条 `model_requested`，记下时间。
2. 找到对应的 `model_completed`——**哪一条是"对应的"？** 它们之间没有共同的 id。你只能靠"在文件里挨着"和 `round` 字段猜。
3. 减一下，得到第一轮模型花了多久。
4. 对三次工具调用重复上面的步骤。`tool_started` 和 `tool_finished` 好一点，有 `toolCallId` 能配对。
5. 把六个数字抄到纸上排个序。

做完了，你确实知道了答案。**但你是拿人脑当查询引擎用了。**

## 这不是数据不够

注意刚才那个过程里，你没有一次因为"日志里没记"而卡住。数据是齐的。

卡住的地方是这两个：

- **配不上对**。`model_requested` 和 `model_completed` 是两条独立的记录，没有共同标识。它们靠"文件里的相邻关系"隐式关联——这个关系在并发工具调用时就崩了（第 05 章加的并行执行会让四个 `tool_started` 连着出现，然后四个 `tool_finished` 乱序回来）。
- **看不出包含关系**。`ls` 这次调用是"在这一轮模型决策之下发生的"。这个从属关系在文件里完全没有表达，只能靠你知道 agent 的循环长什么样，脑补出来。

## 换个说法

你有的是一串**发生过的事**。

你想要的是一张**什么包着什么、各花了多久**的图。

从前者到后者，缺的不是数据量，是两样很小的东西：**每段工作有自己的身份，以及它属于谁**。

下一节把这件事说清楚——为什么加了 15 种事件类型，还是不叫 trace。

---

← [章目录](README.md) · 下一节：[02 · 事件流不等于 trace](02-events-are-not-a-trace.md)
