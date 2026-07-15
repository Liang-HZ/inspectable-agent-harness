# 15. Tool Contract Boundary 与 Toy 移除

本章说明工具定义如何从“几个内置函数”升级为 agent 自己的工具契约。这个契约为 builtin、dynamic、MCP、hosted 等来源预留统一注册和适配空间。

读完本章后，应该理解：

- tool source、group、path policy、execution mode 分别表达什么
- provider schema 为什么从 agent tool contract 编译出来
- toy tool 为什么必须从默认能力中移除
- 当前 built-in tools 如何组合成只读探索和编辑能力

## 背景

工具文件已经变得太大、太具体。更重要的是，`workspace tools` 这种名字对未来太窄。

`read`、`write`、`grep`、`find` 不应该天然意味着只能在 workspace 内使用。Path access 应该取决于 policy：

```text
current project
allowed roots
danger full access
```

## New Contract

Provider-neutral tool definition 现在位于：

```text
lib/agent-tool-contracts.ts
```

它记录：

```text
source        builtin | dynamic | mcp | hosted
group         utility_builtins | read_only_builtins | editing_builtins | shell_builtins
category      utility | read | search | write | shell
annotations   readOnly / destructive / openWorld / idempotent
execution     executionMode, timeoutMs, abortable
pathAccess    none | current_project | allowed_roots | danger_full_access
modelTool     provider-neutral model-facing schema
execute       concrete handler
```

## Tool Groups

`lib/agent-tools.ts` 现在组合 groups：

```text
utility_builtins     empty
read_only_builtins   ls/find/grep/read
editing_builtins     write/edit
shell_builtins       empty
```

shell group 不是 dead code。它是明确的未来能力插槽。

## Built-In Tools

具体 read-only built-ins 移到：

```text
lib/agent-builtins.ts
```

具体 editing built-ins 位于：

```text
lib/agent-editing-builtins.ts
```

Path policy 移到：

```text
lib/agent-path-policy.ts
```

这让未来在不同 access modes 下复用文件工具成为可能。

editing tools 只会在 run policy 允许时暴露给 provider。`read_only` run 只暴露
`ls/find/grep/read`；`workspace_write` run 额外暴露 `write/edit`。runtime
dispatch 时仍然会检查 permission，所以隐藏的 write-capable call 不能绕过 policy。

## Provider Boundary

Provider dialect 只接收 `modelTool`。

它们不会接收：

- source
- group
- category
- path policy
- permission annotations
- timeout
- abortable

这些是 runtime facts，不是 provider wire facts。

## Toy Tool Removal

临时 text-counting tool 被移除。

前端默认 task 现在通过 `ls/find/grep/read` 测试真实 project exploration。

这是一个重要清理：agent 应该在真实文件探索上被测试，而不是在自定义 demo function 上。

## Tests

`tests/agent-tool-contracts.test.ts` 验证：

- active groups
- tool metadata
- provider-visible tool stripping
- path policy behavior

## 当前状态

这一层确立了 agent 自己的工具契约边界，并在 `docs/evolution.md` 中记录为 Tool Runtime Boundary v1。

## 常见误解

### 误解一：工具名就是工具分类

工具名只是调用标识。真正的分类来自 source、group、path policy 和 execution mode。

### 误解二：移除 toy tool 会削弱演示能力

相反，移除 toy tool 让演示更真实。默认场景应该使用 `ls`、`find`、`grep`、`read` 这些可迁移到真实项目的能力。

### 误解三：provider schema 就是工具契约

Provider schema 是 wire representation。Agent 自己的工具契约才是 runtime 事实来源。

## 本章小结

这一章建立了工具注册和适配的长期边界：工具先属于 agent contract，再由 provider dialect 编译成外部 schema。Toy tool 被移除，真实 built-in 工具成为默认能力。
