# Chapter 25 · What Actually Happened During That Run

Previous: [24 · OS-level sandbox](../24-os-level-sandbox.md)

---

## The problem this chapter solves

Observability arrived back in Chapter 04: structured logs, `AgentStep`, a debug
event stream. Chapter 07 persisted whole sessions to JSONL. By now, everything
that happens during a run is written down.

Then you hit this: **it is written down, and you still cannot answer the
question.**

A run took 40 seconds. Which step was slow? Was the model thinking, or did a
tool hang? If it called `grep` three times, were all three slow or just one? If
it delegated research to a subagent, whose time was that?

Every answer is in the log. But to assemble one you have to sort a few hundred
JSONL lines by time, pair up "which `tool_finished` belongs to which
`tool_started`" by hand, and do the subtraction yourself.

That is not missing data. It is **missing structure**.

By the end of this chapter the same run looks like this — real data from a real
run, not a mock-up:

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

The main agent read a file, then delegated to a subagent. That subagent has **its
own context window and its own session file**, yet its spans sit inside the
parent's `task` bar — because it inherited the parent's trace id. The subagent's
interior is folded here so the shape stays visible;
[all 114 rows are here](/trace-sample.html).

This chapter does two things:

1. Adds span semantics to the existing event stream — start and end, parent and
   child — so "which step was slow" becomes something you can see.
2. Adds subagents. Chapter 23's gap map lists `Subagent` as *none*. This chapter
   fills it in, and in doing so gives the trace structure its first real test:
   a subagent runs in **a different session file**, so the chain has to survive
   crossing a file boundary.

## What this chapter does not do

It does not pull in an observability vendor's SDK.

Not out of purism. Section 05 makes the case: the thing worth binding to is the
**semantic convention**, not a backend. Bind at the wrong layer and switching
backends means editing the sampling loop. Bind at the right one and switching
backends is an environment variable.

## After this chapter you can

1. Open a run's waterfall and point at the longest bar.
2. See a subagent — running in its own context window *and its own file* —
   nested under the tool call that spawned it.
3. Send the same run to two different open-source backends without touching a
   line of harness code.
4. Read the whole chain offline, with no backend installed, because the data was
   always in your own files.

## Sections

| # | Section | About |
| --- | --- | --- |
| 01 | [The question you cannot answer](01-the-question-you-cant-answer.md) | Complete logs, and "which step was slow" is still manual |
| 02 | [An event stream is not a trace](02-events-are-not-a-trace.md) | What is missing is identity and parentage, not volume |
| 03 | [Two graphs, not one](03-two-graphs.md) | Message lineage and the span tree are orthogonal; keep both |
| 04 | [The subagent runs in another file](04-the-subagent-problem.md) | What holds a parent/child link across files |
| 05 | [An exit that binds no vendor](05-export-without-a-vendor.md) | Bind the convention, not the backend |
| 06 | [What this chapter cost](06-what-it-cost.md) | Dependency budget, what broke, what is still missing |

## Before you start

Confirm the suite is green:

```bash
npm test
```

Start with [01 · The question you cannot answer](01-the-question-you-cant-answer.md).
