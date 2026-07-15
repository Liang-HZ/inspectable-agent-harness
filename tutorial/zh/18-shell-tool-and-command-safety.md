# 18. Shell 工具与命令安全分类

本章解释 harness 的第一个 shell 能力：`shell` 工具如何执行命令、输出如何截断、以及为什么它需要一个独立于 annotations 的 safe-command 分类器。

读完本章后，应该理解：

- 为什么 shell 是文件工具之后最重要的能力缺口
- Codex CLI 和 Claude Code 如何界定 shell 的安全边界
- safe-command 分类器允许什么、拒绝什么、为什么故意保守
- tool-level permission override 如何叠加在通用 permission 决策之上
- timeout、输出截断和 kill 语义如何防止 shell 拖垮 runtime

## 背景

在这个能力出现之前，模型只有 `ls`/`find`/`grep`/`read` 和 `write`/`edit`。但真实 coding 任务里大量动作只能通过 shell 完成：`git status`、`git diff`、`wc -l`、运行测试、安装依赖。

对标的两个系统都把 shell 当作核心工具：

- Codex CLI 的 `shell` 工具接收命令，配合 sandbox policy(`read-only` / `workspace-write` / `danger-full-access`)和 approval policy(`untrusted` / `on-failure` / `on-request` / `never`)决定是否需要用户批准。已知安全的只读命令(如 `ls`、`cat`、`git status`)即使在最严格的策略下也会自动放行。
- Claude Code 的 `Bash` 工具有 timeout 上限、输出截断，并用 permission rule(allowlist 前缀匹配)决定哪些命令免批准。

这个项目采用同样的分层思路，但保持教学尺寸：一个 `shell` 工具、一个可测试的 classifier、一个 tool-level override 边界。

## 工具契约

`lib/agent-shell-builtins.ts` 定义了 `shell` 工具：

```text
command    必填。用 bash -c 执行的命令字符串
workdir    可选。相对路径从项目根解析,受 path policy 约束
timeoutMs  可选。1000 到 60000 之间,默认 10000
```

运行时元数据：

```text
group:          shell_builtins
category:       shell
annotations:    readOnly=false, destructive=true, openWorld=true
executionMode:  sequential
timeoutMs:      60000(runtime 硬上限)
pathAccess:     current_project
```

两层 timeout 是有意的：定义级 `timeoutMs: 60000` 是 runtime 强制的硬顶，模型传的 `timeoutMs` 是 per-call 软超时，由工具自己实现并在超时后 kill 子进程。这样模型可以为慢命令申请更长时间，但永远顶不穿 runtime 上限。

## Safe-Command 分类器

`lib/agent-shell-safety.ts` 回答一个问题：这条命令是否属于已知只读模式?

它的输出是一个二值决策：

```text
safe          已知只读模式,可以自动放行
needs_review  无法证明只读,交回给 approval policy
```

分类顺序：

1. 任何 shell 控制结构直接 `needs_review`:`;`、`&&`、`||`、`&`、`>`、`<`、反引号、`$`、换行。分类器不做 bash 语义分析，所以拒绝分析这些结构。
2. 命令按 `|` 拆成 pipeline segments，每一段独立判断，全部安全才算安全。`grep -c export lib/agent.ts | cat` 是安全的；`cat a.txt | sh` 不是。
3. 每段用一个只支持引号的迷你 tokenizer 拆词。出现反斜杠转义或未闭合引号，直接 `needs_review`。
4. `argv[0]` 必须在只读命令白名单里：`ls`、`cat`、`grep`、`rg`、`head`、`tail`、`wc`、`find`、`git` 等。
5. 命令名在白名单里还不够，参数也要筛查——因为 safe 命令会完全跳过 approval。任何指向项目外的路径参数（绝对路径、`~` 开头、含 `..` 段，包括 `--flag=value` 里的值）都降级 `needs_review`：`cat` 是只读命令，但 `cat /etc/passwd` 不是只读模式。
6. 能写文件或执行程序的 flag 按命令拒绝：`sort`/`tree` 拒绝 `-o`/`--o` 前缀（同时覆盖 `-ofile` 这类粘连形式和 `--out=` 这类 GNU 长选项缩写）；`rg` 拒绝 `--pre`/`--hostname-bin`；`uniq` 最多一个位置参数（第二个位置参数是输出文件）；`find` 不允许 `-delete`/`-exec` 等动作 flag；`git` 只允许 `status`/`log`/`diff`/`show` 等只读 subcommand，拒绝 subcommand 之前的全局 flag（`-C`、`-c`、`--git-dir`、`--exec-path` 能重定向仓库或改变 git 执行的程序）和 subcommand 之后的 `--output`，`git branch` 只允许纯列举用法。

