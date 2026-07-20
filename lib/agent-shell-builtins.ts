import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

import * as z from 'zod';

import type {
  AgentPermissionDecision,
  AgentRunPolicy,
} from './agent-permissions';
import {
  AgentToolRespondToModelError,
  createSuccessToolOutput,
} from './agent-tool-output';
import type {
  AgentToolDefinition,
  AgentToolResult,
  AgentToolRuntimeContext,
} from './agent-tool-contracts';
import {
  assertAgentPathAllowedByPolicy,
  currentProjectPathAccessPolicy,
  displayAgentToolPath,
  resolveAgentToolPath,
  type ResolvedAgentToolPath,
} from './agent-path-policy';
import {
  classifyShellCommandSafety,
  type ShellCommandSafetyDecision,
} from './agent-shell-safety';
import {
  resolveShellSandboxPlan,
  type AgentShellSandboxMode,
} from './agent-shell-sandbox';

export const SHELL_TOOL_HARD_TIMEOUT_MS = 60_000;
export const DEFAULT_SHELL_COMMAND_TIMEOUT_MS = 10_000;
const MIN_SHELL_COMMAND_TIMEOUT_MS = 1_000;
const MAX_SHELL_OUTPUT_CHARS = 10_240;
const MAX_SHELL_OUTPUT_LINES = 256;
const TIMEOUT_PARTIAL_OUTPUT_CHARS = 2_000;

type ShellCommandResult = {
  command: string;
  workdir: string;
  exitCode: number | null;
  terminationSignal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  safety: ShellCommandSafetyDecision;
  notice: string | null;
};

type CollectedProcessOutput = {
  text: string;
  truncated: boolean;
};

const optionalTrimmedString = z.preprocess(
  (value) =>
    value === null || (typeof value === 'string' && value.trim() === '')
      ? undefined
      : value,
  z
    .string({ error: 'Field `workdir` must be a string.' })
    .trim()
    .optional(),
);

const shellInputSchema = z.strictObject({
  command: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'Field `command` is required.'
          : 'Field `command` must be a string.',
    })
    .trim()
    .min(1, { error: 'Field `command` is required.' }),
  workdir: optionalTrimmedString,
  timeoutMs: z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .number({ error: 'Field `timeoutMs` must be a number.' })
      .int({ error: 'Field `timeoutMs` must be an integer.' })
      .min(MIN_SHELL_COMMAND_TIMEOUT_MS, {
        error: `Field \`timeoutMs\` must be at least ${MIN_SHELL_COMMAND_TIMEOUT_MS}.`,
      })
      .max(SHELL_TOOL_HARD_TIMEOUT_MS, {
        error: `Field \`timeoutMs\` must be at most ${SHELL_TOOL_HARD_TIMEOUT_MS}.`,
      })
      .optional(),
  ),
});

type ShellInput = z.infer<typeof shellInputSchema>;

function parseShellToolInput(argumentsJson: string): ShellInput {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argumentsJson);
  } catch {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      'Tool `shell` received invalid JSON arguments.',
    );
  }

  const parsedInput = shellInputSchema.safeParse(parsedJson);

  if (!parsedInput.success) {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      'Tool `shell` received invalid arguments.',
    );
  }

  return parsedInput.data;
}

function readShellCommandArgument(argumentsJson: string): string | undefined {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }

  if (
    typeof parsedJson !== 'object' ||
    parsedJson === null ||
    Array.isArray(parsedJson)
  ) {
    return undefined;
  }

  const command = (parsedJson as Record<string, unknown>).command;

  return typeof command === 'string' && command.trim() !== ''
    ? command.trim()
    : undefined;
}

export function decideShellToolPermission(
  argumentsJson: string,
  policy: AgentRunPolicy,
): AgentPermissionDecision | undefined {
  const command = readShellCommandArgument(argumentsJson);

  if (command === undefined) {
    return {
      type: 'deny',
      source: 'tool_override',
      errorCode: 'VALIDATION_ERROR',
      reason: 'Tool `shell` requires a non-empty `command` string argument.',
    };
  }

  const safety = classifyShellCommandSafety(command);

  if (safety.type === 'safe') {
    return {
      type: 'allow',
      source: 'tool_override',
      reason: safety.reason,
    };
  }

  if (policy.sandboxMode === 'read_only') {
    return {
      type: 'deny',
      source: 'tool_override',
      errorCode: 'PERMISSION_DENIED',
      reason: `This run is read-only, so only known read-only commands can execute. ${safety.reason}`,
    };
  }

  return undefined;
}

