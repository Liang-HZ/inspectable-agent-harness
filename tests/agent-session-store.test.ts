import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import type { AgentResponseItem } from '../lib/agent-response-items';
import {
  appendAgentResponseItem,
  appendAgentTurnContext,
  createAgentSession,
  normalizeAgentResponseItemHistory,
  resumeAgentSession,
  type AgentSession,
} from '../lib/agent-session-store';

const createdSessionPaths: string[] = [];

afterEach(async () => {
  while (createdSessionPaths.length > 0) {
    const path = createdSessionPaths.pop();
    if (path !== undefined) {
      await rm(path, { force: true });
    }
  }
});

function createTestSession(): AgentSession {
  const session = createAgentSession({
    id: `test-session-${randomUUID()}`,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: 'fake-model',
    baseURL: 'https://example.invalid/v1',
    wireApi: 'openai-chat-completions',
    policy: {
      approvalPolicy: 'never',
      sandboxMode: 'workspace_write',
    },
  });
  createdSessionPaths.push(session.path);

  return session;
}

test('normalizeAgentResponseItemHistory leaves a fully paired history unchanged', () => {
  const items: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'function_call', callId: 'call-1', name: 'read', argumentsJson: '{}' },
    {
      type: 'function_call_output',
      callId: 'call-1',
      toolName: 'read',
      output: 'file contents',
      isError: false,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'done',
      runtimeRole: 'final_response',
    },
  ];

  const normalized = normalizeAgentResponseItemHistory(items);

  assert.deepEqual(normalized.history, items);
  assert.deepEqual(normalized.synthesizedItems, []);
});

test('normalizeAgentResponseItemHistory synthesizes output for an orphan function_call', () => {
  const items: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'function_call', callId: 'call-1', name: 'shell', argumentsJson: '{}' },
  ];

  const normalized = normalizeAgentResponseItemHistory(items);

  assert.equal(normalized.history.length, 4);
  const synthesized = normalized.history[3];
  assert.equal(synthesized?.type, 'function_call_output');
  if (synthesized?.type === 'function_call_output') {
    assert.equal(synthesized.callId, 'call-1');
    assert.equal(synthesized.toolName, 'shell');
    assert.equal(synthesized.isError, true);
    assert.match(synthesized.output, /SESSION_RESUME_INTERRUPTED/);
  }
  assert.deepEqual(normalized.synthesizedItems, [synthesized]);
});

test('normalizeAgentResponseItemHistory handles multiple calls with mixed pairing', () => {
  const items: AgentResponseItem[] = [
    { type: 'function_call', callId: 'call-1', name: 'read', argumentsJson: '{}' },
    {
      type: 'function_call_output',
      callId: 'call-1',
      toolName: 'read',
      output: 'ok',
      isError: false,
    },
    { type: 'function_call', callId: 'call-2', name: 'shell', argumentsJson: '{}' },
  ];

  const normalized = normalizeAgentResponseItemHistory(items);

  assert.equal(normalized.synthesizedItems.length, 1);
  assert.equal(normalized.synthesizedItems[0]?.type, 'function_call_output');
  if (normalized.synthesizedItems[0]?.type === 'function_call_output') {
    assert.equal(normalized.synthesizedItems[0].callId, 'call-2');
  }
  assert.equal(normalized.history.length, 4);
});

test('resumeAgentSession reports failure for an unknown session id', () => {
  const result = resumeAgentSession('session-that-does-not-exist');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /not found/);
  }
});

test('resumeAgentSession reports failure for a session with no response history', () => {
  const session = createTestSession();

  const result = resumeAgentSession(session.id);

  assert.equal(result.ok, false);
});

test('resumeAgentSession reconstructs a clean prior turn', () => {
  const session = createTestSession();
  appendAgentTurnContext(session, {
    turnId: session.id,
    model: 'fake-model',
    wireApi: 'openai-chat-completions',
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    temperature: undefined,
  });
  const items: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'first task' },
    {
      type: 'message',
      role: 'assistant',
      content: 'first answer',
      runtimeRole: 'final_response',
    },
  ];
  for (const item of items) {
    appendAgentResponseItem(session, item);
  }

  const result = resumeAgentSession(session.id);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.session.id, session.id);
    assert.equal(result.session.path, session.path);
    assert.deepEqual(result.history, items);
    assert.deepEqual(result.synthesizedItems, []);
  }
});

test('resumeAgentSession normalizes a session interrupted mid-tool-call', () => {
  const session = createTestSession();
  appendAgentTurnContext(session, {
    turnId: session.id,
    model: 'fake-model',
    wireApi: 'openai-chat-completions',
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    temperature: undefined,
  });
  appendAgentResponseItem(session, {
    type: 'message',
    role: 'system',
    content: 'system',
  });
  appendAgentResponseItem(session, {
    type: 'message',
    role: 'user',
    content: 'run the tests',
  });
  appendAgentResponseItem(session, {
    type: 'function_call',
    callId: 'call-interrupted',
    name: 'shell',
    argumentsJson: JSON.stringify({ command: 'npm test' }),
  });
  // Simulate a crash: no function_call_output was ever appended for call-interrupted.

  const result = resumeAgentSession(session.id);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.history.length, 4);
    assert.equal(result.synthesizedItems.length, 1);
    const lastItem = result.history[3];
    assert.equal(lastItem?.type, 'function_call_output');
    if (lastItem?.type === 'function_call_output') {
      assert.equal(lastItem.callId, 'call-interrupted');
      assert.equal(lastItem.isError, true);
    }
  }
});
