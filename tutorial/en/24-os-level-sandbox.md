# 24. OS-Level Sandbox: From Lexical Screen To Kernel Enforcement

Chapter 18 said it plainly: `classifyShellCommandSafety` is a lexical screen,
not a sandbox. It rejects `cat /etc/passwd` because it sees the string
`/etc/passwd`, but it cannot follow symlinks, cannot see runtime behavior, and
cannot stop an approved unsafe command from doing anything it wants under
`workspace_write`. This chapter adds that layer: wrap `bash -c` in an OS-native
sandbox so a command that lies its way past the lexical screen still hits a
kernel wall.

After reading this chapter, you should understand:

- why the OS sandbox is another layer, not a replacement for the classifier
- the fail-closed contract: refuse to run when the sandbox binary is missing,
  never silently fall back to raw `bash -c`
- the macOS Seatbelt model (`sandbox-exec` + an SBPL profile built around
  `(deny default)`)
- the Linux bubblewrap model (`--ro-bind / /` + `--bind <project>` +
  `--unshare-*`)
- how the three `sandboxMode` values map to the sandbox: `read_only` is
  read-only, `workspace_write` is writable with carveouts, and
  `danger_full_access` is an explicit opt-out
- why `detached: true` plus process-group kill is necessary to make SIGKILL
  reach bash through the sandbox binary

## Design Decisions

### The sandbox is a second layer, not a replacement

The chapter 18 lexical classifier stays in place. It still does its job:
letting known read-only commands like `ls` and `git status` skip approval.
The OS sandbox does the catching: even if an unsafe command is approved, even
if the lexical classifier is somehow bypassed, the kernel still refuses to let
it escape the project root, reach the network, or rewrite `.git` / `.env` /
`data/agent-sessions` / `node_modules` / `.next` under `workspace_write`. This
is the same architecture as Codex and Claude Code: the classifier reduces
interruptions, the sandbox enforces the real execution boundary.

### Fail-Closed Contract

Under `read_only` and `workspace_write`, if the platform sandbox binary is
missing (no `bwrap` on a Linux server, `sandbox-exec` disabled by hardened
runtime on macOS, or an unsupported platform like Windows), the shell tool
**refuses to execute** and returns `EXECUTION_ERROR` with a clear reason. It
never degrades to raw `bash -c`.

This matches Codex. The `bundled_bwrap.rs` panic string is explicit:
`bubblewrap is unavailable: no system bwrap was found on PATH and no bundled
codex-resources/bwrap binary was found next to the Codex executable`. The
panic is caught upstream and surfaced as a refusal.

`danger_full_access` is the **only** exception, and it is not a fallback: it
is the user explicitly opting out. This matches Codex's
`SandboxPolicy::DangerFullAccess`, where `create_bwrap_command_args` returns
the command unchanged without wrapping it.

### Carveout List

Under `workspace_write`, the project root is writable, but the following
subpaths stay read-only:

| Carveout | Why protected |
| --- | --- |
| `.git` | Repository integrity. Rewriting `.git/config` or `.git/HEAD` rewrites history / remotes |
| `data/agent-sessions` | Audit integrity. The model must not rewrite its own transcript |
| `.env` / `.env.local` | Secret files. Stops the model from reading its own prior keys (prompt-injection persistence) |
| `node_modules` | Supply chain. Poisoning prevention, at the cost of `npm install` usability |
| `.next` | Build artifacts. Low risk, but protects against state pollution |

Codex protects `.git` / `.agents` / `.codex`. This project's counterparts are
`.git` / `data/agent-sessions` / `.env*` / `node_modules` / `.next`.

## How The Three sandboxMode Values Map To The Sandbox

```text
sandboxMode       classifier behavior      OS sandbox profile
-------------     ----------------------    -----------------------------------
read_only         safe commands allow       project root read-only, no network,
                  unsafe commands deny      no carveouts needed
workspace_write   safe commands allow       project root writable + carveouts
                  unsafe -> approval        read-only, no network
danger_full_access safe commands allow      no sandbox, raw bash -c
                    unsafe -> approval
```