async function resolveShellWorkdir(
  workdir: string | undefined,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<ResolvedAgentToolPath> {
  const resolvedPath = resolveAgentToolPath(workdir, pathAccess);

  // Same realpath-then-recheck sequence as the file builtins: a lexically
  // in-project workdir can still be a symlink whose real directory is outside
  // the allowed root.
  let realAbsolutePath: string;
  try {
    realAbsolutePath = await realpath(
      /* turbopackIgnore: true */ resolvedPath.absolutePath,
    );
  } catch {
    throw new AgentToolRespondToModelError(
      'PATH_NOT_FOUND',
      `Working directory not found: ${resolvedPath.displayPath}`,
    );
  }

  assertAgentPathAllowedByPolicy(realAbsolutePath, pathAccess);

  const workdirStat = await stat(
    /* turbopackIgnore: true */ realAbsolutePath,
  );

  if (!workdirStat.isDirectory()) {
    throw new AgentToolRespondToModelError(
      'NOT_A_DIRECTORY',
      `Working directory is not a directory: ${resolvedPath.displayPath}`,
    );
  }

  return {
    absolutePath: realAbsolutePath,
    displayPath: displayAgentToolPath(realAbsolutePath, pathAccess),
  };
}

function appendCollectedOutput(
  collected: CollectedProcessOutput,
  chunk: string,
): void {
  if (collected.truncated) {
    return;
  }

  collected.text += chunk;

  if (collected.text.length > MAX_SHELL_OUTPUT_CHARS) {
    collected.text = collected.text.slice(0, MAX_SHELL_OUTPUT_CHARS);
    collected.truncated = true;
    return;
  }

  const lines = collected.text.split('\n');

  if (lines.length > MAX_SHELL_OUTPUT_LINES + 1) {
    collected.text = lines.slice(0, MAX_SHELL_OUTPUT_LINES).join('\n');
    collected.truncated = true;
  }
}

// The child process must not inherit the harness's secrets: with a full
// `process.env`, one approved `printenv` puts OPENAI_API_KEY into
// model-visible output and the session JSONL. Allowlist the harmless
// variables instead of denylisting known secret names.
const SHELL_ENV_ALLOWED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'LANG',
]);

function createSanitizedShellEnv(): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
  };

  for (const [name, value] of Object.entries(process.env)) {
    if (SHELL_ENV_ALLOWED_NAMES.has(name) || name.startsWith('LC_')) {
      sanitizedEnv[name] = value;
    }
  }

  return sanitizedEnv;
}

type SpawnedShellCommandResult = {
  exitCode: number | null;
  terminationSignal: string | null;
  stdout: CollectedProcessOutput;
  stderr: CollectedProcessOutput;
  timedOut: boolean;
};

function runShellCommandProcess(
  command: string,
  workdirAbsolutePath: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  sandboxMode: AgentShellSandboxMode | undefined,
): Promise<SpawnedShellCommandResult> {
  // Default to read_only when the runtime did not carry a sandbox mode (older
  // call paths, or a future tool that does not populate the field). This is
  // the safest default: it produces the most restrictive sandbox profile.
  const effectiveSandboxMode: AgentShellSandboxMode =
    sandboxMode ?? 'read_only';

  const sandboxPlan = resolveShellSandboxPlan({
    sandboxMode: effectiveSandboxMode,
    projectRoot: currentProjectPathAccessPolicy.root,
    command: command,
  });

  if (!sandboxPlan.ok) {
    // Fail closed: surface the resolver's reason to the model as an
    // EXECUTION_ERROR. The shell tool's existing error path serializes this
    // into a tool result the model can read and react to.
    return Promise.reject(
      new AgentToolRespondToModelError(
        sandboxPlan.errorCode,
        sandboxPlan.reason,
      ),
    );
  }

  const { executable, argv } = sandboxPlan.plan;

  return new Promise((resolve, reject) => {
    // `detached: true` puts the child (sandbox-exec / bwrap / bash) in its
    // own process group so a timeout/abort SIGKILL reaches bash too. Without
    // this, killing sandbox-exec directly could orphan bash, because SIGKILL
    // cannot be forwarded through the sandbox binary. bwrap's
    // --die-with-parent is the belt; this is the suspenders.
    const child = spawn(executable, argv, {
      cwd: workdirAbsolutePath,
      env: createSanitizedShellEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const stdout: CollectedProcessOutput = { text: '', truncated: false };
    const stderr: CollectedProcessOutput = { text: '', truncated: false };
    let timedOut = false;
    let settled = false;

    function killChildProcess(): void {
      if (child.exitCode === null && child.signalCode === null) {
        // Kill the whole process group (negative pid) so bash dies with
        // sandbox-exec / bwrap. `child.pid` is the group leader's pid
        // because of `detached: true`.
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // If the group is already gone (ESRCH), fall back to killing the
          // child directly. This is best-effort: by this point the child is
          // almost certainly already dead.
          child.kill('SIGKILL');
        }
      }
    }

    function handleAbort(): void {
      killChildProcess();
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChildProcess();
    }, timeoutMs);

    signal?.addEventListener('abort', handleAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', handleAbort);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      appendCollectedOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      appendCollectedOutput(stderr, chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        new AgentToolRespondToModelError(
          'EXECUTION_ERROR',
          `Failed to start shell process: ${error.message}`,
        ),
      );
    });

    child.on('close', (exitCode, terminationSignal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        exitCode: exitCode,
        terminationSignal: terminationSignal,
        stdout: stdout,
        stderr: stderr,
        timedOut: timedOut,
      });
    });
  });
}