关键设计取舍：**分类器宁可漏放，不可错放**。`echo $HOME` 明明无害，但 `$` 被拒绝，因为允许变量展开意味着要分析展开后的结果。保守的代价是多一次 approval，错放的代价是执行了未经批准的任意命令。

这正是 Codex `is_known_safe_command` 的思路：白名单精确模式，其余全部走 approval。

## Tool-Level Permission Override

通用 permission 决策(`decideAgentToolPermission`)只看 annotations 和 policy，不解析工具参数。但 shell 的风险完全取决于参数里的命令内容——`ls` 和 `rm -rf` 在 annotations 层长得一模一样。

所以 tool contract 增加了一个可选边界：

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

shell 的 override 逻辑：

```text
command 缺失或空          -> deny VALIDATION_ERROR
分类器判 safe             -> allow (tool_override)
分类器判 needs_review:
  sandboxMode read_only   -> deny PERMISSION_DENIED
  其他 sandbox mode       -> undefined,回落通用策略
```

回落到通用策略后，`approvalPolicy: never` 会放行，其他策略会因为 destructive/openWorld annotations 进入 `ask`。

这带来一个重要的能力变化：**shell 在 read-only run 里也可见**。之前 `shell_builtins` 在 read-only 模式下整组隐藏；现在模型在最保守的模式里也能跑 `git log`，只是任何非白名单命令都会在 permission 边界被拒绝。

## 权限行为矩阵

| 命令 | sandbox | approval | 结果 |
| --- | --- | --- | --- |
| `git status` | 任意 | 任意 | allow(tool_override) |
| `npm test` | read_only | 任意 | deny(read-only run) |
| `npm test` | workspace_write | never | allow(policy) |
| `npm test` | workspace_write | on_request/strict | ask -> 当前仍 fail closed |
| `pwd`,workdir 越界 | 任意 | 任意 | deny(path policy，不可被 override 推翻) |

`ask` 分支目前仍然抛 `AgentApprovalRequiredError`——interactive approval/resume 是下一章的主题。

## 执行语义

`bash -c` 启动子进程，`stdio` 里 stdin 直接 ignore(没有交互能力，这是有意的边界)。

子进程的环境变量是白名单构造的（`PATH`、`HOME`、`USER`、`TERM`、`TMPDIR`、`LANG`/`LC_*` 等无害变量），而不是继承完整的 `process.env`：否则一条被批准的 `printenv` 或 `env` 就会把 `OPENAI_API_KEY` 带进 model-visible 输出和 session JSONL。选白名单而不是"剔除已知秘密名"的黑名单，是因为黑名单永远列不全。

`workdir` 参数与文件工具走同一套 realpath-后复查序列：先按 path policy 解析路径，再对 `realpath` 的结果重新检查一遍 path policy。一个字面上在项目内的 workdir 仍可能是符号链接，真实目录在项目外——复查挡住这种逃逸。

输出按流收集，每个流两个上限：

```text
10240 chars
256 lines
```

超限即截断并打标，model-visible 输出末尾出现 `[stdout truncated to ...]` notice。

对照参考实现：Codex 当前版本在采集侧给 1 MiB 硬上限、把 stdout/stderr 合并成一条流，呈现给模型前按 per-model 预算做**中间截断**(保头保尾砍中间)，截断时报告总行数；Claude Code 默认 30000 字符，新版本超限会把完整输出落盘并只给模型文件路径加预览。本项目取最简单的教学版本：每个流独立、头部保留式截断。中间截断和落盘是记录在案的后续增强方向(见 `docs/research-codex-claude-code.md`)。

结束路径有三条：

- 正常退出：exit code(包括非零)作为 **success output** 呈现给模型。命令失败是模型要看到的信息，不是 runtime 错误。
- per-call 超时：kill 子进程，返回 `TIMEOUT` 错误，并附带超时前的 partial output 尾部，让模型知道命令进行到哪里。
- run 级 abort:runtime 的 abort signal 触发同样的 kill 路径。

模型看到的格式：

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

- **没有 OS-level sandbox**。workspace_write + never 策略下，unsafe 命令直接在你的机器上执行。Codex 在 macOS 用 Seatbelt、Linux 用 Landlock 做 OS 强制；这个项目当前唯一的强制层是 permission 边界本身。
- **没有 PTY/交互式会话**。stdin 被 ignore,`vim`、`top` 这类命令会挂到超时。
- **没有后台执行**。长命令只能靠 timeoutMs 提高上限。
- **approval 的 ask 仍然 fail closed**。下一章解决。

