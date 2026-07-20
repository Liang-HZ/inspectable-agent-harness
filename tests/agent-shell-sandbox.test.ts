import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildMacosSbplProfile,
  MACOS_SANDBOX_READONLY_CARVEOUTS,
} from '../lib/agent-shell-sandbox-macos';
import { buildLinuxBwrapArgv } from '../lib/agent-shell-sandbox-linux';
import {
  LINUX_BWRAP_EXECUTABLE,
  MACOS_SEATBELT_EXECUTABLE,
  resolveShellSandboxPlan,
  SANDBOX_READONLY_CARVEOUTS,
} from '../lib/agent-shell-sandbox';

const PROJECT_ROOT = '/Users/test/my-project';
const COMMAND = 'echo hello';

// ---------------------------------------------------------------------------
// resolveShellSandboxPlan: danger_full_access always bypasses the sandbox
// ---------------------------------------------------------------------------

test('danger_full_access returns raw bash argv with no sandbox wrapper', () => {
  const result = resolveShellSandboxPlan({
    sandboxMode: 'danger_full_access',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.plan.executable, 'bash');
  assert.deepEqual(result.plan.argv, ['-c', COMMAND]);
});

test('danger_full_access does not check for sandbox binary existence', () => {
  // Even on a platform where neither sandbox-exec nor bwrap exists,
  // danger_full_access must succeed because it explicitly opts out of the
  // sandbox. This is the fail-closed contract: only read_only and
  // workspace_write fail when the binary is missing.
  const result = resolveShellSandboxPlan({
    sandboxMode: 'danger_full_access',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// macOS SBPL profile content (pure, runs on every platform)
// ---------------------------------------------------------------------------

test('macOS SBPL profile starts with (deny default) and version 1', () => {
  const { profile } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  assert.match(profile, /^\(version 1\)/);
  assert.match(profile, /\(deny default\)/);
});

test('macOS SBPL profile includes base process primitives so bash can start', () => {
  const { profile } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  // Without these, (deny default) blocks fork, exec, and signal delivery.
  assert.match(profile, /\(allow process-exec\)/);
  assert.match(profile, /\(allow process-fork\)/);
  assert.match(profile, /\(allow signal \(target same-sandbox\)\)/);
});

test('macOS SBPL profile allows system binaries and libs so dyld can load bash', () => {
  const { profile } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  // file-map-executable is its own operation class; (deny default) blocks
  // it, so the profile must explicitly allow it for /usr/lib and frameworks.
  assert.match(profile, /\(allow file-map-executable/);
  assert.match(profile, /\(subpath "\/usr\/lib"\)/);
  assert.match(profile, /\(subpath "\/System\/Library\/Frameworks"\)/);
  assert.match(profile, /\(allow file-read-data \(subpath "\/bin"\)\)/);
});

test('macOS SBPL profile emits no network allow rules in sandboxed modes', () => {
  // The denial is implicit: (deny default) covers network-outbound etc., and
  // we emit no (allow network-*) rules. Assert the absence directly.
  const { profile } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  assert.doesNotMatch(profile, /\(allow network-/);
  assert.match(profile, /network: NONE/);
});

test('macOS SBPL workspace_write profile emits writable-root allow with carveout require-not pairs', () => {
  const { profile, definitions } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  // The writable root is injected via param, not string-spliced.
  assert.match(profile, /\(subpath \(param "WRITABLE_ROOT_0"\)\)/);
  assert.match(profile, /\(allow file-write\*/);

  // First -D definition is always WRITABLE_ROOT_0=<projectRoot>.
  assert.equal(definitions[0], `WRITABLE_ROOT_0=${PROJECT_ROOT}`);

  // Each carveout gets a -D definition and a require-not pair (literal +
  // subpath). The literal closes the "mkdir .git" first-creation gap that
  // subpath alone leaves open.
  MACOS_SANDBOX_READONLY_CARVEOUTS.forEach((carveout, index) => {
    const paramName = `WRITABLE_ROOT_0_EXCLUDED_${index}`;
    const carveoutAbs = `${PROJECT_ROOT}/${carveout}`;

    assert.equal(
      definitions[index + 1],
      `${paramName}=${carveoutAbs}`,
      `missing -D definition for carveout ${carveout}`,
    );

    assert.match(
      profile,
      new RegExp(
        `\\(require-not \\(literal \\(param "${paramName}"\\)\\)\\)`,
      ),
      `missing literal require-not for carveout ${carveout}`,
    );
    assert.match(
      profile,
      new RegExp(
        `\\(require-not \\(subpath \\(param "${paramName}"\\)\\)\\)`,
      ),
      `missing subpath require-not for carveout ${carveout}`,
    );
  });
});

test('macOS SBPL read_only profile emits no file-write* allow on the project root', () => {
  const { profile } = buildMacosSbplProfile({
    writableRoot: PROJECT_ROOT,
    carveouts: MACOS_SANDBOX_READONLY_CARVEOUTS,
    allowWrite: false,
  });

  // Reads of the project root are still allowed.
  assert.match(profile, /\(allow file-read\* \(subpath \(param "WRITABLE_ROOT_0"\)\)\)/);

  // The read_only profile must not emit a writable-root allow rule. We split
  // the profile into rule lines and assert none of them is a file-write*
  // allow that references WRITABLE_ROOT_0. (Other file-write* rules on
  // /dev/null and /tmp are expected and unrelated.)
  const writableRootWriteRule = /\(allow file-write\*[^)]*\([^)]*WRITABLE_ROOT_0/;
  assert.ok(
    !writableRootWriteRule.test(profile),
    'read_only profile must not allow writes to the project root',
  );
});

// ---------------------------------------------------------------------------
// Linux bwrap argv content (pure, runs on every platform)
// ---------------------------------------------------------------------------

test('Linux bwrap argv uses --ro-bind / / as the read-only base and --dev /dev', () => {
  const argv = buildLinuxBwrapArgv({
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  const roBindIdx = argv.indexOf('--ro-bind');
  assert.notEqual(roBindIdx, -1);
  assert.equal(argv[roBindIdx + 1], '/');
  assert.equal(argv[roBindIdx + 2], '/');

  const devIdx = argv.indexOf('--dev');
  assert.notEqual(devIdx, -1);
  assert.equal(argv[devIdx + 1], '/dev');

  const procIdx = argv.indexOf('--proc');
  assert.notEqual(procIdx, -1);
  assert.equal(argv[procIdx + 1], '/proc');
});

test('Linux bwrap workspace_write argv mounts project writable and each carveout read-only', () => {
  const argv = buildLinuxBwrapArgv({
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  // --bind <project> <project>: writable project root.
  const bindIdx = argv.indexOf('--bind');
  assert.notEqual(bindIdx, -1);
  assert.equal(argv[bindIdx + 1], PROJECT_ROOT);
  assert.equal(argv[bindIdx + 2], PROJECT_ROOT);

  // Each carveout: --ro-bind-try <abs> <abs>. Using --ro-bind-try (not
  // --ro-bind) so a missing .next/ does not break sandbox setup.
  MACOS_SANDBOX_READONLY_CARVEOUTS.forEach((carveout) => {
    const carveoutAbs = `${PROJECT_ROOT}/${carveout}`;
    const idx = argv.indexOf('--ro-bind-try');
    assert.notEqual(
      idx,
      -1,
      `missing --ro-bind-try for carveout ${carveout}`,
    );
    assert.equal(argv[idx + 1], carveoutAbs);
    assert.equal(argv[idx + 2], carveoutAbs);
    // Remove so the next iteration finds the next occurrence.
    argv.splice(idx, 3);
  });
});

test('Linux bwrap read_only argv does not mount the project writable', () => {
  const argv = buildLinuxBwrapArgv({
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: false,
  });

  // No --bind for the project root: it inherits the ro-bind /.
  assert.equal(argv.indexOf('--bind'), -1);
  // No carveout re-mounts needed: nothing is writable.
  assert.equal(argv.indexOf('--ro-bind-try'), -1);
});

test('Linux bwrap argv unshares user, pid, and net namespaces and dies with parent', () => {
  const argv = buildLinuxBwrapArgv({
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: true,
  });

  assert.ok(argv.includes('--unshare-user'), 'must unshare user namespace');
  assert.ok(argv.includes('--unshare-pid'), 'must unshare pid namespace');
  assert.ok(argv.includes('--unshare-net'), 'must unshare net namespace');
  assert.ok(
    argv.includes('--die-with-parent'),
    'must die with parent so SIGKILL on bwrap cleans up bash',
  );
  assert.ok(
    argv.includes('--new-session'),
    'must start a new session (setsid) to defend against TIOCSTI',
  );
});

test('Linux bwrap argv ends with -- bash -c <command>', () => {
  const argv = buildLinuxBwrapArgv({
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
    carveouts: [],
    allowWrite: true,
  });

  const dashIdx = argv.indexOf('--');
  assert.notEqual(dashIdx, -1);
  assert.deepEqual(
    argv.slice(dashIdx + 1),
    ['bash', '-c', COMMAND],
    'argv after -- must be bash -c <command>',
  );
});

// ---------------------------------------------------------------------------
// resolveShellSandboxPlan: platform dispatch and fail-closed
// ---------------------------------------------------------------------------

test('resolveShellSandboxPlan dispatches to sandbox-exec on darwin with binary present', () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const result = resolveShellSandboxPlan({
    sandboxMode: 'workspace_write',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.plan.executable, MACOS_SEATBELT_EXECUTABLE);
  assert.equal(result.plan.argv[0], '-p');
  assert.ok(
    result.plan.argv[result.plan.argv.length - 1].includes(COMMAND),
    'last argv element must contain the command',
  );
  // -D WRITABLE_ROOT_0=... must be present.
  const dIdx = result.plan.argv.indexOf('-D');
  assert.notEqual(dIdx, -1);
  assert.match(result.plan.argv[dIdx + 1], /^WRITABLE_ROOT_0=/);
});

test('resolveShellSandboxPlan dispatches to bwrap on linux with binary present', () => {
  if (process.platform !== 'linux') {
    return;
  }

  // /usr/bin/bwrap may or may not be installed on the linux host running
  // this test. If it is missing, the resolver must fail closed.
  const result = resolveShellSandboxPlan({
    sandboxMode: 'read_only',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });

  if (!result.ok) {
    assert.equal(result.errorCode, 'EXECUTION_ERROR');
    assert.match(result.reason, /bwrap/);
    return;
  }

  assert.equal(result.plan.executable, LINUX_BWRAP_EXECUTABLE);
  assert.ok(result.plan.argv.includes('--ro-bind'));
  assert.ok(result.plan.argv.includes('--unshare-net'));
});

test('resolveShellSandboxPlan read_only vs workspace_write differ in write allow on darwin', () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const ro = resolveShellSandboxPlan({
    sandboxMode: 'read_only',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });
  const ww = resolveShellSandboxPlan({
    sandboxMode: 'workspace_write',
    projectRoot: PROJECT_ROOT,
    command: COMMAND,
  });

  assert.equal(ro.ok, true);
  assert.equal(ww.ok, true);
  if (!ro.ok || !ww.ok) {
    return;
  }

  // The workspace_write profile contains a file-write* allow on the writable
  // root; read_only does not. We split the profile into rule lines and assert
  // on the presence/absence of a file-write* rule referencing WRITABLE_ROOT_0,
  // because the profile contains other unrelated file-write* rules (/dev/null,
  // /tmp) that a greedy [\s\S]* regex would span.
  const writableRootWriteRule = /\(allow file-write\*[^)]*\([^)]*WRITABLE_ROOT_0/;
  const roProfile = ro.plan.argv[1];
  const wwProfile = ww.plan.argv[1];
  assert.ok(
    writableRootWriteRule.test(wwProfile),
    'workspace_write profile must allow writes to the project root',
  );
  assert.ok(
    !writableRootWriteRule.test(roProfile),
    'read_only profile must not allow writes to the project root',
  );
});

test('SANDBOX_READONLY_CARVEOUTS covers .git, .env files, sessions, node_modules, and .next', () => {
  // These are the load-bearing carveouts. Asserting the set explicitly so a
  // future edit does not quietly drop one.
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('.git'));
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('data/agent-sessions'));
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('.env'));
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('.env.local'));
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('node_modules'));
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes('.next'));
});

test('resolveShellSandboxPlan resolves projectRoot to an absolute path before passing to builders', () => {
  // Defensive: even if a caller passes a relative path, the resolver should
  // normalize it so the SBPL profile and bwrap --bind get absolute paths.
  if (process.platform !== 'darwin') {
    return;
  }

  const result = resolveShellSandboxPlan({
    sandboxMode: 'workspace_write',
    projectRoot: '.',
    command: COMMAND,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const dIdx = result.plan.argv.indexOf('-D');
  const definition = result.plan.argv[dIdx + 1];
  assert.match(
    definition,
    /^WRITABLE_ROOT_0=\/.+/,
    'projectRoot must be resolved to an absolute path in the -D definition',
  );
  assert.ok(
    !/WRITABLE_ROOT_0=\.$/.test(definition),
    'relative . must not leak into the SBPL -D definition',
  );
});
