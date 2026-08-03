← 上一节：[05 · 不绑厂商的出口](05-export-without-a-vendor.md) · [章目录](README.md)

# 06 · 这一章花了多少钱

## 依赖账

**新增运行时依赖：0 个。**

`package.json` 一个字没动。整章用到的外部能力只有两样，都在 Node 里现成：

- `crypto.randomBytes` — 生成 id
- `fetch` — 发 OTLP

OTLP 的 protobuf 编码是手写的（190 行）。这是这一章唯一一处"本可以装个库"的地方，选择不装的理由在第 05 节。

**新增代码**（不含教程）：

| 文件 | 干什么 |
| --- | --- |
| `lib/agent-trace.ts` | span 身份：id 生成、父子派生、时长 |
| `lib/agent-trace-tree.ts` | 事件流 → span 树（纯函数，可测） |
| `lib/agent-subagent.ts` | `task` 工具定义 + spawner 类型 |
| `lib/agent-otel-export.ts` | 会话文件 → OTLP span |
| `lib/agent-otlp-protobuf.ts` | OTLP protobuf 编码 |
| `components/agent-trace-waterfall.tsx` | 瀑布图 |

**新增测试 27 个**，全部不需要 API key。

## 后端选型：实测到的部分

| | Arize Phoenix | Langfuse |
| --- | --- | --- |
| 许可 | Apache-2.0 | 开源核心（部分企业功能另计） |
| 自托管形态 | **1 个容器** | **6 个容器**：web、worker、Postgres、ClickHouse、Redis、MinIO |
| 镜像体积 | **1.08 GB** | **约 3.95 GB**（web 1.29G + worker 1.09G + ClickHouse 802M + Postgres 476M + MinIO 160M + Redis 136M） |
| 空载内存 | **约 400 MiB** | **约 2.4 GiB**（六个容器实测合计） |
| 官方建议配置 | — | 4 核 / 16 G / 100 G 磁盘（生产） |
| OTLP/JSON | **拒收（415）** | 接受 |
| OTLP/protobuf | **接受（实测 200）** | **接受（实测 200）** |
| 端到端摄取 | **8/8 span 入库，父子正确** | **8/8 span 入库，父子正确** |
| 功能面 | trace + 评测 + 数据集 | trace + 评测 + prompt 管理 + 成本 |

以上加粗的数字都是在同一台开发机上实测的。"6 个容器"是它官方 `docker-compose.yml` 里数出来的，不是道听途说。

同一份导出打进 Langfuse 之后，它把 LLM span 自动识别成了自己原生的 `GENERATION` 类型，
子代理照样嵌在 `task` 底下——这正是第 05 节"两套属性名一起发"想要的结果。

## 排查记：一个把我骗了很久的 500

这段值得写下来，因为它的误导性极强。

Langfuse 六个容器起来之后，`curl localhost:3000` 对**所有路径**（包括首页）返回 500。
容器日志干净得反常：迁移完成、Next ready、init 脚本跑完，**一行 error 都没有**。

第一反应是"init 脚本挂了"，于是撤掉播种用的环境变量重建——**还是 500**。

真相是：宿主机的 3000 端口上跑着**另一个项目的 dev server**。macOS 上 `localhost`
优先解析到 IPv6，而那个进程监听的正是 IPv6 `*:3000`，所以每一次 curl 打的都是别人。
Langfuse 从头到尾好好的，它只是**一个请求都没收到**——这也正好解释了日志为什么那么干净。

戳破它的一步很便宜：**从容器内部再打一次**。

```
容器内 fetch localhost:3000  → failed
宿主机 curl localhost:3000   → 500
```

两个结果对不上。如果容器里真没人监听，宿主机该拿到连接拒绝，而不是一个渲染好的
500 页面。矛盾出现的那一刻，问题就不在容器里了。

教训不是"要小心端口冲突"，而是：**当一个组件的日志和它的外部表现互相矛盾时，
先怀疑你根本没在跟它说话。**

**这张表怎么用**：如果你只是想看清楚一次 run 的链路，Phoenix 的性价比明显更高——一个容器，随开随关，不用的时候不占资源。如果你要的是跨 run 的成本看板、prompt 版本管理、团队协作，那是 Langfuse 的地盘，代价是常驻六个容器。

而按第 05 节的做法，这个选择**随时可以改**：改一个 endpoint。

## 踩到的坑，按值得记的程度排

**1. 测试红了，先别改测试。**

给投影层加 span 字段，四个已有测试变红。真正的原因是那么写会给**旧事件**也加上 `span: undefined`，改了旧契约。改成只 spread 存在的字段之后，四个测试一个字没改就绿了——**这才是"我没破坏兼容"的证明**。如果当初直接把期望值改掉，就永远不会知道自己动了契约。

