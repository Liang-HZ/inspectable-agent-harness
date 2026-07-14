# 18. Shell 工具与命令安全分类

本章解释 harness 的第一个 shell 能力:`shell` 工具如何执行命令、输出如何截断、以及为什么它需要一个独立于 annotations 的 safe-command 分类器。

读完本章后,应该理解:

- 为什么 shell 是文件工具之后最重要的能力缺口
- Codex CLI 和 Claude Code 如何界定 shell 的安全边界
- safe-command 分类器允许什么、拒绝什么、为什么故意保守
- tool-level permission override 如何叠加在通用 permission 决策之上
- timeout、输出截断和 kill 语义如何防止 shell 拖垮 runtime

## 背景

在这个能力出现之前,模型只有 `ls`/`find`/`grep`/`read` 和 `write`/`edit`。但真实 coding 任务里大量动作只能通过 shell 完成:`git status`、`git diff`、`wc -l`、运行测试、安装依赖。

对标的两个系统都把 shell 当作核心工具:

- Codex CLI 的 `shell` 工具接收命令,配合 sandbox policy(`read-only` / `workspace-write` / `danger-full-access`)和 approval policy(`untrusted` / `on-failure` / `on-request` / `never`)决定是否需要用户批准。已知安全的只读命令(如 `ls`、`cat`、`git status`)即使在最严格的策略下也会自动放行。
- Claude Code 的 `Bash` 工具有 timeout 上限、输出截断,并用 permission rule(allowlist 前缀匹配)决定哪些命令免批准。

这个项目采用同样的分层思路,但保持教学尺寸:一个 `shell` 工具、一个可测试的 classifier、一个 tool-level override 边界。

## 工具契约

`lib/agent-shell-builtins.ts` 定义了 `shell` 工具:

```text
command    必填。用 bash -c 执行的命令字符串
workdir    可选。相对路径从项目根解析,受 path policy 约束
timeoutMs  可选。1000 到 60000 之间,默认 10000
```

运行时元数据:

```text
group:          shell_builtins
category:       shell
annotations:    readOnly=false, destructive=true, openWorld=true
executionMode:  sequential
timeoutMs:      60000(runtime 硬上限)
pathAccess:     current_project
```

两层 timeout 是有意的:定义级 `timeoutMs: 60000` 是 runtime 强制的硬顶,模型传的 `timeoutMs` 是 per-call 软超时,由工具自己实现并在超时后 kill 子进程。这样模型可以为慢命令申请更长时间,但永远顶不穿 runtime 上限。

## Safe-Command 分类器

`lib/agent-shell-safety.ts` 回答一个问题:这条命令是否属于已知只读模式?

它的输出是一个二值决策:

```text
safe          已知只读模式,可以自动放行
needs_review  无法证明只读,交回给 approval policy
```

分类顺序:

1. 任何 shell 控制结构直接 `needs_review`:`;`、`&&`、`||`、`&`、`>`、`<`、反引号、`$`、换行。分类器不做 bash 语义分析,所以拒绝分析这些结构。
2. 命令按 `|` 拆成 pipeline segments,每一段独立判断,全部安全才算安全。`grep -c export lib/agent.ts | cat` 是安全的;`cat a.txt | sh` 不是。
3. 每段用一个只支持引号的迷你 tokenizer 拆词。出现反斜杠转义或未闭合引号,直接 `needs_review`。
4. `argv[0]` 必须在只读命令白名单里:`ls`、`cat`、`grep`、`rg`、`head`、`tail`、`wc`、`find`、`git` 等。
5. 两个命令有额外的参数检查:`find` 不允许 `-delete`/`-exec` 等动作 flag;`git` 只允许 `status`/`log`/`diff`/`show` 等只读 subcommand,`git branch` 只允许纯列举用法。

关键设计取舍:**分类器宁可漏放,不可错放**。`echo $HOME` 明明无害,但 `$` 被拒绝,因为允许变量展开意味着要分析展开后的结果。保守的代价是多一次 approval,错放的代价是执行了未经批准的任意命令。

这正是 Codex `is_known_safe_command` 的思路:白名单精确模式,其余全部走 approval。

## Tool-Level Permission Override

通用 permission 决策(`decideAgentToolPermission`)只看 annotations 和 policy,不解析工具参数。但 shell 的风险完全取决于参数里的命令内容——`ls` 和 `rm -rf` 在 annotations 层长得一模一样。

所以 tool contract 增加了一个可选边界:

