# 24. OS 级沙箱：从词法筛查到内核强制

第 18 章把话说透了：`classifyShellCommandSafety` 是词法筛查，不是沙箱。它能拒绝 `cat /etc/passwd` 是因为它看到 `/etc/passwd` 这个字符串，但它跟不进符号链接、看不见运行时行为、也挡不住一条被批准的 unsafe 命令在 `workspace_write` 下做任何事。本章把那一层补上：在 `bash -c` 外面包一层 OS 原生沙箱，让命令字符串骗得过词法分析、骗不过内核。

读完本章后，应该理解：

- 为什么 OS 沙箱是"另一层"而不是"替换分类器"
- fail-closed 契约：沙箱二进制不可用时拒绝运行，而不是降级裸跑
- macOS Seatbelt（`sandbox-exec` + SBPL profile）的 `(deny default)` 模型
- Linux bubblewrap（`bwrap`）的 `--ro-bind / /` + `--bind <project>` + `--unshare-*` 模型
- 三档 `sandboxMode` 怎么映射到沙箱：`read_only` 只读、`workspace_write` 可写带 carveout、`danger_full_access` 显式 opt-out
- 为什么 `detached: true` + 进程组杀是 SIGKILL 通过 sandbox 二进制到达 bash 的必要条件

## 设计决策

### 沙箱是第二层，不是替代品

第 18 章的词法分类器保留原位，继续做"省审批"这件事--它能让 `ls`、`git status` 这类已知只读命令跳过 approval。OS 沙箱做的是"兜底"：即使一条 unsafe 命令被批准了、即使词法分类器被某种绕过骗过，内核仍然不允许它越出项目根、不允许它联网、不允许它改 `.git`。这是 Codex 和 Claude Code 共同的架构：分类器负责减少打扰，沙箱负责真正的执行边界。

### Fail-closed 契约

`read_only` 和 `workspace_write` 模式下，如果平台沙箱二进制缺失（Linux Server 上没装 `bwrap`、macOS 上 `sandbox-exec` 被 hardened runtime 禁用、平台是 Windows 暂未支持），shell 工具**拒绝执行**，返回 `EXECUTION_ERROR` + 清晰原因。绝不降级为裸 `bash -c`。

这跟 Codex 一致。Codex 的 `bundled_bwrap.rs` 注释写得很直白：`bubblewrap is unavailable: no system bwrap was found on PATH and no bundled codex-resources/bwrap binary was found next to the Codex executable`--panic 上抛，由外层 catch 成拒绝。

`danger_full_access` 是**唯一**的例外：它不是降级，而是用户显式 opt-out。这跟 Codex 的 `SandboxPolicy::DangerFullAccess` 一致--`create_bwrap_command_args` 在这个模式下原样返回命令，不包沙箱。

### Carveout 列表

`workspace_write` 模式下，项目根可写，但以下子路径保持只读：

| Carveout | 为什么保护 |
| --- | --- |
| `.git` | 仓库完整性。改写 `.git/config`、`.git/HEAD` 等于改写历史/远程 |
| `data/agent-sessions` | 会话审计完整性。模型不应改写自己的 transcript |
| `.env` / `.env.local` | 密钥文件。防止模型读到自己之前的密钥(prompt injection 持久化) |
| `node_modules` | 供应链。防投毒,虽然会限制 `npm install` 实用性 |
| `.next` | 构建产物。低风险,但保护可避免状态污染 |

Codex 保护 `.git` / `.agents` / `.codex`；本项目对应的是 `.git` / `data/agent-sessions` / `.env*` / `node_modules` / `.next`。

## 三档 sandboxMode 与沙箱的映射

```text
sandboxMode       分类器行为            OS 沙箱 profile
-------------     -----------------     -----------------------------------
read_only         safe 命令放行          项目根只读,无网络,无 carveout 需要
                  unsafe 命令 deny
workspace_write   safe 命令放行          项目根可写 + carveout 只读,无网络
                  unsafe 命令走 approval
danger_full_access safe 命令放行         不包沙箱,裸 bash -c
                   unsafe 命令走 approval
```

注意三档都跑同一个分类器。沙箱只在 `read_only` / `workspace_write` 启用；`danger_full_access` 的语义就是"用户放弃了沙箱"。

## macOS 实现：Seatbelt / SBPL

### 调用形态

```text
/usr/bin/sandbox-exec -p <SBPL profile string> \
  -D WRITABLE_ROOT_0=<project root> \
  -D WRITABLE_ROOT_0_EXCLUDED_0=<project root>/.git \
  ... \
  -- bash -c <command>
```

关键点：

