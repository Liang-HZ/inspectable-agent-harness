import assert from 'node:assert/strict';
import { mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentModelToolCall } from '../lib/agent-model-types';
import type { AgentRunPolicy } from '../lib/agent-permissions';
import { AgentApprovalRequiredError } from '../lib/agent-permissions';
import { createAgentRunContext } from '../lib/agent-run-context';
import { decideShellToolPermission } from '../lib/agent-shell-builtins';
import { classifyShellCommandSafety } from '../lib/agent-shell-safety';
import { executeAgentToolCall } from '../lib/agent-tool-runtime';

const originalInfo = console.info;

beforeEach(() => {
  console.info = () => {};
});

afterEach(() => {
  console.info = originalInfo;
});

function createShellToolCall(args: Record<string, unknown>): AgentModelToolCall {
  return {
    id: 'call-shell',
    name: 'shell',
    argumentsJson: JSON.stringify(args),
  };
}

async function executeShellTool(
  args: Record<string, unknown>,
  policy?: AgentRunPolicy,
) {
  return executeAgentToolCall(
    createShellToolCall(args),
    createAgentRunContext({
      runId: 'test-shell',
      policy: policy,
    }),
  );
}

function readResultObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);

  return value as Record<string, unknown>;
}

test('classifier accepts known read-only commands and pipelines', () => {
  const safeCommands = [
    'ls -la',
    'pwd',
    'cat package.json',
    'grep -rn "agent" lib',
    'git status',
    'git log --oneline -5',
    'git log master..main',
    'git branch -a',
    'find lib -name "*.ts"',
    'grep -c export lib/agent.ts | cat',
    "grep 'a b' lib/agent.ts",
    'sort package.json',
    'uniq notes.txt',
    'rg -n foo lib',
    'du -h lib',
    'git log --oneline | sort | uniq -c',
  ];

  for (const command of safeCommands) {
    const decision = classifyShellCommandSafety(command);
    assert.equal(decision.type, 'safe', `expected safe: ${command}`);
  }
});

test('classifier flags safe-listed commands whose arguments escape the project or can write/execute', () => {
  const reviewCommands = [
    'cat /etc/passwd',
    'head -5 ~/.zshrc',
    'cat ../outside.txt',
    'ls lib/../../sibling',
    'sort -o pwned.txt package.json',
    'sort -opwned.txt package.json',
    'sort --output=pwned.txt package.json',
    'uniq notes.txt pwned.txt',
    'tree -o pwned.txt',
    'rg --pre /bin/bash pattern lib',
    'rg --pre=/bin/bash pattern lib',
    'grep --include=/etc/passwd root lib',
    'git diff --output=/tmp/pwned',
    'git log --output=pwned.txt',
    'git -C / log',
    'git --git-dir=/tmp/other/.git log',
    'find / -name secrets',
    'find .. -name "*.env"',
    'git diff /etc/hosts',
  ];

  for (const command of reviewCommands) {
    const decision = classifyShellCommandSafety(command);
    assert.equal(
      decision.type,
      'needs_review',
      `expected needs_review: ${command}`,
    );
  }
});

test('classifier flags mutating or unanalyzable commands for review', () => {
  const reviewCommands = [
    'rm -rf node_modules',
    'npm install',
    'git push origin main',
    'git branch new-branch',
    'find . -name "*.log" -delete',
    'find . -exec rm {} +',
    'ls > files.txt',
    'cat a.txt; rm a.txt',
    'ls && rm -rf .',
    'echo `whoami`',
    'echo $(pwd)',
    'echo $HOME',
    'sleep 10 &',
    'cat < input.txt',
    'echo "unterminated',
    'ls \\-la',
  ];

  for (const command of reviewCommands) {
    const decision = classifyShellCommandSafety(command);
    assert.equal(
      decision.type,
      'needs_review',
      `expected needs_review: ${command}`,
    );
  }
});

test('shell permission override allows safe commands in read-only runs', () => {
  const decision = decideShellToolPermission(
    JSON.stringify({ command: 'git status' }),
    { approvalPolicy: 'strict', sandboxMode: 'read_only' },
  );

  assert.equal(decision?.type, 'allow');
  assert.equal(decision?.source, 'tool_override');
});

test('shell permission override denies unsafe commands in read-only runs', () => {
  const decision = decideShellToolPermission(
    JSON.stringify({ command: 'rm -rf .' }),
    { approvalPolicy: 'never', sandboxMode: 'read_only' },
  );

  assert.equal(decision?.type, 'deny');
  assert.equal(decision?.source, 'tool_override');
});

test('shell permission override defers unsafe commands to the run policy in write mode', () => {
  const decision = decideShellToolPermission(
    JSON.stringify({ command: 'npm test' }),
    { approvalPolicy: 'on_request', sandboxMode: 'workspace_write' },
  );

  assert.equal(decision, undefined);
});

