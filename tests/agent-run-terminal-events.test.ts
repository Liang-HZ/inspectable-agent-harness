import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';

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

// `runAgentStream` opens a real session file, so this file writes under a temp
// AGENT_SESSION_ROOT and drops the whole directory afterwards. It used to scan
// the real `data/agent-sessions` with a recursive readdir and delete its own
// run's files back out of it -- reading and writing the very directory a live
// dev-server run is appending to. See `agent-session-store.test.ts`.
let sessionRoot = '';

before(async () => {
  sessionRoot = await mkdtemp(
    path.join(os.tmpdir(), 'agent-terminal-events-test-'),
  );
  process.env.AGENT_SESSION_ROOT = sessionRoot;
});

after(async () => {
  delete process.env.AGENT_SESSION_ROOT;
  await rm(sessionRoot, { recursive: true, force: true });
});

test('an aborted run emits run_cancelled as its terminal event', async () => {
  const runId = `run-cancelled-${randomUUID()}`;
  const abortController = new AbortController();
  abortController.abort();
  const events: AgentEvent[] = [];

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
});

test('a failed run emits run_failed as its terminal event', async () => {
  const runId = `run-failed-${randomUUID()}`;
  const events: AgentEvent[] = [];

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
});