- **`-p` 接字符串**，不是文件。Node 的 `spawn('/usr/bin/sandbox-exec', ['-p', profile, ...])` 直接传 argv，不需要 shell 引号。
- **`-D NAME=VALUE` 注入参数**。SBPL 用 `(param "NAME")` 引用，避免把绝对路径字符串拼进 profile（防引号/转义 bug）。Codex 也是这套。
- **pin `/usr/bin/sandbox-exec`**，不用 PATH 查找。防 PATH 注入。Codex 的注释：`only consider sandbox-exec in /usr/bin to defend against an attacker trying to inject a malicious version on the PATH`。

### SBPL profile 结构

`lib/agent-shell-sandbox-macos.ts` 拼接三段：

1. **`MACOS_SEATBELT_BASE_SBPL`**：`(deny default)` 起步，再放行最低限度的进程原语：
   - `(allow process-exec)` / `(allow process-fork)` / `(allow signal (target same-sandbox))`：否则 bash 起不来
   - sysctl 名字白名单（`hw.*` / `kern.*`）：Node 的 `os.cpus()` 和 bash 需要读
   - Mach 服务（`cfprefsd`、`opendirectoryd`、`trustd`）：TLS、用户信息查询、偏好设置
   - PTY 支持：交互式 shell 需要
2. **`MACOS_SEATBELT_PLATFORM_DEFAULTS_SBPL`**：系统运行时可读，让 exec 能工作：
   - `/bin` / `/usr/bin` / `/usr/libexec` / `/sbin`：bash、ls、grep、git 的二进制
   - `/usr/lib` + `file-map-executable` on `/System/Library/Frameworks`：dyld 加载共享库
   - `/dev/null` / `/dev/zero` / `/dev/urandom` / `/dev/random`
   - `/tmp` / `/private/tmp` / `/var/tmp`：临时文件（`/tmp` 在 macOS 是 `/private/tmp` 的 symlink，两个都要放）
   - `/etc` / `/private/etc`：`/etc/ssl/cert.pem`（curl/git TLS）、`/etc/passwd` 等
3. **可写项目根 + carveout**：`workspace_write` 才有这段，`read_only` 跳过：
   ```scheme
   (allow file-write*
     (require-all
       (subpath (param "WRITABLE_ROOT_0"))
       (require-not (literal (param "WRITABLE_ROOT_0_EXCLUDED_0")))
       (require-not (subpath (param "WRITABLE_ROOT_0_EXCLUDED_0")))
       ...每个 carveout 一对...
     ))
   (allow file-read* (subpath (param "WRITABLE_ROOT_0")))
   ```

`require-not (literal ...)` + `require-not (subpath ...)` 是双保险。只 `subpath` 不够：`mkdir .git` 第一次创建目录那一刻 subpath 还没匹配，`literal` 把这条缝堵上。Codex 的 `seatbelt.rs` 有同一条注释。

### 网络策略：什么都不写

`(deny default)` 已经拒绝了所有 `network-outbound` / `network-inbound` / `network-bind` / `system-socket`。**不 emit 任何 `(allow network-*)` 规则，就是 deny**。这是"none"网络的实现方式，跟 Codex 的 `dynamic_network_policy_for_network` 返回空字符串一致。

## Linux 实现：bubblewrap

### 调用形态

```text
/usr/bin/bwrap \
  --new-session --die-with-parent \
  --ro-bind / / \
  --dev /dev --proc /proc \
  --bind <project root> <project root> \
  --ro-bind-try <project root>/.git <project root>/.git \
  ...每个 carveout 一行 --ro-bind-try... \
  --unshare-user --unshare-pid --unshare-net \
  -- bash -c <command>
```

`lib/agent-shell-sandbox-linux.ts` 的 `buildLinuxBwrapArgv` 生成这个数组。

### 关键 flag 的理由

- **`--ro-bind / /`**：整个 host 文件系统只读挂载。这给 bash、ls、grep、git 等所有 `/bin`、`/usr`、`/lib`、`/etc` 的访问,不用逐一列举。Codex 的默认路径就是这个。
- **`--bind <project> <project>`**：在只读 root 之上叠加可写的项目根。bwrap 的挂载是"后挂载覆盖前挂载",所以这条会覆盖该子路径的 ro-bind。
- **`--ro-bind-try <carveout> <carveout>`**：在可写项目根之上再叠加只读 carveout。用 `--ro-bind-try`（不是 `--ro-bind`）是为了在 carveout 不存在时静默跳过--`.next/` 在新项目里可能没有,`--ro-bind` 会直接报错。代价:carveout 不存在时确实没保护,但 `.git`/`node_modules` 等都是常规项目必存路径,可接受。
- **`--unshare-user`**：创建新 user namespace。bwrap 在其中把调用者映射成 uid 0,**所以不需要 root 也不需要 capabilities**。现代 Ubuntu/Debian/Fedora/Arch 默认允许 unprivileged userns。
- **`--unshare-pid`**：新 PID namespace,沙箱内看不到也信号不到 harness。
- **`--unshare-net`**：新网络 namespace,只有 loopback 接口（默认 down）。**所有出站 TCP/UDP/DNS 都没有路由可达**,比防火墙规则更强。
- **`--die-with-parent`**：bwrap 进程死了,所有沙箱内进程被 SIGKILL。这对 SIGKILL 转发很关键（见下节）。
- **`--new-session`**：`setsid`,防 TIOCSTI 终端注入（CVE-2017-5226）。零成本加固。

