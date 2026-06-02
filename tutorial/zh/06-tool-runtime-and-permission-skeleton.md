# 06. Tool Runtime 与 Permission Skeleton

本章说明为什么工具执行不能只是一个函数调用。真正的 agent 工具需要 runtime 边界：准备参数、执行、处理错误、记录事件、应用权限策略。

读完本章后，应该理解：

- tool definition 与 tool execution runtime 的区别
- permission skeleton 为什么要先于危险工具出现
- tool facts 和 policy decision 为什么要分开
- runtime events 如何为前端和未来 telemetry 服务

## 背景

模型能请求工具后，一个危险诱惑出现了：直接在 agent loop 里调用工具。

那会让 loop 承担太多职责：

- registry lookup
- permission checks
- event emission
- error conversion
- tool execution
- output shaping

项目在增加更多工具前，把工具执行移到了 runtime boundary 后面。

## Tool Runtime Boundary

关键文件：

```text
lib/agent-tool-runtime.ts
```

它负责单次 tool call lifecycle：

```text
lookup tool
create permission request
decide permission
emit lifecycle events
execute handler
convert result
return AgentToolExecution
```

## Permission Skeleton

Permission layer 在：

```text
lib/agent-permissions.ts
```

它建模：

- tool annotations
- approval policy
- sandbox mode
- permission requests
- permission decisions

当前决策有意保持很小：

- safe read-only built-ins 可以运行
- approval-required path fail closed
- interactive approval resume deferred

## 为什么 tool facts 和 policy 分开

工具声明事实：

```ts
readOnly: true
destructive: false
openWorld: false
idempotent: true
```

Runtime 把 policy 应用到这些事实上。Tool 不自己决定是否允许运行。

这很重要，因为未来 user settings、project trust、sandbox mode 和 approval hooks 都应该影响决策，而不用改 tool handler。

## Runtime Events

Tool runtime 发出：

```text
tool_permission_decided
approval_requested
tool_started
tool_finished
```

这些 events 后来会在 Debug Console 中可见。

## Git 证据

相关提交：

```text
567da1f Add agent tool runtime boundary
cdd881c Add agent permission policy skeleton
```

## 推迟的工作

这一阶段没有实现：

- OS sandboxing
- approval resume
- user decision UI
- shell permission prompts
- write/edit confirmations

这是有意克制。Permission contract 在高风险工具之前出现。

## 常见误解

### 误解一：只读工具不需要 runtime

即使是只读工具，也需要参数校验、路径策略、输出截断、错误格式和事件记录。Runtime boundary 不是只为危险工具准备的。

### 误解二：permission policy 应该写在工具内部

工具内部应该描述事实，例如访问什么路径、是否写入、是否需要网络。是否允许执行应该由 policy 层决定。

### 误解三：先做 shell 更快

Shell 很强，但也带来最大安全面。先建立 runtime 和 permission skeleton，可以避免后续把安全策略塞进 shell handler。

## 本章小结

这一章把工具执行从普通函数提升为 runtime contract。工具描述能力，runtime 负责编排，permission skeleton 为未来 sandbox 和 approval 留出位置。
