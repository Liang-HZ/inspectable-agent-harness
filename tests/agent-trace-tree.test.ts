import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentDebugStreamEvent } from '../lib/agent-api-types';
import {
  buildAgentTraceTree,
  flattenAgentTraceTree,
} from '../lib/agent-trace-tree';

const TRACE = 'a'.repeat(32);

const span = (spanId: string, parentSpanId?: string) => ({
  traceId: TRACE,
  spanId: spanId,
  parentSpanId: parentSpanId,
});

const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 6, 29, 3, 0, seconds)).toISOString();

const timing = (fromSeconds: number, toSeconds: number) => ({
  startedAt: at(fromSeconds),
  endedAt: at(toSeconds),
  durationMs: (toSeconds - fromSeconds) * 1000,
});

const noUsage = { tokenUsage: null, rawUsage: null };

/**
 * A run that reads a file, then delegates to a subagent which greps. Mirrors
 * the shape produced end to end by the runtime.
 */
function nestedRunEvents(): AgentDebugStreamEvent[] {
  return [
    {
      type: 'runStarted',
      runId: 'run-1',
      sessionId: 'session-1',
      resumed: false,
      policy: { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
      spawnDepth: 0,
      span: span('1000000000000001'),
      startedAt: at(0),
    },
    {
      type: 'toolStarted',
      toolCallId: 'call-read',
      toolName: 'read',
      argumentsJson: '{"path":"lib/agent.ts"}',
      span: span('2000000000000002', '1000000000000001'),
      startedAt: at(1),
    },
    {
      type: 'toolFinished',
      toolCallId: 'call-read',
      toolName: 'read',
      input: {},
      result: {},
      modelOutput: 'ok',
      isError: false,
      span: span('2000000000000002', '1000000000000001'),
      timing: timing(1, 2),
    },
    {
      type: 'toolStarted',
      toolCallId: 'call-task',
      toolName: 'task',
      argumentsJson: '{"description":"survey"}',
      span: span('3000000000000003', '1000000000000001'),
      startedAt: at(2),
    },
    // The subagent's own run, arriving on the parent's stream.
    {
      type: 'runStarted',
      runId: 'agent-1',
      sessionId: 'agent-session-1',
      resumed: false,
      policy: { approvalPolicy: 'never', sandboxMode: 'workspace_write' },
      spawnDepth: 1,
      span: span('4000000000000004', '3000000000000003'),
      startedAt: at(2),
    },
    {
      type: 'toolStarted',
      toolCallId: 'call-grep',
      toolName: 'grep',
      argumentsJson: '{"pattern":"test"}',
      span: span('5000000000000005', '4000000000000004'),
      startedAt: at(3),
    },
    {
      type: 'toolFinished',
      toolCallId: 'call-grep',
      toolName: 'grep',
      input: {},
      result: {},
      modelOutput: 'matches',
      isError: false,
      span: span('5000000000000005', '4000000000000004'),
      timing: timing(3, 4),
    },
    {
      type: 'toolFinished',
      toolCallId: 'call-task',
      toolName: 'task',
      input: {},
      result: {},
      modelOutput: 'survey done',
      isError: false,
      subagentSessionId: 'agent-session-1',
      span: span('3000000000000003', '1000000000000001'),
      timing: timing(2, 5),
    },
  ];
}

test('a subagent nests under the task call that spawned it', () => {
  const tree = buildAgentTraceTree(nestedRunEvents());
  const rows = flattenAgentTraceTree(tree);

  assert.deepEqual(
    rows.map((row) => `${'  '.repeat(row.depth)}${row.name}`),
    [
      'agent run',
      '  read',
      '  task',
      '    subagent',
      '      grep',
    ],
  );
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.spanCount, 5);
});

test('the task span records which subagent session it produced', () => {
  const rows = flattenAgentTraceTree(buildAgentTraceTree(nestedRunEvents()));
  const taskRow = rows.find((row) => row.name === 'task');

  assert.equal(taskRow?.subagentSessionId, 'agent-session-1');
  assert.equal(taskRow?.kind, 'tool');
  assert.equal(rows.find((row) => row.name === 'subagent')?.kind, 'subagent');
});

test('durations and the trace window come from span timings', () => {
  const tree = buildAgentTraceTree(nestedRunEvents());
  const rows = flattenAgentTraceTree(tree);

  assert.equal(rows.find((row) => row.name === 'read')?.durationMs, 1000);
  assert.equal(rows.find((row) => row.name === 'task')?.durationMs, 3000);
  // Window spans the earliest start to the latest end: 0s to 5s.
  assert.equal(tree.totalDurationMs, 5000);
});

