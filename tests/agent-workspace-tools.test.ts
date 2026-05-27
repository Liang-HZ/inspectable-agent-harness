import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentModelToolCall } from '../lib/agent-model-types';
import { createAgentRunContext } from '../lib/agent-run-context';
import { executeAgentToolCall } from '../lib/agent-tool-runtime';

const originalInfo = console.info;

beforeEach(() => {
  console.info = () => {};
});

afterEach(() => {
  console.info = originalInfo;
});

function createToolCall(
  name: string,
  args: Record<string, unknown>,
): AgentModelToolCall {
  return {
    id: `call-${name}`,
    name: name,
    argumentsJson: JSON.stringify(args),
  };
}

async function executeWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
) {
  return executeAgentToolCall(
    createToolCall(name, args),
    createAgentRunContext({ runId: `test-${name}` }),
  );
}

function readResultObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);

  return value as Record<string, unknown>;
}

test('read returns file contents with line metadata', async () => {
  const execution = await executeWorkspaceTool('read', {
    path: 'tests/fixtures/workspace-tools/src/example.ts',
    limit: 20,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  assert.equal(result.path, 'tests/fixtures/workspace-tools/src/example.ts');
  assert.equal(result.startLine, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.notice, null);
  assert.match(String(result.content), /meaningfulFunction/);
});

test('read rejects paths outside the workspace root as a tool error', async () => {
  const execution = await executeWorkspaceTool('read', {
    path: '../package.json',
  });

  assert.equal(execution.isError, true);
  assert.match(String(execution.result), /outside the workspace root/);
});

test('read reports pagination notice when output is line-limited', async () => {
  const execution = await executeWorkspaceTool('read', {
    path: 'tests/fixtures/workspace-tools/docs/long.txt',
    limit: 2,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  assert.equal(result.truncated, true);
  assert.equal(result.endLine, 2);
  assert.match(String(result.notice), /Use offset=3 to continue/);
});

test('grep returns structured matches from ripgrep', async () => {
  const execution = await executeWorkspaceTool('grep', {
    pattern: 'meaningfulFunction',
    path: 'tests/fixtures/workspace-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  const matches = result.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assert.equal(
    matches[0].path,
    'tests/fixtures/workspace-tools/src/example.ts',
  );
  assert.equal(matches[0].lineNumber, 1);
  assert.match(String(matches[0].line), /meaningfulFunction/);
});

test('grep reports a limit notice when matches are truncated', async () => {
  const execution = await executeWorkspaceTool('grep', {
    pattern: 'workspace-search-marker',
    path: 'tests/fixtures/workspace-tools',
    limit: 1,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  const matches = result.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assert.equal(result.truncated, true);
  assert.match(String(result.notice), /1 match limit reached/);
});

test('find returns matching workspace file paths', async () => {
  const execution = await executeWorkspaceTool('find', {
    pattern: '*.ts',
    path: 'tests/fixtures/workspace-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  assert.deepEqual(result.paths, [
    'tests/fixtures/workspace-tools/src/example.ts',
  ]);
});

test('ls returns directory entries with deterministic order', async () => {
  const execution = await executeWorkspaceTool('ls', {
    path: 'tests/fixtures/workspace-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  const result = readResultObject(execution.result);
  const entries = result.entries as Array<Record<string, unknown>>;
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['docs', 'src'],
  );
});
