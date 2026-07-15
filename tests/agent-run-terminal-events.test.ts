import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { runAgentStream } from '../lib/agent';
import type { AgentEvent } from '../lib/agent-events';
import type { AgentInput } from '../lib/agent-input';
import type { ModelConfig } from '../lib/env';

const baseInput: AgentInput = {
  task: 'terminal event test task',
  goal: undefined,
  context: undefined,
  model: undefined,
  temperature: undefined,
  approvalPolicy: 'never',
  sandboxMode: 'read_only',
};

// 127.0.0.1:1 refuses connections immediately, so a `run_failed` test does
// not depend on DNS or the network.
const unreachableConfig: ModelConfig = {
  apiKey: 'test-key',
  baseURL: 'http://127.0.0.1:1/v1',
  model: 'fake-model',
  wireApi: 'openai-chat-completions',
};

const originalInfo = console.info;
const originalError = console.error;

beforeEach(() => {
  console.info = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.info = originalInfo;
  console.error = originalError;
});

async function removeSessionFilesForRun(runId: string): Promise<void> {
  const sessionsRoot = path.join(process.cwd(), 'data', 'agent-sessions');

  let entries;
  try {
    entries = await readdir(sessionsRoot, { recursive: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.includes(runId) && entry.endsWith('.jsonl')) {
      await rm(path.join(sessionsRoot, entry), { force: true });
    }
  }
}

test('an aborted run emits run_cancelled as its terminal event', async () => {
  const runId = `run-cancelled-${randomUUID()}`;
  const abortController = new AbortController();
  abortController.abort();
  const events: AgentEvent[] = [];

  try {
    await assert.rejects(
      runAgentStream(
        baseInput,
        unreachableConfig,
        {
          runId: runId,
          signal: abortController.signal,
          approvalMode: 'interactive',
        },
        {
          onEvent: (event) => events.push(event),
          onDebugEvent: () => {},
        },
      ),
    );

    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes('run_started'));
    assert.equal(eventTypes[eventTypes.length - 1], 'run_cancelled');
  } finally {
    await removeSessionFilesForRun(runId);
  }
});

test('a failed run emits run_failed as its terminal event', async () => {
  const runId = `run-failed-${randomUUID()}`;
  const events: AgentEvent[] = [];

  try {
    await assert.rejects(
      runAgentStream(
        baseInput,
        unreachableConfig,
        {
          runId: runId,
          approvalMode: 'interactive',
        },
        {
          onEvent: (event) => events.push(event),
          onDebugEvent: () => {},
        },
      ),
    );

    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes('run_started'));
    assert.equal(eventTypes[eventTypes.length - 1], 'run_failed');

    const terminalEvent = events[events.length - 1];
    assert.equal(terminalEvent?.type, 'run_failed');
    if (terminalEvent?.type === 'run_failed') {
      assert.notEqual(terminalEvent.error, '');
    }
  } finally {
    await removeSessionFilesForRun(runId);
  }
});