Note that the classifier runs in all three modes. The sandbox only activates
under `read_only` / `workspace_write`; `danger_full_access` is the mode whose
semantics is "the user gave up the sandbox".

## macOS Implementation: Seatbelt / SBPL

### Invocation Shape

```text
/usr/bin/sandbox-exec -p <SBPL profile string> \
  -D WRITABLE_ROOT_0=<project root> \
  -D WRITABLE_ROOT_0_EXCLUDED_0=<project root>/.git \
  ... \
  -- bash -c <command>
```

Key points:

- **`-p` takes a string**, not a file. Node's
  `spawn('/usr/bin/sandbox-exec', ['-p', profile, ...])` passes it as one argv
  element, no shell quoting needed.
- **`-D NAME=VALUE` injects parameters**. SBPL references them via
  `(param "NAME")`, which avoids splicing absolute paths into the profile
  string (no quoting/escaping bugs). Codex uses the same mechanism.
- **Pin `/usr/bin/sandbox-exec`**, do not PATH-lookup. Defends against PATH
  injection. Codex's comment: `only consider sandbox-exec in /usr/bin to
  defend against an attacker trying to inject a malicious version on the PATH`.

### SBPL Profile Structure

`lib/agent-shell-sandbox-macos.ts` concatenates three sections:

1. **`MACOS_SEATBELT_BASE_SBPL`**: starts with `(deny default)`, then re-allows
   the minimum process primitives:
   - `(allow process-exec)` / `(allow process-fork)` /
     `(allow signal (target same-sandbox))`: otherwise bash cannot start
   - sysctl name allowlist (`hw.*` / `kern.*`): Node's `os.cpus()` and bash
     probe these
   - Mach services (`cfprefsd`, `opendirectoryd`, `trustd`): TLS, user info
     lookups, preferences
   - PTY support: interactive shells need it
2. **`MACOS_SEATBELT_PLATFORM_DEFAULTS_SBPL`**: read access to system runtime
   so exec works:
   - `/bin` / `/usr/bin` / `/usr/libexec` / `/sbin`: the binaries bash, ls,
     grep, git live under
   - `/usr/lib` + `file-map-executable` on `/System/Library/Frameworks`: dyld
     loading shared libraries
   - `/dev/null` / `/dev/zero` / `/dev/urandom` / `/dev/random`
   - `/tmp` / `/private/tmp` / `/var/tmp`: temp files (`/tmp` on macOS is a
     symlink to `/private/tmp`, both must be allowed)
   - `/etc` / `/private/etc`: `/etc/ssl/cert.pem` (curl/git TLS), `/etc/passwd`
3. **Writable project root + carveouts**: only emitted for `workspace_write`;
   `read_only` skips this section:
   ```scheme
   (allow file-write*
     (require-all
       (subpath (param "WRITABLE_ROOT_0"))
       (require-not (literal (param "WRITABLE_ROOT_0_EXCLUDED_0")))
       (require-not (subpath (param "WRITABLE_ROOT_0_EXCLUDED_0")))
       ...one pair per carveout...
     ))
   (allow file-read* (subpath (param "WRITABLE_ROOT_0")))
   ```

The `require-not (literal ...)` + `require-not (subpath ...)` pair is
belt-and-suspenders. `subpath` alone is not enough: the moment `mkdir .git`
first creates the directory, `subpath` has not matched yet, so `literal` closes
that gap. Codex's `seatbelt.rs` carries the same comment.

### Network Policy: Emit Nothing

`(deny default)` already denies every `network-outbound` / `network-inbound` /
`network-bind` / `system-socket` operation. **Not emitting any
`(allow network-*)` rule is the denial.** This is how "none" network is
implemented, matching Codex's `dynamic_network_policy_for_network` returning an
empty string.

## Linux Implementation: bubblewrap

### Invocation Shape

```text
/usr/bin/bwrap \
  --new-session --die-with-parent \
  --ro-bind / / \
  --dev /dev --proc /proc \
  --bind <project root> <project root> \
  --ro-bind-try <project root>/.git <project root>/.git \
  ...one --ro-bind-try per carveout... \
  --unshare-user --unshare-pid --unshare-net \
  -- bash -c <command>
