// OS-level sandbox resolver for the agent shell tool.
//
// This module is the platform-agnostic entry point. It decides, for a given
// sandbox mode and project root, how to wrap `bash -c <command>` so the
// subprocess and everything it forks is constrained by the OS:
//
//   - macOS:  /usr/bin/sandbox-exec -p <SBPL profile> -D ... -- bash -c <cmd>
//   - Linux:  /usr/bin/bwrap <argv> -- bash -c <cmd>
//
// danger_full_access bypasses the sandbox entirely and returns a raw
// `bash -c <command>` argv. This is not a fallback: it is the explicit
// contract for a mode where the user has opted out of OS isolation, mirroring
// Codex's `SandboxPolicy::DangerFullAccess` which returns the command
// unchanged from `create_bwrap_command_args`.
//
// read_only and workspace_write fail closed: if the platform's sandbox binary
// is missing (bwrap not installed on Linux Server, sandbox-exec disabled on a
// hardened macOS, or the platform is Windows/unsupported), the resolver
// returns `{ ok: false, errorCode: 'EXECUTION_ERROR', reason: ... }` and the
// shell tool surfaces that to the model. This matches Codex's philosophy:
// "if the requested policy cannot be enforced, refuse to run. Never silently
// fall back to unsandboxed."
//
// The platform-specific argv/profile builders (`agent-shell-sandbox-macos.ts`,
// `agent-shell-sandbox-linux.ts`) are pure functions. This module owns the
// impure concerns: `process.platform`, `existsSync` on the sandbox binary,
// and assembling the final argv. The split keeps the builders unit-testable
// without touching the filesystem, and keeps the fail-closed decision in one
// place.

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { AgentRunPolicy } from './agent-permissions';
import {
  buildMacosSbplProfile,
  MACOS_SANDBOX_READONLY_CARVEOUTS,
} from './agent-shell-sandbox-macos';
import { buildLinuxBwrapArgv } from './agent-shell-sandbox-linux';

// Pinned absolute paths, not PATH lookup. Codex pins `/usr/bin/sandbox-exec`
// explicitly to defend against an attacker injecting a malicious sandbox-exec
// earlier on PATH. The same reasoning applies to bwrap: if an attacker can
// place a fake `bwrap` on PATH, they can run code as the user before the
// sandbox is even established. Pinning to `/usr/bin/` (where the OS package
// manager installs both) closes that vector.
export const MACOS_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';
export const LINUX_BWRAP_EXECUTABLE = '/usr/bin/bwrap';

// Carveout list is owned by the macOS module (it needs the list at SBPL
// generation time). Re-export for the Linux path and for tests/docs so both
// platforms carve out the same directories.
export const SANDBOX_READONLY_CARVEOUTS = MACOS_SANDBOX_READONLY_CARVEOUTS;

export type AgentShellSandboxMode = AgentRunPolicy['sandboxMode'];

export type AgentShellSandboxPlan = {
  // The executable to spawn: '/usr/bin/sandbox-exec', '/usr/bin/bwrap', or
  // 'bash' (danger_full_access only).
  executable: string;
  // The full argv to pass to the executable, including `bash -c <command>`
  // at the end. For danger_full_access this is `['-c', command]`.
  argv: string[];
};

export type AgentShellSandboxResolution =
  | { ok: true; plan: AgentShellSandboxPlan }
  | { ok: false; errorCode: 'EXECUTION_ERROR'; reason: string };

export type AgentShellSandboxInput = {
  sandboxMode: AgentShellSandboxMode;
  // Absolute path of the project root. The shell tool's `resolveShellWorkdir`
  // already produces a realpath-validated workdir, but the sandbox confines
  // the whole project root (not just the workdir), so callers should pass
  // `currentProjectPathAccessPolicy.root`.
  projectRoot: string;
  // The model-supplied shell command string, passed verbatim to `bash -c`.
  command: string;
};

// Pure builder for the macOS argv. Split out so the resolver can call it
// without the fs check, and tests can call it with a stubbed `existsSync`.
function buildMacosSeatbeltArgv(input: {
  projectRoot: string;
  command: string;
  allowWrite: boolean;
}): AgentShellSandboxPlan {
  const { profile, definitions } = buildMacosSbplProfile({
    writableRoot: input.projectRoot,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: input.allowWrite,
  });

  const argv: string[] = ['-p', profile];
  for (const definition of definitions) {
    argv.push('-D', definition);
  }
  argv.push('--', 'bash', '-c', input.command);

  return {
    executable: MACOS_SEATBELT_EXECUTABLE,
    argv: argv,
  };
}

// Pure builder for the Linux argv.
function buildLinuxBwrapArgvPlan(input: {
  projectRoot: string;
  command: string;
  allowWrite: boolean;
}): AgentShellSandboxPlan {
  const argv = buildLinuxBwrapArgv({
    projectRoot: input.projectRoot,
    command: input.command,
    carveouts: SANDBOX_READONLY_CARVEOUTS,
    allowWrite: input.allowWrite,
  });

  return {
    executable: LINUX_BWRAP_EXECUTABLE,
    argv: argv,
  };
}

export function resolveShellSandboxPlan(
  input: AgentShellSandboxInput,
): AgentShellSandboxResolution {
  // danger_full_access: no sandbox, ever. The user has explicitly opted out.
  if (input.sandboxMode === 'danger_full_access') {
    return {
      ok: true,
      plan: {
        executable: 'bash',
        argv: ['-c', input.command],
      },
    };
  }

  // read_only and workspace_write: OS sandbox is mandatory. Fail closed if
  // the platform is unsupported or the binary is missing.
  const allowWrite = input.sandboxMode === 'workspace_write';
  const projectRoot = path.resolve(input.projectRoot);

  if (process.platform === 'darwin') {
    if (!existsSync(MACOS_SEATBELT_EXECUTABLE)) {
      return {
        ok: false,
        errorCode: 'EXECUTION_ERROR',
        reason: `OS sandbox is required for sandboxMode=${input.sandboxMode} but ${MACOS_SEATBELT_EXECUTABLE} is not present. Refusing to run unsandboxed (fail-closed). Use sandboxMode=danger_full_access to explicitly opt out of the sandbox.`,
      };
    }

    return {
      ok: true,
      plan: buildMacosSeatbeltArgv({
        projectRoot: projectRoot,
        command: input.command,
        allowWrite: allowWrite,
      }),
    };
  }

  if (process.platform === 'linux') {
    if (!existsSync(LINUX_BWRAP_EXECUTABLE)) {
      return {
        ok: false,
        errorCode: 'EXECUTION_ERROR',
        reason: `OS sandbox is required for sandboxMode=${input.sandboxMode} but ${LINUX_BWRAP_EXECUTABLE} is not installed. Install bubblewrap (e.g. \`apt install bubblewrap\`) or use sandboxMode=danger_full_access to explicitly opt out of the sandbox. Refusing to run unsandboxed (fail-closed).`,
      };
    }

    return {
      ok: true,
      plan: buildLinuxBwrapArgvPlan({
        projectRoot: projectRoot,
        command: input.command,
        allowWrite: allowWrite,
      }),
    };
  }

  return {
    ok: false,
    errorCode: 'EXECUTION_ERROR',
    reason: `OS sandbox is required for sandboxMode=${input.sandboxMode} but platform ${process.platform} has no sandbox backend implemented. Use sandboxMode=danger_full_access to explicitly opt out of the sandbox. Refusing to run unsandboxed (fail-closed).`,
  };
}
