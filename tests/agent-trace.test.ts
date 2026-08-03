import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentEvent } from '../lib/agent-events';
import { projectAgentEventToStreamEvent } from '../lib/agent-stream-projection';
import {
  createChildSpanContext,
  createRootSpanContext,
  createSpanTiming,
  createSpanId,
  createTraceId,
} from '../lib/agent-trace';

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

test('trace and span ids use the OpenTelemetry wire shapes', () => {
  // 16 and 8 bytes hex-encoded. Getting this wrong is cheap to fix now and
  // expensive later: OTLP rejects ids of any other width, so an export path
  // would need an id-space migration rather than a field rename.
  assert.match(createTraceId(), TRACE_ID_PATTERN);
  assert.match(createSpanId(), SPAN_ID_PATTERN);
});

test('ids are not reused across calls', () => {
  const traceIds = new Set(
    Array.from({ length: 64 }, () => createTraceId()),
  );
  const spanIds = new Set(Array.from({ length: 64 }, () => createSpanId()));

  assert.equal(traceIds.size, 64);
  assert.equal(spanIds.size, 64);
});

test('a root span starts a new trace and has no parent', () => {
  const root = createRootSpanContext();

  assert.match(root.traceId, TRACE_ID_PATTERN);
  assert.match(root.spanId, SPAN_ID_PATTERN);
  assert.equal(root.parentSpanId, undefined);
});

test('a child span inherits the trace and points at its parent', () => {
  const root = createRootSpanContext();
  const child = createChildSpanContext(root);

  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.notEqual(child.spanId, root.spanId);
});

test('a grandchild stays in the same trace as its root', () => {
  // This is the subagent case: a derived run lives in its own session file but
  // must land in the same waterfall as the run that spawned it.
  const root = createRootSpanContext();
  const toolSpan = createChildSpanContext(root);
  const subagentSpan = createChildSpanContext(toolSpan);

  assert.equal(subagentSpan.traceId, root.traceId);
  assert.equal(subagentSpan.parentSpanId, toolSpan.spanId);
});

test('span timing reports both ends and the elapsed milliseconds', () => {
  const timing = createSpanTiming(1_700_000_000_000, 1_700_000_001_250);

  assert.equal(timing.startedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(timing.endedAt, '2023-11-14T22:13:21.250Z');
  assert.equal(timing.durationMs, 1250);
});

test('projection carries span fields through to the browser', () => {
  const span = createRootSpanContext();
  const event: AgentEvent = {
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'read',
    argumentsJson: '{}',
    span: span,
    startedAt: '2026-07-29T02:00:00.000Z',
  };

  assert.deepEqual(projectAgentEventToStreamEvent(event), {
    type: 'debug',
    event: {
      type: 'toolStarted',
      toolCallId: 'call-1',
      toolName: 'read',
      argumentsJson: '{}',
      span: span,
      startedAt: '2026-07-29T02:00:00.000Z',
    },
  });
});

test('projection omits span keys entirely for pre-tracing events', () => {
  // Sessions recorded before tracing existed must project to exactly the shape
  // they projected to before, with no `span: undefined` key appearing — every
  // downstream consumer would otherwise have to learn to ignore it.
  const event: AgentEvent = {
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'read',
    argumentsJson: '{}',
  };

  const projected = projectAgentEventToStreamEvent(event);

  assert.deepEqual(projected, {
    type: 'debug',
    event: {
      type: 'toolStarted',
      toolCallId: 'call-1',
      toolName: 'read',
      argumentsJson: '{}',
    },
  });
  assert.equal(
    projected !== undefined &&
      projected.type === 'debug' &&
      'span' in projected.event,
    false,
  );
});
