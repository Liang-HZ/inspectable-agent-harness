import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentEvent } from '../lib/agent-events';
import {
  listPendingAgentApprovals,
  resolveAgentApproval,
  waitForAgentApproval,
} from '../lib/agent-approvals';
import type { AgentModelToolCall } from '../lib/agent-model-types';
import { createAgentRunContext } from '../lib/agent-run-context';
import { executeAgentToolCall } from '../lib/agent-tool-runtime';
import {
  agentToolRegistry,
  type AgentToolDefinition,
} from '../lib/agent-tools';
import { noPathAccessPolicy } from '../lib/agent-path-policy';

const originalInfo = console.info;

beforeEach(() => {
  console.info = () => {};
});

afterEach(() => {
  console.info = originalInfo;
});

function createRiskyToolDefinition(name: string): AgentToolDefinition {
  return {
    name: name,
    source: 'builtin',
    group: 'shell_builtins',
    category: 'shell',
    annotations: {
      readOnly: false,
      destructive: true,
      openWorld: false,
      idempotent: false,
    },
    executionMode: 'sequential',
    timeoutMs: 10_000,
    abortable: true,
    pathAccess: noPathAccessPolicy,
    modelTool: {
      name: name,
      description: 'Test-only risky tool.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      schemaStrict: true,
    },
    execute: () => {
      return {
        input: {},
        output: {
          type: 'success',
          contentText: 'risky tool executed',
        },
      };
    },
  };
}

function createToolCall(name: string, id: string): AgentModelToolCall {
  return {
    id: id,
    name: name,
    argumentsJson: '{}',
  };
}

test('waitForAgentApproval resolves on a matching resolveAgentApproval call', async () => {
  const controller = new AbortController();
  const approvalPromise = waitForAgentApproval({
    runId: 'run-a',
    toolCallId: 'call-1',
    toolName: 'test_tool',
    argumentsJson: '{}',
    reason: 'needs approval',
    signal: controller.signal,
  });

  const pendingBeforeResolve = listPendingAgentApprovals('run-a');
  assert.equal(pendingBeforeResolve.length, 1);
  assert.equal(pendingBeforeResolve[0]?.toolCallId, 'call-1');
  assert.equal(pendingBeforeResolve[0]?.toolName, 'test_tool');
  assert.equal(pendingBeforeResolve[0]?.reason, 'needs approval');

  const result = resolveAgentApproval('run-a', 'call-1', 'approve');
  assert.equal(result.ok, true);

  const resolution = await approvalPromise;
  assert.equal(resolution.type, 'approved');
  assert.deepEqual(listPendingAgentApprovals('run-a'), []);
});

test('resolveAgentApproval with deny produces a denied resolution', async () => {
  const approvalPromise = waitForAgentApproval({
    runId: 'run-b',
    toolCallId: 'call-1',
    toolName: 'test_tool',
    argumentsJson: '{}',
    reason: 'needs approval',
    signal: undefined,
  });

  const result = resolveAgentApproval('run-b', 'call-1', 'deny');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.resolution.type, 'denied');

  const resolution = await approvalPromise;
  assert.equal(resolution.type, 'denied');
  assert.equal(resolution.type === 'denied' && resolution.source, 'user');
});

test('resolveAgentApproval reports failure for an unknown pending approval', () => {
  const result = resolveAgentApproval('missing-run', 'missing-call', 'approve');
  assert.equal(result.ok, false);
});

test('waitForAgentApproval times out and denies when nobody responds', async () => {
  const resolution = await waitForAgentApproval({
    runId: 'run-timeout',
    toolCallId: 'call-1',
    toolName: 'test_tool',
    argumentsJson: '{}',
    reason: 'needs approval',
    signal: undefined,
    timeoutMs: 20,
  });

  assert.equal(resolution.type, 'denied');
  assert.equal(resolution.type === 'denied' && resolution.source, 'timeout');
});

test('waitForAgentApproval denies immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const resolution = await waitForAgentApproval({
    runId: 'run-aborted',
    toolCallId: 'call-1',
    toolName: 'test_tool',
    argumentsJson: '{}',
    reason: 'needs approval',
    signal: controller.signal,
  });

  assert.equal(resolution.type, 'denied');
  assert.equal(resolution.type === 'denied' && resolution.source, 'abort');
});

