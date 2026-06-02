# 17. 当前状态与下一步

本章总结当前 harness 已经真实具备的能力，以及下一阶段最值得推进的方向。它不是路线图承诺，而是从现有边界出发的工程判断。

读完本章后，应该理解：

- 当前项目已经具备哪些 agent 基础能力
- sandbox、write/edit、shell、approval resume 为什么仍然是空缺
- session replay 和 context compaction 为什么会成为后续关键能力
- 新章节应该如何继续保持教程可维护

## 现在真实存在什么

项目现在已经有真实可检查 agent harness 基础：

- thin Next.js API routes
- schema-first input validation
- OpenAI-compatible chat service
- streaming agent route
- cancellation boundary
- internal runtime events
- provider-neutral model gateway
- OpenAI Chat Completions dialect
- OpenAI Responses dialect
- OpenAI strict tool-schema adapter
- `AgentResponseItem` model-visible history
- streaming sampling loop
- assistant commit semantics
- deterministic runtime tests
- read-only tools: `ls`, `find`, `grep`, `read`
- path policy boundary
- tool runtime boundary
- permission skeleton
- structured tool output contract
- Debug Console
- JSONL session store and viewer
- tool source/group/path/execution contract
- unlimited loop with repeated-call guard

## 还缺什么

### Sandbox

当前 path policy 不是 OS sandbox。它只是 runtime path boundary。

下一个真实生产步骤是决定 sandbox modes 如何映射到 tools：

```text
read-only
workspace-write
danger-full-access
external sandbox
```

### Write/Edit

Write/edit 不应该是简单文件写入。它们需要：

- diff-oriented output
- approval decisions
- conflict behavior
- clear failure messages
- partial changes 相关测试

### Shell

Shell 需要：

- command schema
- timeout
- cancellation
- output truncation
- approval rules
- safe command classification
- 可能的 PTY/session support

### Approval Resume

当前 runtime 能发 approval-needed events，但还不能在批准后 pause/resume。

这需要 JSONL 中有 durable pending state。

### Session Replay

JSONL sessions 已经存在，但 replay 还没有。

Replay 需要重建：

- run metadata
- turn context
- response-item history
- 如果 crash 发生在 mid-turn，要 normalize missing tool outputs

### Context Compaction

长 history 最终需要 compaction。它必须保留：

- user goal
- current task state
- recent tool observations
- function_call/function_call_output invariants

### MCP / Dynamic / Hosted Tools

Tool contract 已经有 source categories。当前只有 built-ins active。

未来可以添加：

- dynamic tool registration
- MCP discovery and dispatch
- hosted provider tools
- tool-search/discovery

## 未来章节怎么加

每个新能力都应该新增或更新教程章节，包含：

```text
why the layer appeared
what boundary was introduced
what data flows through it
what tradeoff was accepted
which tests prove it
what remains deferred
```

这样教程会和代码一起生长，而不是事后补一份 README。

## 常见误解

### 误解一：不到 6000 行后端代码说明能力很少

代码行数不是能力质量的唯一指标。这个项目的价值在于边界清楚：provider dialect、runtime spine、tools、session、debug、streaming 和 tests 已经形成可继续扩展的骨架。

### 误解二：下一步一定要先做 sandbox

Sandbox 很重要，但也可以先做 session list/replay、telemetry export、tool registry 深化或教程完善。顺序取决于下一阶段最需要验证什么。

### 误解三：开源教程只需要介绍最终代码

这个项目的价值之一是演化过程。教程应该保留取舍和边界变化，但要用公共读者能理解的方式组织，而不是内部复盘口吻。

## 本章小结

当前项目已经具备真正 agent harness 的基础：模型循环、流式输出、真实只读工具、provider dialect、session 记录和 debug surface。下一步应该继续沿着同一原则推进：先定义边界，再实现能力，再用测试和教程固定下来。
