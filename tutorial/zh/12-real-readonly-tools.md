# 12. 真实只读工具

本章说明为什么项目移除 toy capability，改用真实的只读文件探索工具。Agent 需要面对真实代码库，不能长期用定制化玩具工具证明能力。

读完本章后，应该理解：

- `ls`、`find`、`grep`、`read` 分别解决什么问题
- 为什么先做专用只读工具，而不是直接开放 shell
- path policy 如何影响文件访问范围
- 输出截断和 debug details 为什么要分开

## 背景

Toy tool 证明了工具机制，但没有让 agent 真的有用。

Coding agent 需要探索本地项目。第一组真实工具就是只读文件探索。

## Tool Set

当前 active built-ins：

```text
ls      list directory entries
find    find files by pattern
grep    search file contents with ripgrep
read    read UTF-8 text with line pagination
```

当前实现位于：

```text
lib/agent-builtins.ts
```

已提交版本曾使用 `lib/agent-workspace-tools.ts`；后来 tool contract boundary 被重命名和泛化后，该文件被移除。

## 为什么不先做 Shell

Shell 很强，但会带来困难问题：

- process sandboxing
- command approval
- destructive commands
- output streaming and truncation
- long-running sessions
- process tree cancellation

只读工具让 agent 先获得真实能力，同时推迟这些风险。

## Path Policy

当前工具使用：

```text
current_project
```

Path policy code 位于：

```text
lib/agent-path-policy.ts
```

相对路径从项目根解析。Allowed root 外的路径变成模型可见 tool error。

## Output Limits

Tools 不会把无限输出塞进 history。

例子：

- `read` 支持 `offset` 和 `limit`
- `grep` 有 match limits 和 byte limits
- `find` 和 `ls` 返回 deterministic bounded lists
- notices 会告诉模型如何继续

这很重要，因为 tool output 会进入 model-visible history。

## Model-Facing vs Debug Details

模型看到 compact text。

Debug UI 可以看到 structured details。

这个拆分很关键：模型不应该解析内部 JSON，但人类需要足够结构来检查发生了什么。

## Tests

`tests/agent-builtins.test.ts` 覆盖：

- 文件内容和 line metadata
- path escape rejection
- pagination notices
- strict-mode `null` optional arguments
- 真实 `rg` 执行
- deterministic `find` 和 `ls`
- timeout 和 abort 通过 runtime 表达

## Git 证据

相关提交：

```text
0b1c88f Add workspace read tools
```

在此之后的演化把这一层从 workspace tools 重命名为 built-in read-only tools，并移除了 toy tool：命名不再暗示"只能访问 workspace"，访问范围完全交给 path policy 决定。

## 常见误解

### 误解一：有 shell 就不需要专用工具

Shell 很灵活，但也更难控权限、截断、输出格式和安全策略。专用只读工具先提供稳定、结构化、低风险的探索能力。

### 误解二：read/grep 天然只能访问 workspace

工具名称不应该决定访问范围。访问范围应该由 path policy 决定，例如 current project、allowed roots 或 danger full access。

### 误解三：工具输出越完整越好

模型上下文有限。工具应该返回足够有用且可控的文本，并在截断时给出行动提示，而不是无限输出。

## 本章小结

这一章把 agent 从 toy tool 推向真实文件探索：专用只读工具提供可控能力，path policy 管理访问范围，输出格式兼顾模型可读和 debug 可查。
