import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSpansForSession } from '../lib/agent-otel-export';
import type { AgentSessionRecord } from '../lib/agent-session-store';
import { createRootSpanContext } from '../lib/agent-trace';

function writeSession(records: AgentSessionRecord[]): {
  path: string;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'agent-otel-export-'));
  const path = join(directory, 'rollout-test.jsonl');

  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    { encoding: 'utf8' },
  );

  return {
    path: path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function attributeKeys(span: { attributes: { key: string }[] }): string[] {
  return span.attributes.map((attribute) => attribute.key);
}

test('a cancelled run closes its root span instead of looking unterminated', () => {
  // `run_cancelled` is a terminal event just like success and failure. If the
  // exporter ignores it, the root span falls through to the leftover-spans
  // sweep and gets tagged `agent.span_unterminated` — which is reserved for
  // spans whose fate is genuinely unknown. A deliberate stop must not be
  // reported as a disappearance.
  const span = createRootSpanContext();
  const session = writeSession([
    {
      timestamp: '2026-08-03T00:00:00.000Z',
      type: 'agent_event',
      payload: {
        type: 'run_started',
        runId: 'run-cancelled-1',
        sessionId: 'session-cancelled-1',
        resumed: false,
        policy: { approvalPolicy: 'on_request', sandboxMode: 'read_only' },
        span: span,
        spawnDepth: 0,
        startedAt: '2026-08-03T00:00:00.000Z',
      },
    },
    {
      timestamp: '2026-08-03T00:00:05.000Z',
      type: 'agent_event',
      payload: {
        type: 'run_cancelled',
        reason: 'Approval denied by user.',
      },
    },
  ]);

  try {
    const spans = buildSpansForSession(session.path);
    const root = spans.find((candidate) => candidate.spanId === span.spanId);

    assert.ok(root !== undefined, 'the run span should be exported');
    assert.equal(root.endedAt, '2026-08-03T00:00:05.000Z');
    assert.ok(
      !attributeKeys(root).includes('agent.span_unterminated'),
      'a cancelled run is terminated, just not successfully',
    );
    assert.ok(attributeKeys(root).includes('agent.run_cancelled'));
    assert.ok(attributeKeys(root).includes('agent.cancel_reason'));
  } finally {
    session.cleanup();
  }
});

test('a run that never reported an outcome is still marked unterminated', () => {
  // The counterpart: a crash leaves no terminal event at all, and that must
  // keep showing up as unterminated. Fixing the cancellation case is only
  // correct if it does not blunt this one.
  const span = createRootSpanContext();
  const session = writeSession([
    {
      timestamp: '2026-08-03T00:00:00.000Z',
      type: 'agent_event',
      payload: {
        type: 'run_started',
        runId: 'run-crashed-1',
        sessionId: 'session-crashed-1',
        resumed: false,
        policy: { approvalPolicy: 'on_request', sandboxMode: 'read_only' },
        span: span,
        spawnDepth: 0,
        startedAt: '2026-08-03T00:00:00.000Z',
      },
    },
  ]);

  try {
    const spans = buildSpansForSession(session.path);
    const root = spans.find((candidate) => candidate.spanId === span.spanId);

    assert.ok(root !== undefined);
    assert.ok(attributeKeys(root).includes('agent.span_unterminated'));
  } finally {
    session.cleanup();
  }
});