### 为什么 v1 不上 seccomp

Codex 的 seccomp 是 `bwrap ... -- codex-linux-sandbox --apply-seccomp-then-exec -- bash -c <cmd>`--在 bwrap 起好 namespace 后,由一个 helper 子进程装 seccomp BPF 过滤器再 exec 真命令。从 Node 调用需要一个原生 helper 二进制,这是显著复杂度。bwrap 的文件系统 + namespace 隔离已经给了约 95% 的实际隔离;seccomp 关的是奇异 syscall 攻击面,对学习项目超范围。留作未来工作。

## Node 集成：detached + 进程组杀

`lib/agent-shell-builtins.ts` 的 `runShellCommandProcess` 改造点:

```ts
const child = spawn(executable, argv, {
  cwd: workdirAbsolutePath,
  env: createSanitizedShellEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,  // 新增
});

function killChildProcess(): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid!, 'SIGKILL');  // 杀整个进程组
    } catch {
      child.kill('SIGKILL');  // ESRCH 时退回直接杀
    }
  }
}
```

`detached: true` 让子进程（sandbox-exec / bwrap / bash）成为自己的进程组组长。`process.kill(-pid, 'SIGKILL')` 杀的是整个组（负 pid）。

为什么必须这样：SIGKILL 无法被转发。直接 `child.kill('SIGKILL')` 杀的是 sandbox-exec / bwrap 二进制本身,它来不及把信号转给 bash,bash 可能成孤儿。`detached: true` + 负 pid 杀组,保证组内所有进程（sandbox 二进制 + bash + bash 的子进程）一起死。bwrap 还有 `--die-with-parent` 兜底,这是双保险。

stdio、env、cwd、超时、AbortSignal、stdout/stderr 收集逻辑**全部不动**--sandbox-exec 和 bwrap 都把子进程的 stdio 透传出来,对父进程来说就是普通 child_process。exit code 也透传:bash exit 1,sandbox-exec / bwrap 也 exit 1。

## Fail-closed 在代码里长什么样

`lib/agent-shell-sandbox.ts` 的 `resolveShellSandboxPlan`:

```ts
if (input.sandboxMode === 'danger_full_access') {
  return { ok: true, plan: { executable: 'bash', argv: ['-c', command] } };
}

// read_only / workspace_write: OS sandbox 强制
if (process.platform === 'darwin') {
  if (!existsSync(MACOS_SEATBELT_EXECUTABLE)) {
    return {
      ok: false,
      errorCode: 'EXECUTION_ERROR',
      reason: `OS sandbox is required for sandboxMode=${input.sandboxMode} but ${MACOS_SEATBELT_EXECUTABLE} is not present. Refusing to run unsandboxed (fail-closed). Use sandboxMode=danger_full_access to explicitly opt out of the sandbox.`,
    };
  }
  return { ok: true, plan: buildMacosSeatbeltArgv(...) };
}
// ... linux 同理 ...
// 不支持的平台(Windows 等): 同样 fail-closed
```

`runShellCommandProcess` 消费这个结果:

```ts
if (!sandboxPlan.ok) {
  return Promise.reject(
    new AgentToolRespondToModelError(sandboxPlan.errorCode, sandboxPlan.reason),
  );
}
```

`AgentToolRespondToModelError` 走现有错误路径,序列化成 tool result 给模型看。模型能读到 `EXECUTION_ERROR: OS sandbox is required ...` 并据此调整（比如提示用户装 bwrap 或切到 `danger_full_access`）。

## 模块拆分

```text
lib/agent-shell-sandbox.ts          平台无关入口 + fail-closed + 二进制检测
lib/agent-shell-sandbox-macos.ts    SBPL 模板常量 + buildMacosSbplProfile (纯函数)
lib/agent-shell-sandbox-linux.ts    buildLinuxBwrapArgv (纯函数)
```

macOS 和 Linux 模块是纯函数,不碰 `process.env` / `process.cwd` / `spawn`,只产字符串/数组。这跟 `agent-shell-safety.ts`（纯分类器）和 `agent-shell-builtins.ts`（impure 执行器）的拆分一致:纯核心 + 薄外壳,便于单测。核心模块 `agent-shell-sandbox.ts` 拥有所有 impure 关注点（`process.platform`、`existsSync`、argv 组装）,把 fail-closed 决策集中在一处。