```

`lib/agent-shell-sandbox-linux.ts`'s `buildLinuxBwrapArgv` produces this
array.

### Why Each Flag

- **`--ro-bind / /`**: bind-mount the entire host filesystem read-only. This
  gives bash, ls, grep, git, ... access to /bin, /usr, /lib, /etc without
  enumerating each one. This is Codex's default path.
- **`--bind <project> <project>`**: layer the project root as writable on top
  of the read-only root. bwrap mounts are "later mounts override earlier
  mounts", so this overrides the ro-bind for that subpath.
- **`--ro-bind-try <carveout> <carveout>`**: layer each carveout as read-only
  on top of the writable project. Uses `--ro-bind-try` (not `--ro-bind`) so a
  missing carveout does not break sandbox setup: `.next/` may not exist in a
  fresh project and `--ro-bind` would error. The tradeoff: if a carveout does
  not exist, it is unprotected, but `.git` / `node_modules` etc. are
  conventional paths that exist in any real workspace.
- **`--unshare-user`**: create a new user namespace. bwrap maps the caller to
  uid 0 inside it, **so no root and no capabilities are required**. Modern
  Ubuntu / Debian / Fedora / Arch allow unprivileged userns by default.
- **`--unshare-pid`**: new PID namespace, the sandbox cannot see or signal the
  harness.
- **`--unshare-net`**: new network namespace with only a loopback interface
  (down by default). **All outbound TCP/UDP/DNS have no route**, stronger than
  a firewall rule.
- **`--die-with-parent`**: if bwrap dies, all sandboxed processes are
  SIGKILLed. Crucial for SIGKILL forwarding (see next section).
- **`--new-session`**: `setsid`, defends against TIOCSTI terminal injection
  (CVE-2017-5226). Zero-cost hardening.

### Why v1 Skips seccomp

Codex's seccomp is `bwrap ... -- codex-linux-sandbox --apply-seccomp-then-exec
-- bash -c <cmd>`: after bwrap sets up the namespace, a helper child installs
a seccomp BPF filter, then execs the real command. Calling this from Node
requires shipping a native helper binary, which is significant complexity.
bwrap's filesystem + namespace isolation already gives ~95% of practical
containment; seccomp closes exotic syscall attack surface that is out of scope
for a learning project. Left as future work.

## Node Integration: detached + Process-Group Kill

The `lib/agent-shell-builtins.ts` change in `runShellCommandProcess`:

```ts
const child = spawn(executable, argv, {
  cwd: workdirAbsolutePath,
  env: createSanitizedShellEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,  // new
});

function killChildProcess(): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid!, 'SIGKILL');  // kill the whole group
    } catch {
      child.kill('SIGKILL');  // fall back to direct kill on ESRCH
    }
  }
}
```

`detached: true` makes the child (sandbox-exec / bwrap / bash) the leader of
its own process group. `process.kill(-pid, 'SIGKILL')` kills the whole group
(the negative pid).

Why this is necessary: SIGKILL cannot be forwarded. A bare
`child.kill('SIGKILL')` kills the sandbox-exec / bwrap binary itself, which
does not have time to forward the signal to bash, and bash can be orphaned.
`detached: true` plus negative-pid group kill guarantees that every process in
the group (the sandbox binary + bash + bash's own children) dies together.
bwrap's `--die-with-parent` is the belt; this is the suspenders.

The stdio, env, cwd, timeout, AbortSignal, and stdout/stderr collection logic
are **all unchanged**: sandbox-exec and bwrap both forward the child's stdio,
so from the parent's perspective this is an ordinary child_process. Exit codes
also propagate: bash exits 1, sandbox-exec / bwrap exit 1.

## What Fail-Closed Looks Like In Code

`lib/agent-shell-sandbox.ts`'s `resolveShellSandboxPlan`:

```ts
if (input.sandboxMode === 'danger_full_access') {
  return { ok: true, plan: { executable: 'bash', argv: ['-c', command] } };
}