test('shell executes a safe command and reports exit code and output', async () => {
  const execution = await executeShellTool({ command: 'echo hello-shell' });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  assert.match(execution.modelOutput, /Exit code: 0/);
  assert.match(execution.modelOutput, /hello-shell/);
  const result = readResultObject(execution.output.details);
  assert.equal(result.exitCode, 0);
  assert.equal(result.workdir, '.');
  assert.equal(String(result.stdout).trim(), 'hello-shell');
  assert.equal(result.stderr, '');
});

test('shell reports non-zero exit codes as normal tool output', async () => {
  const execution = await executeShellTool(
    { command: 'ls does-not-exist-anywhere' },
    { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
  );

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  const result = readResultObject(execution.output.details);
  assert.notEqual(result.exitCode, 0);
  assert.notEqual(result.stderr, '');
});

test('shell truncates oversized command output', async () => {
  const execution = await executeShellTool(
    {
      command: 'grep -o . package-lock.json',
    },
    { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
  );

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.output.details);
  assert.equal(result.stdoutTruncated, true);
  assert.match(execution.modelOutput, /truncated/);
});

test('shell kills the command after the per-call timeout', async () => {
  const startedAt = Date.now();
  const execution = await executeShellTool(
    { command: 'sleep 30', timeoutMs: 1000 },
    { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
  );

  assert.equal(execution.isError, true);
  assert.equal(execution.output.type, 'respond_to_model');
  assert.match(execution.modelOutput, /TIMEOUT/);
  assert.ok(Date.now() - startedAt < 10_000);
});

test('shell rejects unsafe commands in read-only runs at the permission boundary', async () => {
  const execution = await executeShellTool(
    { command: 'rm -rf node_modules' },
    { approvalPolicy: 'never', sandboxMode: 'read_only' },
  );

  assert.equal(execution.isError, true);
  assert.match(execution.modelOutput, /PERMISSION_DENIED/);
});

test('shell rejects safe-listed commands with project-escaping arguments in read-only runs', async () => {
  const readOutsideExecution = await executeShellTool(
    { command: 'cat /etc/passwd' },
    { approvalPolicy: 'never', sandboxMode: 'read_only' },
  );

  assert.equal(readOutsideExecution.isError, true);
  assert.match(readOutsideExecution.modelOutput, /PERMISSION_DENIED/);

  const writeOutsideExecution = await executeShellTool(
    { command: 'sort -o /tmp/pwned.txt package.json' },
    { approvalPolicy: 'never', sandboxMode: 'read_only' },
  );

  assert.equal(writeOutsideExecution.isError, true);
  assert.match(writeOutsideExecution.modelOutput, /PERMISSION_DENIED/);
});

test('shell child process does not inherit harness secrets', async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-secret-should-not-leak';

  try {
    const execution = await executeShellTool(
      { command: 'env' },
      { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
    );

    assert.equal(execution.isError, false);
    const result = readResultObject(execution.output.details);
    const stdout = String(result.stdout);
    assert.ok(!stdout.includes('OPENAI_API_KEY'), 'API key leaked into env');
    assert.ok(!stdout.includes('sk-test-secret-should-not-leak'));
    assert.match(stdout, /(^|\n)PATH=/);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test('shell requires approval for unsafe commands under on-request policy', async () => {
  await assert.rejects(
    executeShellTool(
      { command: 'npm run build' },
      { approvalPolicy: 'on_request', sandboxMode: 'workspace_write' },
    ),
    AgentApprovalRequiredError,
  );
});

test('shell resolves workdir inside the project and rejects escapes', async () => {
  const insideExecution = await executeShellTool({
    command: 'pwd',
    workdir: 'tests',
  });

  assert.equal(insideExecution.isError, false);
  assert.match(insideExecution.modelOutput, /tests/);

  const outsideExecution = await executeShellTool({
    command: 'pwd',
    workdir: '..',
  });

  assert.equal(outsideExecution.isError, true);
  assert.match(outsideExecution.modelOutput, /PATH_OUTSIDE_ALLOWED_ROOT/);
});

test('shell rejects a workdir symlink whose real directory is outside the project', async () => {
  const linkParent = path.join(process.cwd(), 'data');
  const linkPath = path.join(linkParent, 'shell-escape-link');

  await mkdir(linkParent, { recursive: true });
  await rm(linkPath, { force: true });
  await symlink(os.tmpdir(), linkPath, 'dir');

  try {
    const execution = await executeShellTool({
      command: 'pwd',
      workdir: 'data/shell-escape-link',
    });

    assert.equal(execution.isError, true);
    assert.match(execution.modelOutput, /PATH_OUTSIDE_ALLOWED_ROOT/);
  } finally {
    await rm(linkPath, { force: true });
  }
});

test('shell rejects invalid arguments as a validation error', async () => {
  const execution = await executeShellTool({ command: '' });

  assert.equal(execution.isError, true);
  assert.match(execution.modelOutput, /VALIDATION_ERROR/);
});
