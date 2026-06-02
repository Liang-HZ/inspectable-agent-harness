import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentEvent } from '../lib/agent-events';
import type { AgentModelToolCall } from '../lib/agent-model-types';
import { createAgentRunContext } from '../lib/agent-run-context';
import { executeAgentToolCall } from '../lib/agent-tool-runtime';
import type { AgentToolDefinition } from '../lib/agent-tools';
import { agentToolRegistry } from '../lib/agent-tools';
import { noPathAccessPolicy } from '../lib/agent-path-policy';

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

async function executeBuiltinTool(name: string, args: Record<string, unknown>) {
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
  const execution = await executeBuiltinTool('read', {
    path: 'tests/fixtures/builtin-tools/src/example.ts',
    limit: 20,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  assert.match(execution.modelOutput, /meaningfulFunction/);
  const result = readResultObject(execution.output.details);
  assert.equal(result.path, 'tests/fixtures/builtin-tools/src/example.ts');
  assert.equal(result.startLine, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.notice, null);
  assert.match(String(result.content), /meaningfulFunction/);
});

test('read rejects paths outside the current allowed root as a tool error', async () => {
  const execution = await executeBuiltinTool('read', {
    path: '../package.json',
  });

  assert.equal(execution.isError, true);
  assert.equal(execution.output.type, 'respond_to_model');
  assert.equal(execution.output.error.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
  assert.match(execution.modelOutput, /^Error \[PATH_OUTSIDE_ALLOWED_ROOT\]:/);
});

test('read reports pagination notice when output is line-limited', async () => {
  const execution = await executeBuiltinTool('read', {
    path: 'tests/fixtures/builtin-tools/docs/long.txt',
    limit: 2,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  assert.match(
    execution.modelOutput,
    /\[Showing lines 1-2 of 5\. Use offset=3 to continue\.\]/,
  );
  const result = readResultObject(execution.output.details);
  assert.equal(result.truncated, true);
  assert.equal(result.endLine, 2);
  assert.match(String(result.notice), /Use offset=3 to continue/);
});

test('read accepts OpenAI strict-mode null optional arguments', async () => {
  const execution = await executeBuiltinTool('read', {
    path: 'tests/fixtures/builtin-tools/src/example.ts',
    offset: null,
    limit: null,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  const result = readResultObject(execution.output.details);
  assert.equal(result.startLine, 1);
  assert.match(String(result.content), /meaningfulFunction/);
});

test('tool permission event includes runtime contract metadata', async () => {
  const events: AgentEvent[] = [];
  await executeAgentToolCall(
    createToolCall('read', {
      path: 'tests/fixtures/builtin-tools/src/example.ts',
    }),
    createAgentRunContext({ runId: 'test-permission-metadata' }),
    {
      onEvent: (event) => events.push(event),
    },
  );
  const permissionEvent = events.find(
    (event) => event.type === 'tool_permission_decided',
  );

  assert.notEqual(permissionEvent, undefined);
  if (permissionEvent?.type !== 'tool_permission_decided') {
    throw new Error('Expected tool_permission_decided event.');
  }

  assert.equal(permissionEvent.request.source, 'builtin');
  assert.equal(permissionEvent.request.group, 'read_only_builtins');
  assert.equal(permissionEvent.request.category, 'read');
  assert.equal(permissionEvent.request.pathAccess.type, 'current_project');
  assert.equal(permissionEvent.request.executionMode, 'parallel');
});

test('grep returns structured matches from ripgrep', async () => {
  const execution = await executeBuiltinTool('grep', {
    pattern: 'meaningfulFunction',
    path: 'tests/fixtures/builtin-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  const result = readResultObject(execution.output.details);
  const matches = result.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, 'tests/fixtures/builtin-tools/src/example.ts');
  assert.equal(matches[0].lineNumber, 1);
  assert.match(String(matches[0].line), /meaningfulFunction/);
});

test('grep reports a limit notice when matches are truncated', async () => {
  const execution = await executeBuiltinTool('grep', {
    pattern: 'builtin-search-marker',
    path: 'tests/fixtures/builtin-tools',
    limit: 1,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  assert.match(execution.modelOutput, /\[1 match limit reached/);
  const result = readResultObject(execution.output.details);
  const matches = result.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assert.equal(result.truncated, true);
  assert.match(String(result.notice), /1 match limit reached/);
});

test('find returns matching project file paths', async () => {
  const execution = await executeBuiltinTool('find', {
    pattern: '*.ts',
    path: 'tests/fixtures/builtin-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  const result = readResultObject(execution.output.details);
  assert.deepEqual(result.paths, [
    'tests/fixtures/builtin-tools/src/example.ts',
  ]);
});

test('ls returns directory entries with deterministic order', async () => {
  const execution = await executeBuiltinTool('ls', {
    path: 'tests/fixtures/builtin-tools',
    limit: 10,
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.output.type, 'success');
  const result = readResultObject(execution.output.details);
  const entries = result.entries as Array<Record<string, unknown>>;
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['docs', 'src'],
  );
});

test('tool runtime converts timeout into model-visible text output', async () => {
  const toolDefinition = createSlowToolDefinition('test_timeout_tool', 10);
  agentToolRegistry.set(toolDefinition.name, toolDefinition);

  try {
    const execution = await executeAgentToolCall(
      {
        id: 'call-timeout',
        name: toolDefinition.name,
        argumentsJson: '{}',
      },
      createAgentRunContext({ runId: 'test-timeout' }),
    );

    assert.equal(execution.isError, true);
    assert.equal(execution.output.type, 'respond_to_model');
    assert.equal(execution.output.error.code, 'TIMEOUT');
    assert.match(execution.modelOutput, /^Error \[TIMEOUT\]:/);
  } finally {
    agentToolRegistry.delete(toolDefinition.name);
  }
});

test('tool runtime converts in-flight abort into model-visible text output', async () => {
  const toolDefinition = createSlowToolDefinition('test_abort_tool', 100);
  const abortController = new AbortController();
  agentToolRegistry.set(toolDefinition.name, toolDefinition);

  try {
    const executionPromise = executeAgentToolCall(
      {
        id: 'call-abort',
        name: toolDefinition.name,
        argumentsJson: '{}',
      },
      createAgentRunContext({
        runId: 'test-abort',
        signal: abortController.signal,
      }),
    );
    setTimeout(() => abortController.abort(), 5);

    const execution = await executionPromise;

    assert.equal(execution.isError, true);
    assert.equal(execution.output.type, 'respond_to_model');
    assert.equal(execution.output.error.code, 'ABORTED');
    assert.match(execution.modelOutput, /^Error \[ABORTED\]:/);
  } finally {
    agentToolRegistry.delete(toolDefinition.name);
  }
});

function createSlowToolDefinition(
  name: string,
  timeoutMs: number,
): AgentToolDefinition {
  return {
    name: name,
    source: 'builtin',
    group: 'utility_builtins',
    category: 'utility',
    annotations: {
      readOnly: true,
      destructive: false,
      openWorld: false,
      idempotent: true,
    },
    executionMode: 'parallel',
    timeoutMs: timeoutMs,
    abortable: true,
    pathAccess: noPathAccessPolicy,
    modelTool: {
      name: name,
      description: 'Test-only slow tool.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      schemaStrict: true,
    },
    execute: async (
      _argumentsJson: string,
      signal: AbortSignal | undefined,
    ) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      return {
        input: {},
        output: {
          type: 'success',
          contentText: 'slow tool completed',
        },
      };
    },
  };
}