// read_only / workspace_write: OS sandbox is mandatory
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
// ... linux follows the same pattern ...
// Unsupported platforms (Windows, ...): same fail-closed
```

`runShellCommandProcess` consumes the result:

```ts
if (!sandboxPlan.ok) {
  return Promise.reject(
    new AgentToolRespondToModelError(sandboxPlan.errorCode, sandboxPlan.reason),
  );
}
```

`AgentToolRespondToModelError` goes through the existing error path and is
serialized into a tool result the model can read. The model sees
`EXECUTION_ERROR: OS sandbox is required ...` and can react (for example,
suggest the user install bwrap or switch to `danger_full_access`).

## Module Split

```text
lib/agent-shell-sandbox.ts          platform-agnostic entry + fail-closed + binary detection
lib/agent-shell-sandbox-macos.ts    SBPL template constants + buildMacosSbplProfile (pure)
lib/agent-shell-sandbox-linux.ts    buildLinuxBwrapArgv (pure)
```

The macOS and Linux modules are pure functions: they do not touch
`process.env` / `process.cwd` / `spawn`, they only produce strings / arrays.
This mirrors the `agent-shell-safety.ts` (pure classifier) vs
`agent-shell-builtins.ts` (impure executor) split: pure core + thin shell, for
testability. The core `agent-shell-sandbox.ts` owns every impure concern
(`process.platform`, `existsSync`, argv assembly), keeping the fail-closed
decision in one place.

`AgentToolRuntimeContext` gained an **optional** `sandboxMode?` field that
only the shell tool reads. Other tools' `execute` functions do not destructure
it, so they are unaffected. `agent-tool-runtime.ts:310-320` populates it from
`context.policy.sandboxMode` when constructing the runtime.

## Verification Points

Every design decision in this chapter has a named test case, all runnable
without an API key:

```bash
npx tsx --test tests/agent-shell-sandbox.test.ts tests/agent-shell-builtins.test.ts
```

Measured output (on macOS arm64, including both pure unit tests and real
sandbox-exec integration tests):

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

The four load-bearing tests are the macOS integration tests, which prove the
sandbox is actually enforced at the kernel layer, not just a string we pass to
`-p`:

- `sandbox denies writes outside the project root` -- writing to `~/.ssh/` is
  rejected by the OS, bash stderr contains `Operation not permitted`
- `sandbox denies writes to .git` -- the carveout is enforced
- `sandbox denies network` -- `curl --max-time 3 https://example.com` fails
  (exit 6/7/28)
- `sandbox allows writes inside the project root` -- writing and reading
  `.tmp-sandbox-write-test.txt` inside the project succeeds

`shell kills the command after the per-call timeout (1010ms)` also verifies
that `detached: true` plus process-group kill did not break the timeout
mechanism: 1010ms to kill, well under the 10-second hard cap.

## Chapter Summary

Chapter 18 drew the execution boundary at "classifier + permission + resource
limits" and was honest that there was no OS enforcement. This chapter closes
that gap: the same three `sandboxMode` values now land on OS primitives (macOS
Seatbelt / Linux bwrap) under `read_only` / `workspace_write`, with
`danger_full_access` as the explicit opt-out and fail-closed refusing to
degrade. The classifier, path policy, and env allowlist all stay in place:
they are defense in depth alongside the OS sandbox, not a replacement.

This chapter is also the project's first piece of platform-branched code. Each
platform (macOS, Linux) gets a pure function module; the core entry
`agent-shell-sandbox.ts` owns every impure concern. Windows, seccomp
hardening, and a proxy-based network allowlist mode are left as future work,
called out by name in the future-work list at the end of
`docs/architecture.md`.
