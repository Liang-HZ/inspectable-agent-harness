← 上一节：[03 · 两张图，不是一张](03-two-graphs.md) · [章目录](README.md) · 下一节：[05 · 不绑厂商的出口](05-export-without-a-vendor.md)

# 04 · 子代理跑在别的文件里

第 23 章的差距表里，`Subagent` 那一行写的是"无"，理由是"在单循环还在打磨的阶段引入它只会稀释主线"。

现在单循环稳了，可以补上了。而且它正好是上一节那套 trace 结构的第一个真正考验。

## 为什么子代理必须有自己的文件

子代理的全部意义是**独立的 context window**：主对话不想被一次大范围调研的中间过程灌满，就派个子代理去，只要它的结论。

那它的历史该存哪儿？

如果和主会话交错写进同一个 JSONL，第 20 章的会话重放就废了——重放靠的是按顺序回放 `response_item`，子代理的消息混进去会污染主对话的历史，重放出来的东西根本没在主对话里出现过。

所以：**独立的文件**。这也是 Claude Code 的做法：

```
rollout-<ts>-<id>.jsonl
rollout-<ts>-<id>/
  subagents/agent-<agentId>.jsonl        # 子代理的完整 transcript
  subagents/agent-<agentId>.meta.json    # 一个小得多的索引
```

`.meta.json` 里的东西在 JSONL 首条记录里也有一份。**故意重复**：这样枚举一次 run 的子代理只要列个目录、读几个几百字节的小文件，不用打开动辄几 MB 的 transcript。

## 接缝在哪儿：一个必须先找对的位置

`task` 工具要派生一整个 run。但工具的执行签名是这样的：

```ts
execute: (
  argumentsJson: string,
  signal: AbortSignal | undefined,
  runtime: AgentToolRuntimeContext,
) => AgentToolResult | Promise<AgentToolResult>;
```

拿不到 `AgentRunContext`，拿不到 `callbacks`，拿不到模型网关，也拿不到会话句柄。

全仓库唯一同时握着这些东西的地方，是 `agent-tool-runtime.ts` 里构造运行时上下文的那几行：

```ts
toolDefinition.execute(
  toolCall.argumentsJson,
  toolAbortController.signal,
  {
    pathAccess: resolveAgentPathAccessForRunPolicy(...),
    sandboxMode: context.policy.sandboxMode,
    spawnSubagent: bindSubagentSpawner(context, toolCall, toolSpan),  // 新增
  },
)
```

于是 `AgentToolDefinition` 的形状**一个字都不用改**，其他六个工具完全无感。

`bindSubagentSpawner` 做的事只有一件——**把这次调用的 id 和 span 闭包进去**：

```ts
return (request) =>
  spawnSubagent({
    ...request,
    toolCallId: toolCall.id,
    parentSpan: toolSpan,
  });
```

`task` 工具自己永远不知道自己的 call id 和 span。它只管"我要一个子代理，给我答案"。**父子关系的正确性是运行时的不变量，不是工具的责任**——工具写错了也串不错。

## 跨文件的链路靠什么接

两条线，缺一不可：

**磁盘上**，靠 `toolCallId`：

```json
{"agentType":"general-purpose","description":"...","toolCallId":"toolu_01BYZ...","spawnDepth":1}
```

这是 Claude Code 的同款外键——子代理的 meta 记着"我是被哪次工具调用派生的"。

**span 上**，靠继承 traceId：

```ts
span: createChildSpanContext(request.parentSpan),
```

`createChildSpanContext` 继承父的 `traceId`，只换 `spanId`。所以子代理的根 span 和主 run 的所有 span **在同一条 trace 里**，尽管它们躺在两个不同的文件。

导出的时候不需要做任何拼接——后端看到相同的 traceId，自己就把它们组装成一棵树了。

## 继承什么，不继承什么

这张表是这一节最该记住的东西：

| 项 | 子代理 | 为什么 |
| --- | --- | --- |
| policy / sandboxMode | **继承** | 子代理不能比父更宽松，否则派生就成了提权 |
| abort signal | **继承** | 父被取消，子必须一起停，否则留下孤儿 run 继续烧 token |
| model config | 继承 | 暂不支持子代理换模型 |
| `toolState.readFilePaths` | **不继承，重新开** | 见下 |
| 对话历史 | **不继承** | 独立 context window 就是它的全部意义 |

`readFilePaths` 那条值得展开。第 12 章立了个规矩：`edit` 之前必须先 `read`。这个记录存在 `context.toolState.readFilePaths` 里。

如果子代理继承它，就出现这种情况：父代理读过 `lib/agent.ts`，子代理没读过，但因为继承了记录，它可以直接改。**安全联锁被派生动作绕过了。**

所以子代理拿到的是空集合，要改文件自己先读。代码里把这个理由钉在了创建处：

```ts
toolState: {
  // 故意不被子代理继承：read-before-edit 是一道安全联锁，派生出来的 run
  // 必须自己重新读一遍才能获得它。
  readFilePaths: new Set<string>(),
},
```

## 防止 fork 炸弹

子代理也能派生子代理。不设限，一个绕进死循环的模型能把机器跑满。

上限是 2，但**实现方式比数字重要**：

```ts
if (toolDefinition.name === 'task') {
  return (
    (visibility.canSpawnSubagents ?? false) &&
    (visibility.spawnDepth ?? 0) < MAX_SUBAGENT_SPAWN_DEPTH
  );
}
```

这是**工具可见性**判断，不是调用时的报错。到了深度上限，模型的工具列表里根本没有 `task` 这个东西。

为什么不做成"调用时返回错误"：**模型看不见的工具，它没法花一轮去争辩。** 如果返回错误，模型很可能换个说法再试一次，白烧一轮 token——而答案永远是不行。

同样的道理也用在没配 spawner 的 run 上：`task` 直接不出现，而不是出现了然后必定失败。

## 别忘了记账

子代理烧的 token 是真金白银。它跑在自己的 run 里，用量自然记在自己的账上：

```ts
} finally {
  // 把子 run 的模型调用汇总进父的总账。少了这一步，一个把大部分工作
  // 都委托出去的 run，报出来的 token 数会远小于实际收到的账单。
  spawnerInput.parentModelCallUsages.push(...modelCallUsages);
}
```

放在 `finally` 里：子代理失败了，它烧掉的 token 一样得算。

## 存储层的一个坑

加完子会话文件，会话列表接口会崩。

`listAgentSessionPathsFromDirectory` 是递归抓所有 `*.jsonl` 的，而 `createAgentSessionSummary` 在首条记录不是 `session_meta` 时直接抛错。子代理的文件躺在扫描树下面，会被当成顶层会话——然后整个列表接口挂掉。

修法是显式跳过：

```ts
if (entry.name === SUBAGENTS_DIRECTORY) {
  continue;
}
```

注释里写清楚了为什么：

> 绝不递归进 `subagents/` 伴生目录。那些 transcript 是真正的会话文件，不跳过的话它们会被当成顶层 run 列出来——一个子代理没有理由和派生它的 run 并排出现在会话列表里。子代理是通过 `listSubagentSessionSummaries` 被**主动**取到的。

这类坑的共同特征：**新增一种文件，先问一遍"谁在扫这个目录"**。

---

← 上一节：[03 · 两张图，不是一张](03-two-graphs.md) · [章目录](README.md) · 下一节：[05 · 不绑厂商的出口](05-export-without-a-vendor.md)
