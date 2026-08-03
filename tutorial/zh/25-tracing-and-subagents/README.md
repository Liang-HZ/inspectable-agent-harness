# 第 25 章 · 一次 run 到底跑了什么

上一章：[24 · OS 级沙箱](../24-os-level-sandbox.md)

---

## 这一章要解决的问题

第 04 章就加了"可观测性"：结构化日志、`AgentStep`、调试事件流。第 07 章又把整个会话落成 JSONL。到现在为止，一次 run 里发生的每件事都被记下来了。

然后你会遇到一个问题：**记下来了，但答不出来。**

一次 run 跑了 40 秒。哪一步慢？是模型在想，还是某个工具卡住了？如果它调了三次 `grep`，是三次都慢，还是有一次特别慢？如果它派了个子代理去做调研，子代理花的时间算谁的？

这些问题的答案全都在日志里。但要拼出来，你得把几百行 JSONL 按时间排一遍，人肉配对"这个 `tool_started` 对应哪个 `tool_finished`"，然后自己算减法。

这不是"缺数据"，是**缺结构**。

读完这一章，同一次 run 会长成这样——这是一次真实运行的真实数据，不是示意图：

<style>
.trace-sample{border:1px solid var(--vp-c-divider,#2c3340);border-radius:8px;overflow:hidden;margin:20px 0}
.tw-head{padding:8px 12px;background:var(--vp-c-bg-soft,#181d25);border-bottom:1px solid var(--vp-c-divider,#2c3340);color:var(--vp-c-text-2,#8b96a8);font-size:12px}
.tw-scroll{max-height:520px;overflow-y:auto}
.tw-row{display:grid;grid-template-columns:minmax(190px,290px) 1fr 116px;gap:10px;align-items:center;padding:3px 12px;border-bottom:1px solid var(--vp-c-divider-light,#232a35)}
.tw-row:last-child{border-bottom:none}
.tw-label{display:flex;gap:6px;align-items:center;min-width:0}
.tw-kind{flex:none;border-radius:999px;padding:1px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.03em;font-weight:600}
.tw-kind-run{background:#1f3a52;color:#cfe6ff}
.tw-kind-model{background:#1f3f3a;color:#bfe9de}
.tw-kind-tool{background:#3a3320;color:#f0dcae}
.tw-kind-subagent{background:#5a4410;color:#ffd98a}
.tw-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vp-font-family-mono,ui-monospace,Menlo,monospace);font-size:12px}
.tw-mult{opacity:.6;font-size:11px}
.tw-track{position:relative;height:9px;background:var(--vp-c-bg-soft,#181d25);border-radius:3px}
.tw-bar{position:absolute;top:0;height:9px;border-radius:3px;min-width:2px}
.tw-bar-run{background:#4b7ba8}
.tw-bar-model{background:#3f8f7f}
.tw-bar-tool{background:#b08a3c}
.tw-bar-subagent{background:#e0a83c}
.tw-meta{text-align:right;color:var(--vp-c-text-2,#8b96a8);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.tw-tok{margin-right:6px;opacity:.75}
</style>
<div class="trace-sample">
<div class="tw-head"><strong>114</strong> spans · 559.60s · deepseek-v4-flash</div>
<div class="tw-scroll">
<div class="tw-row"><div class="tw-label" style="padding-left:0px"><span class="tw-kind tw-kind-run">run</span><span class="tw-name">agent run</span></div><div class="tw-track"><div class="tw-bar tw-bar-run" style="margin-left:0.000%;width:100.000%"></div></div><div class="tw-meta"><span>559.60s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:0.001%;width:0.437%"></div></div><div class="tw-meta"><span>2.44s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">find</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:0.438%;width:0.400%"></div></div><div class="tw-meta"><span>30ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">find</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:0.438%;width:0.400%"></div></div><div class="tw-meta"><span>26ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:0.443%;width:0.400%"></div></div><div class="tw-meta"><span>1.89s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">ls</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:0.781%;width:0.400%"></div></div><div class="tw-meta"><span>10ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:0.781%;width:0.400%"></div></div><div class="tw-meta"><span>34ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:0.790%;width:1.563%"></div></div><div class="tw-meta"><span>8.74s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">ls</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:2.354%;width:0.400%"></div></div><div class="tw-meta"><span>20ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">task</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:2.358%;width:16.156%"></div></div><div class="tw-meta"><span>90.41s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:28px"><span class="tw-kind tw-kind-subagent">subagent</span><span class="tw-name">subagent <span class="tw-mult">↓ 10×model 49×tool</span></span></div><div class="tw-track"><div class="tw-bar tw-bar-subagent" style="margin-left:4.502%;width:14.007%"></div></div><div class="tw-meta"><span>78.38s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:30.237%;width:3.025%"></div></div><div class="tw-meta"><span>16.93s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:33.263%;width:0.400%"></div></div><div class="tw-meta"><span>50ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">task</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:33.273%;width:20.087%"></div></div><div class="tw-meta"><span>112.41s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:28px"><span class="tw-kind tw-kind-subagent">subagent</span><span class="tw-name">subagent <span class="tw-mult">↓ 9×model 15×tool</span></span></div><div class="tw-track"><div class="tw-bar tw-bar-subagent" style="margin-left:45.295%;width:8.063%"></div></div><div class="tw-meta"><span>45.12s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:56.166%;width:1.668%"></div></div><div class="tw-meta"><span>9.33s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">ls</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:57.835%;width:0.400%"></div></div><div class="tw-meta"><span>6ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:57.836%;width:0.400%"></div></div><div class="tw-meta"><span>3ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">task</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:57.837%;width:11.021%"></div></div><div class="tw-meta"><span>61.67s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:68.861%;width:2.636%"></div></div><div class="tw-meta"><span>14.75s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:71.498%;width:0.400%"></div></div><div class="tw-meta"><span>21ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:71.500%;width:0.400%"></div></div><div class="tw-meta"><span>12ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">grep</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:71.500%;width:0.400%"></div></div><div class="tw-meta"><span>277ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:82.522%;width:2.295%"></div></div><div class="tw-meta"><span>12.84s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:84.817%;width:0.400%"></div></div><div class="tw-meta"><span>6ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:84.817%;width:0.400%"></div></div><div class="tw-meta"><span>9ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">read</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:84.817%;width:0.400%"></div></div><div class="tw-meta"><span>7ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">ls</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:84.817%;width:0.400%"></div></div><div class="tw-meta"><span>3ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">find</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:84.817%;width:0.400%"></div></div><div class="tw-meta"><span>11ms</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-model">model</span><span class="tw-name">chat deepseek-v4-flash</span></div><div class="tw-track"><div class="tw-bar tw-bar-model" style="margin-left:84.820%;width:1.540%"></div></div><div class="tw-meta"><span>8.62s</span></div></div>
<div class="tw-row"><div class="tw-label" style="padding-left:14px"><span class="tw-kind tw-kind-tool">tool</span><span class="tw-name">task</span></div><div class="tw-track"><div class="tw-bar tw-bar-tool" style="margin-left:86.360%;width:13.639%"></div></div><div class="tw-meta"><span>76.33s</span></div></div>
</div>
</div>

主 agent 读完文件后派了子代理。子代理有**自己的 context window、自己的会话文件**，
但它的 span 落在父级 `task` 那根条里——因为它继承了父级的 trace id。
上面为了看清形状把子代理内部折叠了，
[完整的 114 行在这里](/trace-sample.html)。

这一章做两件事：

1. 给已有的事件流补上 span 语义——起止时刻、父子嵌套——让"哪一步慢"变成一眼能看的东西。
2. 补上 subagent：第 23 章的差距表里，`Subagent` 那一行写的是"无"。这一章把它填上，顺便让它成为 trace 结构的第一个真正的考验——因为子代理跑在**另一个会话文件**里，链路必须跨文件接起来。

## 这一章不做什么

不引入任何观测厂商的 SDK。

这不是洁癖。第 05 节会讲清楚：你真正需要绑定的东西是**语义约定**，不是某个后端。绑错了层，换后端就要改主循环；绑对了层，换后端是改一个环境变量。

## 读完这一章，你能做到

1. 打开一次 run 的瀑布图，指着最长的那根条说"时间花在这儿"。
2. 一个子代理跑在独立的 context window 和独立的文件里，你仍然能看到它嵌在派生它的那次工具调用下面。
3. 把同一次 run 导进两个不同的开源观测后端，不改一行 harness 代码。
4. 断网、不装任何后端，照样能看完整链路——因为数据一直在你自己的文件里。

## 小节

| # | 小节 | 讲什么 |
| --- | --- | --- |
| 01 | [答不出来的那个问题](01-the-question-you-cant-answer.md) | 日志齐全，但"哪一步慢"要人肉拼 |
| 02 | [事件流不等于 trace](02-events-are-not-a-trace.md) | 差的是起止和嵌套，不是数据量 |
| 03 | [两张图，不是一张](03-two-graphs.md) | 消息血缘和 span 树是正交的，都得留 |
| 04 | [子代理跑在别的文件里](04-the-subagent-problem.md) | 跨文件的父子关系靠什么接 |
| 05 | [不绑厂商的出口](05-export-without-a-vendor.md) | 该绑的是语义约定，不是后端 |
| 06 | [这一章花了多少钱](06-what-it-cost.md) | 依赖账、实测踩的坑、还差什么 |

## 动手之前

确认测试全绿：

```bash
npm test
```

从 [01 · 答不出来的那个问题](01-the-question-you-cant-answer.md) 开始。