function createShellOutputNotice(
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
): string | null {
  if (!stdoutTruncated && !stderrTruncated) {
    return null;
  }

  const truncatedStreams = [
    stdoutTruncated ? 'stdout' : undefined,
    stderrTruncated ? 'stderr' : undefined,
  ]
    .filter((stream): stream is string => stream !== undefined)
    .join(' and ');

  return `${truncatedStreams} truncated to ${MAX_SHELL_OUTPUT_CHARS} chars / ${MAX_SHELL_OUTPUT_LINES} lines.`;
}

function formatShellStream(text: string): string {
  return text === '' ? '(empty)' : text;
}

function formatShellCommandResult(result: ShellCommandResult): string {
  const exitLine =
    result.exitCode === null
      ? `Terminated by signal: ${result.terminationSignal ?? 'unknown'}`
      : `Exit code: ${result.exitCode}`;

  return [
    `Command: ${result.command}`,
    `Workdir: ${result.workdir}`,
    `${exitLine} (${result.durationMs}ms)`,
    '',
    'stdout:',
    formatShellStream(result.stdout),
    '',
    'stderr:',
    formatShellStream(result.stderr),
  ].join('\n');
}

function createTimeoutPartialOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((text) => text !== '').join('\n');

  if (combined === '') {
    return '';
  }

  const tail = combined.slice(-TIMEOUT_PARTIAL_OUTPUT_CHARS);

  return `\nPartial output before timeout:\n${tail}`;
}

async function executeShellCommand(
  input: ShellInput,
  signal: AbortSignal | undefined,
  runtime: AgentToolRuntimeContext,
): Promise<ShellCommandResult> {
  const workdir = await resolveShellWorkdir(input.workdir, runtime.pathAccess);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHELL_COMMAND_TIMEOUT_MS;
  const startedAt = Date.now();
  const processResult = await runShellCommandProcess(
    input.command,
    workdir.absolutePath,
    timeoutMs,
    signal,
    runtime.sandboxMode,
  );
  const durationMs = Date.now() - startedAt;

  if (processResult.timedOut) {
    throw new AgentToolRespondToModelError(
      'TIMEOUT',
      `Command timed out after ${timeoutMs}ms and was killed.${createTimeoutPartialOutput(
        processResult.stdout.text,
        processResult.stderr.text,
      )}`,
      {
        command: input.command,
        workdir: workdir.displayPath,
        timeoutMs: timeoutMs,
      },
    );
  }

  return {
    command: input.command,
    workdir: workdir.displayPath,
    exitCode: processResult.exitCode,
    terminationSignal: processResult.terminationSignal,
    durationMs: durationMs,
    stdout: processResult.stdout.text,
    stderr: processResult.stderr.text,
    stdoutTruncated: processResult.stdout.truncated,
    stderrTruncated: processResult.stderr.truncated,
    safety: classifyShellCommandSafety(input.command),
    notice: createShellOutputNotice(
      processResult.stdout.truncated,
      processResult.stderr.truncated,
    ),
  };
}

const shellToolDefinition = {
  name: 'shell',
  source: 'builtin',
  group: 'shell_builtins',
  category: 'shell',
  annotations: {
    readOnly: false,
    destructive: true,
    openWorld: true,
    idempotent: false,
  },
  executionMode: 'sequential',
  timeoutMs: SHELL_TOOL_HARD_TIMEOUT_MS,
  abortable: true,
  pathAccess: currentProjectPathAccessPolicy,
  permissionInput: {
    pathArgumentName: 'workdir',
  },
  decidePermission: decideShellToolPermission,
  modelTool: {
    name: 'shell',
    description:
      'Run a shell command with bash -c inside the project. Known read-only commands with project-relative arguments (ls, cat, grep, git status/log/diff, ...) run without approval; absolute paths, `~`, `..`, and any other command follow the run approval policy. Output is truncated, so prefer specific commands over broad dumps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to execute with bash -c. Keep it a single command or a simple pipeline; command chaining and redirection require approval.',
        },
        workdir: {
          type: 'string',
          description:
            'Working directory for the command. Relative paths resolve from the current project root. Defaults to the project root.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds between ${MIN_SHELL_COMMAND_TIMEOUT_MS} and ${SHELL_TOOL_HARD_TIMEOUT_MS}. Defaults to ${DEFAULT_SHELL_COMMAND_TIMEOUT_MS}.`,
        },
      },
      required: ['command'],
    },
    schemaStrict: true,
  },
  execute: async (
    argumentsJson: string,
    signal: AbortSignal | undefined,
    runtime: AgentToolRuntimeContext,
  ): Promise<AgentToolResult> => {
    const input = parseShellToolInput(argumentsJson);
    const result = await executeShellCommand(input, signal, runtime);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatShellCommandResult(result),
        details: result,
        notice: result.notice,
        truncated: result.stdoutTruncated || result.stderrTruncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

export const builtinShellToolDefinitions: AgentToolDefinition[] = [
  shellToolDefinition,
];