```ts
decidePermission?: (
  argumentsJson: string,
  policy: AgentRunPolicy,
) => AgentPermissionDecision | undefined;
```

runtime 的合成规则在 `agent-tool-runtime.ts`:

```text
1. 先跑通用决策
2. 通用决策 deny 直接生效(path policy、read-only write 等否决不可被工具推翻)
3. 否则工具 override 有返回值就用它,decision source 标记为 tool_override
4. override 返回 undefined 则回落到通用决策
```

shell 的 override 逻辑:

```text
command 缺失或空          -> deny VALIDATION_ERROR
分类器判 safe             -> allow (tool_override)
分类器判 needs_review:
  sandboxMode read_only   -> deny PERMISSION_DENIED
  其他 sandbox mode       -> undefined,回落通用策略
```

回落到通用策略后,`approvalPolicy: never` 会放行,其他策略会因为 destructive/openWorld annotations 进入 `ask`。

这带来一个重要的能力变化:**shell 在 read-only run 里也可见**。之前 `shell_builtins` 在 read-only 模式下整组隐藏;现在模型在最保守的模式里也能跑 `git log`,只是任何非白名单命令都会在 permission 边界被拒绝。

## 权限行为矩阵

| 命令 | sandbox | approval | 结果 |
| --- | --- | --- | --- |
| `git status` | 任意 | 任意 | allow(tool_override) |
| `npm test` | read_only | 任意 | deny(read-only run) |
| `npm test` | workspace_write | never | allow(policy) |
| `npm test` | workspace_write | on_request/strict | ask -> 当前仍 fail closed |
| `pwd`,workdir 越界 | 任意 | 任意 | deny(path policy,不可被 override 推翻) |

`ask` 分支目前仍然抛 `AgentApprovalRequiredError`——interactive approval/resume 是下一章的主题。

## 执行语义

`bash -c` 启动子进程,`stdio` 里 stdin 直接 ignore(没有交互能力,这是有意的边界)。

输出按流收集,每个流两个上限:

```text
10240 chars
256 lines
```

超限即截断并打标,model-visible 输出末尾出现 `[stdout truncated to ...]` notice。

对照参考实现:Codex 当前版本在采集侧给 1 MiB 硬上限、把 stdout/stderr 合并成一条流,呈现给模型前按 per-model 预算做**中间截断**(保头保尾砍中间),截断时报告总行数;Claude Code 默认 30000 字符,新版本超限会把完整输出落盘并只给模型文件路径加预览。本项目取最简单的教学版本:每个流独立、头部保留式截断。中间截断和落盘是记录在案的后续增强方向(见 `docs/research-codex-claude-code.md`)。

结束路径有三条:

- 正常退出:exit code(包括非零)作为 **success output** 呈现给模型。命令失败是模型要看到的信息,不是 runtime 错误。
- per-call 超时:kill 子进程,返回 `TIMEOUT` 错误,并附带超时前的 partial output 尾部,让模型知道命令进行到哪里。
- run 级 abort:runtime 的 abort signal 触发同样的 kill 路径。

模型看到的格式:

```text
Command: git status
Workdir: .
Exit code: 0 (34ms)

stdout:
On branch feat/agent-usable-v1
...

stderr:
(empty)
```

## 还没做什么

- **没有 OS-level sandbox**。workspace_write + never 策略下,unsafe 命令直接在你的机器上执行。Codex 在 macOS 用 Seatbelt、Linux 用 Landlock 做 OS 强制;这个项目当前唯一的强制层是 permission 边界本身。
- **没有 PTY/交互式会话**。stdin 被 ignore,`vim`、`top` 这类命令会挂到超时。
- **没有后台执行**。长命令只能靠 timeoutMs 提高上限。
- **approval 的 ask 仍然 fail closed**。下一章解决。

## 哪些测试证明它

`tests/agent-shell-builtins.test.ts`:

- 分类器 safe/needs_review 的代表性命令矩阵
- read-only run:safe 命令放行、unsafe 命令 deny
- workspace_write + on_request:unsafe 命令抛 approval required
- workdir 越界被 path policy 拒绝(override 推翻不了)
- 非零 exit code 是正常输出、超大输出截断、`sleep 30` 在 1 秒超时被 kill
- 空 command 在 permission 边界返回 VALIDATION_ERROR

## 本章小结

shell 能力的核心不是 `spawn`,而是三个边界的叠加:参数感知的 safe-command 分类器、deny 不可推翻的 permission 合成规则、以及 timeout/截断/kill 的资源边界。这三层让"给模型一个 shell"从鲁莽变成可审计。