`AgentToolRuntimeContext` 扩了一个**可选**字段 `sandboxMode?`,只有 shell 工具读它。其他 tool 的 `execute` 不解构它就不受影响。`agent-tool-runtime.ts:310-320` 在构造 runtime 时把 `context.policy.sandboxMode` 传进去。

## 本章验证点

本章的每个设计决策都留下了点名的测试用例,不需要 key 就能全部实跑:

```bash
npx tsx --test tests/agent-shell-sandbox.test.ts tests/agent-shell-builtins.test.ts
```

实测输出（在 macOS arm64 上,包含纯函数单测和真实 sandbox-exec 集成测试）:

```text
✔ danger_full_access returns raw bash argv with no sandbox wrapper (0.817166ms)
✔ danger_full_access does not check for sandbox binary existence (0.068416ms)
✔ macOS SBPL profile starts with (deny default) and version 1 (0.185917ms)
✔ macOS SBPL profile includes base process primitives so bash can start (0.082917ms)
✔ macOS SBPL profile allows system binaries and libs so dyld can load bash (0.084666ms)
✔ macOS SBPL profile emits no network allow rules in sandboxed modes (0.069917ms)
✔ macOS SBPL workspace_write profile emits writable-root allow with carveout require-not pairs (0.134167ms)
✔ macOS SBPL read_only profile emits no file-write* allow on the project root (0.115916ms)
✔ Linux bwrap argv uses --ro-bind / / as the read-only base and --dev /dev (0.112625ms)
✔ Linux bwrap workspace_write argv mounts project writable and each carveout read-only (0.128542ms)
✔ Linux bwrap read_only argv does not mount the project writable (0.062083ms)
✔ Linux bwrap argv unshares user, pid, and net namespaces and dies with parent (0.065541ms)
✔ Linux bwrap argv ends with -- bash -c <command> (0.050958ms)
✔ resolveShellSandboxPlan dispatches to sandbox-exec on darwin with binary present (0.111542ms)
✔ resolveShellSandboxPlan dispatches to bwrap on linux with binary present (0.086583ms)
✔ resolveShellSandboxPlan read_only vs workspace_write differ in write allow on darwin (0.096208ms)
✔ SANDBOX_READONLY_CARVEOUTS covers .git, .env files, sessions, node_modules, and .next (0.046666ms)
✔ resolveShellSandboxPlan resolves projectRoot to an absolute path before passing to builders (0.09275ms)
✔ shell executes a safe command and reports exit code and output (16.638333ms)
✔ shell kills the command after the per-call timeout (1010.617791ms)
✔ shell child process does not inherit harness secrets (26.347042ms)
✔ sandboxed shell still executes echo in read_only mode (macOS) (10.920792ms)
✔ sandboxed shell still executes echo in workspace_write mode (macOS) (9.824708ms)
✔ sandbox denies writes outside the project root in workspace_write (macOS) (10.596875ms)
✔ sandbox denies writes to .git in workspace_write (macOS) (9.741209ms)
✔ sandbox denies network in workspace_write (macOS) (16.629042ms)
✔ sandbox allows writes inside the project root in workspace_write (macOS) (10.663125ms)
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

最关键的四条是 macOS 集成测试,它们证明沙箱真的在内核层起作用,不只是我们传给 `-p` 的一串字符:

- `sandbox denies writes outside the project root` -- 写 `~/.ssh/` 被 OS 拒,bash stderr 含 `Operation not permitted`
- `sandbox denies writes to .git` -- carveout 生效
- `sandbox denies network` -- `curl --max-time 3 https://example.com` 失败(exit 6/7/28)
- `sandbox allows writes inside the project root` -- 项目内 `.tmp-sandbox-write-test.txt` 写读成功

`shell kills the command after the per-call timeout (1010ms)` 这条同时验证了 `detached: true` + 进程组杀没把超时机制搞坏--1010ms 就杀掉了,没卡到 10 秒上限。

## 本章小结

第 18 章把执行边界画在"分类器 + permission + 资源限制",坦白说没有 OS 强制。本章把那条缝补上了:同一套 `sandboxMode` 三档语义,在 `read_only` / `workspace_write` 下落到 OS 原语（macOS Seatbelt / Linux bwrap）,`danger_full_access` 显式 opt-out,fail-closed 拒绝降级。分类器、path policy、env 白名单全部保留原位--它们和 OS 沙箱是叠加防御,不是替换关系。

这一章也是项目第一次有平台分支代码。macOS 和 Linux 各一个纯函数模块,核心入口 `agent-shell-sandbox.ts` 拿所有 impure 关注点。Windows、seccomp 加固、proxy 网络模式留作未来工作,在 `docs/architecture.md` 末尾的未来列表里点了名。