**2. 新增一种文件，先问"谁在扫这个目录"。**

子代理的 JSONL 一放进去，会话列表接口就崩了。见第 04 节。

**3. 容器 span 没有关闭事件。**

`run_succeeded` 在投影层被映射成 `{type:'done'}`，走的是结果通道，**不进 debug 事件流**。所以 span 树里 run 那一层永远等不到自己的结束事件——不处理的话，每一次成功的 run 在瀑布图上都显示成"未完成"，而这个信号本该只在出事时出现。

解法是从子节点推导容器的终点：

```ts
if (
  node.endedAtMs === undefined &&
  node.children.length > 0 &&
  !anyChildOpen &&
  latestEnd !== undefined
) {
  node.endedAtMs = latestEnd;
}
```

但有个前提：**显式测量到的终点优先**。`task` 有自己实测的时长，就算它下面挂着个没结束的东西，它也是关闭的。只有完全没有自己终点的容器才从子节点推。

这个 bug 是**看渲染出来的 HTML 时发现的**，不是测试发现的——当时所有测试都是绿的。值得记住：单元测试保证的是"你想到的那些情况"，把东西渲染出来看一眼，能撞见你没想到的。

**4. 「没有 span 字段」和「跳过这个事件」不是一回事。**

导出器用 `'span' in event ? event.span : undefined` 取 span，取不到就 `continue`——
这个跳过对旧会话是对的（它们本来就没有 span）。但 `run_succeeded`、`run_failed`、
`run_cancelled` 这三个终止事件**也没有 span 字段**，因为它们描述的是整个 run，
不是一段新的工作。于是它们全被跳过，后面那段"关闭根 span"的代码**永远执行不到**。

后果不是少了一条数据，而是**每一次 run 的根 span 都掉进兜底逻辑**，被标上
`agent.span_unterminated` 和 `STATUS_ERROR`——**成功的 run 在后端也显示成红的**。

这个 bug 骗人的地方在于：它看起来像"取消导致的报错"，而实际上跟取消无关，
成功的 run 一样中招。真正的修法是在 `run_started` 时记住根 span，终止事件用它来解析：

```ts
const isRunTerminalEvent =
  event.type === 'run_succeeded' ||
  event.type === 'run_failed' ||
  event.type === 'run_cancelled';
const span = isRunTerminalEvent ? runSpan : eventSpanContext(event);
```

顺带一个语义区分值得守住：`run_cancelled` 要关闭 span 并记下取消原因，
**不能**打上 `span_unterminated`。"被主动停掉"和"再也没回来"是两件不同的事，
而分清这两件事正是 trace 存在的意义。

**5. `.git` 在 worktree 里是文件，不是目录。**

跟本章无关，但如果你也按"每次改动开一个 worktree"的方式干活会撞上：第 24 章那条沙箱测试断言写 `.git/xxx` 会被拒绝并返回 `Operation not permitted`，而在 worktree 里 `.git` 是个文本文件，shell 先一步报 `Not a directory`。写入照样被挡住了，只是错误信息不同。

## 还差什么

**并行子代理。** 现在 `task` 是 `executionMode: 'sequential'`。批量调度器只在整批工具都是 parallel 时才并行，而并行的子代理需要审批队列先做成 per-run 的——否则一个子代理弹审批框会把兄弟们全卡住。

**压缩那次模型调用没有 span。** 第 21 章的上下文压缩会真的调一次模型，烧 token、花时间，但它只发 `history_compacted`，没有 model span。所以瀑布图上有一段时间是"空白"的。

**导出是手动触发的。** 没有做"run 结束自动导出"。做起来不难（`run_succeeded` 之后调一次），但要先想清楚失败重试和背压，否则一个挂掉的后端会拖慢 run——而那正好违背第 05 节"导出不在热路径上"的设计。

**没有跨 run 聚合。** 这是有意留给外部后端的，见第 05 节开头。

## 回头看第 23 章

差距表里 `Subagent` 那一行，从"无"变成了"有，深度上限 2，串行"。

但更值得注意的是这一章暴露的一个规律：**"记下来了"和"答得出来"是两件事。** 第 04 章加日志、第 07 章落 JSONL，都是在做前者。做完之后很容易觉得可观测性这块已经解决了。

真正让它变得可用的，是给数据补上两个很小的字段——身份和归属。

---

← 上一节：[05 · 不绑厂商的出口](05-export-without-a-vendor.md) · [章目录](README.md)