test('waitForAgentApproval denies when the run is aborted while waiting', async () => {
  const controller = new AbortController();
  const approvalPromise = waitForAgentApproval({
    runId: 'run-live-abort',
    toolCallId: 'call-1',
    toolName: 'test_tool',
    argumentsJson: '{}',
    reason: 'needs approval',
    signal: controller.signal,
  });

  controller.abort();

  const resolution = await approvalPromise;
  assert.equal(resolution.type, 'denied');
  assert.equal(resolution.type === 'denied' && resolution.source, 'abort');
});

test('interactive tool runtime executes the tool after approval', async () => {
  const events: AgentEvent[] = [];
  const toolDefinition = createRiskyToolDefinition('test_risky_approve');
  agentToolRegistry.set(toolDefinition.name, toolDefinition);

  try {
    const context = createAgentRunContext({
      runId: 'run-interactive-approve',
      approvalMode: 'interactive',
    });
    const executionPromise = executeAgentToolCall(
      createToolCall(toolDefinition.name, 'call-approve'),
      context,
      {
        onEvent: (event) => events.push(event),
      },
    );

    assert.deepEqual(
      listPendingAgentApprovals('run-interactive-approve').map(
        (pending) => pending.toolCallId,
      ),
      ['call-approve'],
    );

    const resolveResult = resolveAgentApproval(
      'run-interactive-approve',
      'call-approve',
      'approve',
    );
    assert.equal(resolveResult.ok, true);

    const execution = await executionPromise;
    assert.equal(execution.isError, false);
    assert.match(execution.modelOutput, /risky tool executed/);

    assert.equal(
      events.some((event) => event.type === 'approval_requested'),
      true,
    );
    const resolvedEvent = events.find(
      (event) => event.type === 'approval_resolved',
    );
    assert.notEqual(resolvedEvent, undefined);
    if (resolvedEvent?.type === 'approval_resolved') {
      assert.equal(resolvedEvent.resolution.type, 'approved');
    }
    assert.equal(
      events.some((event) => event.type === 'tool_started'),
      true,
    );
  } finally {
    agentToolRegistry.delete(toolDefinition.name);
  }
});

test('interactive tool runtime returns a recoverable error after denial', async () => {
  const events: AgentEvent[] = [];
  const toolDefinition = createRiskyToolDefinition('test_risky_deny');
  agentToolRegistry.set(toolDefinition.name, toolDefinition);

  try {
    const context = createAgentRunContext({
      runId: 'run-interactive-deny',
      approvalMode: 'interactive',
    });
    const executionPromise = executeAgentToolCall(
      createToolCall(toolDefinition.name, 'call-deny'),
      context,
      {
        onEvent: (event) => events.push(event),
      },
    );

    const resolveResult = resolveAgentApproval(
      'run-interactive-deny',
      'call-deny',
      'deny',
    );
    assert.equal(resolveResult.ok, true);

    const execution = await executionPromise;
    assert.equal(execution.isError, true);
    assert.match(execution.modelOutput, /APPROVAL_DENIED/);
    assert.doesNotMatch(execution.modelOutput, /risky tool executed/);

    assert.equal(
      events.some((event) => event.type === 'tool_started'),
      false,
    );
    const resolvedEvent = events.find(
      (event) => event.type === 'approval_resolved',
    );
    assert.notEqual(resolvedEvent, undefined);
    if (resolvedEvent?.type === 'approval_resolved') {
      assert.equal(resolvedEvent.resolution.type, 'denied');
    }
  } finally {
    agentToolRegistry.delete(toolDefinition.name);
  }
});

test('interactive tool runtime denies when the run aborts while waiting for approval', async () => {
  const toolDefinition = createRiskyToolDefinition('test_risky_abort');
  agentToolRegistry.set(toolDefinition.name, toolDefinition);
  const controller = new AbortController();

  try {
    const context = createAgentRunContext({
      runId: 'run-interactive-abort',
      approvalMode: 'interactive',
      signal: controller.signal,
    });
    const executionPromise = executeAgentToolCall(
      createToolCall(toolDefinition.name, 'call-abort'),
      context,
    );

    controller.abort();

    const execution = await executionPromise;
    assert.equal(execution.isError, true);
    assert.match(execution.modelOutput, /APPROVAL_DENIED/);
  } finally {
    agentToolRegistry.delete(toolDefinition.name);
  }
});