test('a run span is closed from its children when every child finished', () => {
  // `run_succeeded` projects to a `done` stream event, never to a debug event,
  // so a run span has no closing event of its own. If it were left open, every
  // successful run would render as unfinished and the signal would be useless.
  const tree = buildAgentTraceTree(nestedRunEvents());
  const rows = flattenAgentTraceTree(tree);
  const run = rows.find((row) => row.name === 'agent run');
  const subagent = rows.find((row) => row.name === 'subagent');

  assert.equal(run?.durationMs, 5000);
  assert.equal(subagent?.durationMs, 2000);
  assert.equal(tree.hasOpenSpans, false);
});

test('a container stays open while a descendant is unfinished', () => {
  const events = nestedRunEvents();
  // Drop the grep's completion and the task's: nothing below `task` returned.
  const truncated = events.filter(
    (event) =>
      !(
        event.type === 'toolFinished' &&
        (event.toolName === 'grep' || event.toolName === 'task')
      ),
  );
  const tree = buildAgentTraceTree(truncated);
  const rows = flattenAgentTraceTree(tree);

  assert.equal(rows.find((row) => row.name === 'grep')?.endedAtMs, undefined);
  assert.equal(
    rows.find((row) => row.name === 'subagent')?.endedAtMs,
    undefined,
  );
  assert.equal(rows.find((row) => row.name === 'task')?.endedAtMs, undefined);
  assert.equal(
    rows.find((row) => row.name === 'agent run')?.endedAtMs,
    undefined,
  );
  assert.equal(tree.hasOpenSpans, true);
});

test('a measured end wins over what descendants suggest', () => {
  // `task` carries a real measured duration from its own tool_finished, so it
  // is closed even if something beneath it looks unterminated. Only spans with
  // no end of their own are inferred from their children.
  const truncated = nestedRunEvents().filter(
    (event) => !(event.type === 'toolFinished' && event.toolName === 'grep'),
  );
  const rows = flattenAgentTraceTree(buildAgentTraceTree(truncated));

  assert.equal(rows.find((row) => row.name === 'grep')?.endedAtMs, undefined);
  assert.equal(rows.find((row) => row.name === 'task')?.durationMs, 3000);
});

test('an unfinished span is reported as still open rather than dropped', () => {
  const tree = buildAgentTraceTree([
    {
      type: 'toolStarted',
      toolCallId: 'call-hang',
      toolName: 'shell',
      argumentsJson: '{"command":"sleep 999"}',
      span: span('6000000000000006'),
      startedAt: at(0),
    },
  ]);
  const rows = flattenAgentTraceTree(tree);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.endedAtMs, undefined);
  assert.equal(rows[0]?.durationMs, undefined);
  assert.equal(tree.hasOpenSpans, true);
});

test('a failed tool call is marked as an error', () => {
  const tree = buildAgentTraceTree([
    {
      type: 'toolFinished',
      toolCallId: 'call-bad',
      toolName: 'write',
      input: {},
      result: {},
      modelOutput: 'denied',
      isError: true,
      span: span('7000000000000007'),
      timing: timing(0, 1),
    },
  ]);

  assert.equal(flattenAgentTraceTree(tree)[0]?.isError, true);
});

test('model spans carry token counts when the provider reported them', () => {
  const tree = buildAgentTraceTree([
    {
      type: 'modelRequested',
      round: 1,
      model: 'gpt-4o-mini',
      wireApi: 'openai-chat-completions',
      request: {
        messages: [],
        tools: [],
        toolChoice: 'auto',
        temperature: undefined,
      },
      span: span('8000000000000008'),
      startedAt: at(0),
    },
    {
      type: 'modelCompleted',
      round: 1,
      model: 'gpt-4o-mini',
      streamedAssistantText: 'hi',
      assistantMessages: [],
      toolCalls: [],
      usage: {
        tokenUsage: {
          inputTokens: 120,
          cachedInputTokens: null,
          outputTokens: 30,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        rawUsage: null,
      },
      span: span('8000000000000008'),
      timing: timing(0, 2),
    },
  ]);
  const row = flattenAgentTraceTree(tree)[0];

  assert.equal(row?.kind, 'model');
  assert.equal(row?.durationMs, 2000);
  assert.deepEqual(row?.tokens, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test('events without spans produce an empty tree rather than throwing', () => {
  // A session recorded before tracing existed replays through this same code.
  const tree = buildAgentTraceTree([
    {
      type: 'toolStarted',
      toolCallId: 'call-old',
      toolName: 'read',
      argumentsJson: '{}',
    },
    { type: 'modelStarted', stage: 'tool_or_answer_selection' },
  ]);

  assert.deepEqual(tree.roots, []);
  assert.equal(tree.spanCount, 0);
  assert.equal(tree.totalDurationMs, 0);
});

test('a span whose parent is missing is kept as a root, not dropped', () => {
  // Happens while a subagent's events arrive before its parent's.
  const tree = buildAgentTraceTree([
    {
      type: 'toolStarted',
      toolCallId: 'call-orphan',
      toolName: 'grep',
      argumentsJson: '{}',
      span: span('9000000000000009', 'ffffffffffffffff'),
      startedAt: at(0),
    },
  ]);

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]?.name, 'grep');
});
