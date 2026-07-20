// Linux bubblewrap (bwrap) argv builder for the agent shell tool.
//
// This module is pure: it only produces an argv array. It does not touch
// `process.env`, `process.cwd()`, or `child_process`. The shell sandbox
// resolver (`agent-shell-sandbox.ts`) prepends `/usr/bin/bwrap` to this argv
// and spawns it with the same stdio/env/cwd as the previous raw `bash -c`
// spawn, so the existing timeout/abort/output-collection logic is reused
// unchanged.
//
// The bubblewrap model is "read-only root filesystem + writable project
// directory + read-only carveouts". This is the Codex `codex-rs/linux-sandbox`
// default: `--ro-bind / /` makes the entire host filesystem read-only inside
// the namespace, then `--bind <project> <project>` layers the project back as
// writable, then `--ro-bind-try <carveout> <carveout>` re-masks each carveout
// as read-only. bwrap applies mounts in order, last-wins, so the ro-bind on
// `.git` overrides the writable bind on the project for that subpath only.
//
// `--unshare-user` creates a new user namespace so bwrap can run unprivileged
// (no root, no capabilities) on any distro with `kernel.unprivileged_userns_clone=1`
// (the default on modern Ubuntu/Debian/Fedora/Arch). `--unshare-pid` gives
// the sandbox its own PID namespace so the child cannot see or signal the
// harness. `--unshare-net` creates a new network namespace with only a
// loopback interface (down by default), which fully blocks outbound TCP/UDP
// and DNS: the packets have nowhere to go. This is stronger than a firewall
// rule and matches the macOS "no `(allow network-*)` rules" policy.
//
// `--die-with-parent` ensures that if the Node harness dies (or the bwrap
// process is killed), all sandboxed processes are SIGKILLed. This matters
// because SIGKILL cannot be forwarded through bwrap's pid-1: killing bwrap
// itself triggers `--die-with-parent` cleanup of bash, while a bare SIGKILL
// on bwrap would otherwise leave bash orphaned. The shell tool pairs this
// with `detached: true` + `process.kill(-pid, 'SIGKILL')` in Node so the
// whole process group dies on timeout/abort.
//
// `--new-session` calls setsid, defending against TIOCSTI terminal injection
// (CVE-2017-5226). It is a zero-cost hardening flag Codex also uses.
//
// seccomp is intentionally NOT applied in v1. Codex applies seccomp via a
// child helper binary after bwrap sets up the namespace, which would require
// shipping a native helper from Node. bwrap's filesystem + namespace
// isolation already gives ~95% of the practical containment for a learning
// project; seccomp closes exotic syscall attack surface that is out of scope.

export type LinuxBwrapArgvInput = {
  // Absolute path of the project root. Mounted writable in workspace_write,
  // read-only (inherited from the ro-bind /) in read_only.
  projectRoot: string;
  // The model-supplied shell command. Appended after `--` as `bash -c <command>`.
  command: string;
  // Project-relative carveout paths (e.g. ['.git', 'data/agent-sessions']).
  // Each is re-mounted read-only inside the writable project bind.
  carveouts: readonly string[];
  // workspace_write -> true (mount project writable + carveouts read-only)
  // read_only      -> false (project inherits the ro-bind /, no carveouts needed)
  allowWrite: boolean;
};

export function buildLinuxBwrapArgv(input: LinuxBwrapArgvInput): string[] {
  const argv: string[] = [
    '--new-session',
    '--die-with-parent',
    // Read-only entire host filesystem. This gives bash, ls, grep, git, ...
    // access to /bin, /usr, /lib, /etc without listing each one.
    '--ro-bind',
    '/',
    '/',
    // Minimal writable /dev with null/zero/random/urandom/tty.
    // The host /dev is bind-mounted ro above; --dev overlays a fresh devtmpfs.
    '--dev',
    '/dev',
    // /proc: needed by ps and tools that read /proc/self/...
    '--proc',
    '/proc',
  ];

  if (input.allowWrite) {
    argv.push('--bind', input.projectRoot, input.projectRoot);

    // Re-mount each carveout read-only. `--ro-bind-try` (not `--ro-bind`)
    // silently skips missing source paths, so a project without `.next/`
    // does not break sandbox setup. This is safe because a missing carveout
    // has nothing to protect; if the model later creates it, the writable
    // bind still applies and the carveout is unprotected until the next run.
    // For .git, .env, data/agent-sessions, node_modules, .next this is an
    // acceptable v1 tradeoff: all are conventional project paths that exist
    // in any real workspace.
    for (const carveout of input.carveouts) {
      const carveoutAbs = `${input.projectRoot}/${carveout}`;
      argv.push('--ro-bind-try', carveoutAbs, carveoutAbs);
    }
  }

  argv.push(
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--',
    'bash',
    '-c',
    input.command,
  );

  return argv;
}