## 哪些测试证明它

`tests/agent-shell-builtins.test.ts`:

- 分类器 safe/needs_review 的代表性命令矩阵
- 白名单命令带路径逃逸或可写/可执行参数时降级 review（`cat /etc/passwd`、`sort -o` 等）
- read-only run:safe 命令放行、unsafe 命令 deny、带项目外参数的白名单命令 deny
- workspace_write + on_request:unsafe 命令抛 approval required
- workdir 越界被 path policy 拒绝(override 推翻不了)，指向项目外的 workdir 符号链接同样被拒
- 子进程环境不含 harness secrets（`OPENAI_API_KEY` 不会进入命令输出）
- 非零 exit code 是正常输出、超大输出截断、`sleep 30` 在 1 秒超时被 kill
- 空 command 在 permission 边界返回 VALIDATION_ERROR

## 为什么分类器不是安全边界

分类器的角色是**省审批**，不是执行边界。它回答的问题从头到尾只有一个："这条命令能不能跳过 approval"——它从来不是"这条命令执行后会发生什么"的裁决者。

这个区别不是理论上的。本章的分类器修复过一个真实漏洞：早期版本只看命令名，于是 read_only 模式下 `cat /etc/passwd` 免审放行（`cat` 在白名单里），`sort -o /tmp/x` 能越权写文件（`sort` 也在白名单里）。根因就是把"命令名安全"当成了"命令安全"。参数级筛查修掉了这两个洞，但要看清它修到了哪一层。

加上参数筛查之后，分类器仍然是一个**词法筛查**：它看的是命令字符串长什么样，不是命令运行时真正触碰什么。它跟不进符号链接——`cat ./innocent.txt` 在词法上完全干净，但如果 `innocent.txt` 是指向 `/etc/passwd` 的链接，读到的还是项目外的文件。它也看不见命令的运行时行为：一个白名单命令可以被 `PATH` 上的同名程序顶替（本项目用 env 白名单缓解了一部分，但没有根治）。词法筛查每堵一个洞，都还留着它原理上堵不住的洞。

生产 harness 的答案是在分类器下面再放一层 OS 级强制：Codex 在 macOS 用 Seatbelt、Linux 用 Landlock，把文件系统和网络访问在内核层锁死，命令字符串骗得过词法分析、骗不过内核；Claude Code 也有 sandbox 模式做同类隔离。在那种架构里，分类器负责减少审批打扰，沙箱负责兜底——两层各管一件事。

本项目明确不实现 OS 沙箱，把边界画在这里。这不是遗漏，而是教学取舍：OS 沙箱是平台相关的深水区，而"分类器省审批、permission 边界做决策、真正的执行强制缺位"这个结构本身就是要教的内容。使用这个 harness 时应该记住：unsafe 命令一旦被批准，就是在你的机器上裸跑。

## 本章小结

shell 能力的核心不是 `spawn`，而是三个边界的叠加：参数感知的 safe-command 分类器、deny 不可推翻的 permission 合成规则、以及 timeout/截断/kill 的资源边界。这三层让"给模型一个 shell"从鲁莽变成可审计。

## 本章验证点

本章修过的每个安全洞都留下了点名的测试用例，不需要 key 就能全部实跑：

```bash
npx tsx --test tests/agent-shell-builtins.test.ts
```

实测输出（截取安全相关用例和尾部统计）：

```text
✔ classifier flags safe-listed commands whose arguments escape the project or can write/execute (0.245667ms)
✔ shell rejects safe-listed commands with project-escaping arguments in read-only runs (0.501959ms)
✔ shell child process does not inherit harness secrets (6.399167ms)
✔ shell rejects a workdir symlink whose real directory is outside the project (1.300791ms)
✔ shell kills the command after the per-call timeout (1005.783917ms)
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

对照本章"为什么分类器不是安全边界"一节读这份清单：第一条覆盖 `cat /etc/passwd`、`sort -o` 这类白名单命令带危险参数的降级；第三条证明被批准的 `printenv` 也拿不到 `OPENAI_API_KEY`（子进程 env 是白名单构造的）；第四条证明字面上在项目内的 workdir 符号链接会被 realpath 复查挡住。整个文件跑完约 1.2 秒——其中 1 秒来自真实的 timeout kill 用例。
