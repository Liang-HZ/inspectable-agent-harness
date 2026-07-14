import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { initializeAgentSessionForStream } from '../lib/agent';
import type { AgentInput } from '../lib/agent-input';
import type { AgentResponseItem } from '../lib/agent-response-items';
import { createAgentRunContext } from '../lib/agent-run-context';
import {
  appendAgentResponseItem,
  appendAgentTurnContext,
  createAgentSession,
  type AgentSession,
} from '../lib/agent-session-store';
import type { ModelConfig } from '../lib/env';

const originalInfo = console.info;

const createdSessionPaths: string[] = [];

afterEach(async () => {
  console.info = originalInfo;

  while (createdSessionPaths.length > 0) {
    const path = createdSessionPaths.pop();
    if (path !== undefined) {
      await rm(path, { force: true });
    }
  }
});

const config: ModelConfig = {
  apiKey: 'test-key',
  baseURL: 'https://example.invalid/v1',
  model: 'fake-model',
  wireApi: 'openai-chat-completions',
};

function baseInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    task: 'follow up task',
    goal: undefined,
    context: undefined,
    model: undefined,
    temperature: undefined,
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    sessionId: undefined,
    ...overrides,
  };
}

function createTestSession(): AgentSession {
  console.info = () => {};
  const session = createAgentSession({
    id: `test-session-init-${randomUUID()}`,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: config.model,
    baseURL: config.baseURL,
    wireApi: config.wireApi,
    policy: {
      approvalPolicy: 'never',
      sandboxMode: 'workspace_write',
    },
  });
  createdSessionPaths.push(session.path);

  return session;
}

test('creates a fresh session when no sessionId is given', () => {
  const context = createAgentRunContext({ runId: `run-${randomUUID()}` });
  const input = baseInput();
  const result = initializeAgentSessionForStream(
    input,
    context,
    config,
    'built prompt text',
  );
  createdSessionPaths.push(result.session.path);

  assert.equal(result.resumed, false);
  assert.equal(result.sessionId, context.runId);
  assert.equal(result.session.id, context.runId);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0]?.type, 'message');
  if (result.history[0]?.type === 'message') {
    assert.equal(result.history[0].role, 'system');
  }
  assert.deepEqual(result.history[1], {
    type: 'message',
    role: 'user',
    content: 'built prompt text',
  });
  assert.deepEqual(result.newItemsToPersist, result.history);
});

test('resuming appends only the new user turn to the reconstructed history', () => {
  const priorSession = createTestSession();
  appendAgentTurnContext(priorSession, {
    turnId: priorSession.id,
    model: config.model,
    wireApi: config.wireApi,
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    temperature: undefined,
  });
  const priorItems: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system prompt' },
    { type: 'message', role: 'user', content: 'first task' },
    {
      type: 'message',
      role: 'assistant',
      content: 'first answer',
      runtimeRole: 'final_response',
    },
  ];
  for (const item of priorItems) {
    appendAgentResponseItem(priorSession, item);
  }

  const context = createAgentRunContext({ runId: `run-${randomUUID()}` });
  const input = baseInput({ sessionId: priorSession.id });
  const result = initializeAgentSessionForStream(
    input,
    context,
    config,
    'second task prompt',
  );

  assert.equal(result.resumed, true);
  assert.equal(result.sessionId, priorSession.id);
  assert.equal(result.session.path, priorSession.path);
  assert.deepEqual(result.history, [
    ...priorItems,
    { type: 'message', role: 'user', content: 'second task prompt' },
  ]);
  assert.deepEqual(result.newItemsToPersist, [
    { type: 'message', role: 'user', content: 'second task prompt' },
  ]);
});

test('resuming a session interrupted mid-tool-call persists the synthesized output', () => {
  const priorSession = createTestSession();
  appendAgentTurnContext(priorSession, {
    turnId: priorSession.id,
    model: config.model,
    wireApi: config.wireApi,
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    temperature: undefined,
  });
  appendAgentResponseItem(priorSession, {
    type: 'message',
    role: 'system',
    content: 'system prompt',
  });
  appendAgentResponseItem(priorSession, {
    type: 'message',
    role: 'user',
    content: 'first task',
  });
  appendAgentResponseItem(priorSession, {
    type: 'function_call',
    callId: 'call-interrupted',
    name: 'shell',
    argumentsJson: '{"command":"npm test"}',
  });

  const context = createAgentRunContext({ runId: `run-${randomUUID()}` });
  const input = baseInput({ sessionId: priorSession.id });
  const result = initializeAgentSessionForStream(
    input,
    context,
    config,
    'second task prompt',
  );

  assert.equal(result.resumed, true);
  assert.equal(result.history.length, 5);
  const synthesizedOutput = result.history[3];
  assert.equal(synthesizedOutput?.type, 'function_call_output');
  if (synthesizedOutput?.type === 'function_call_output') {
    assert.equal(synthesizedOutput.callId, 'call-interrupted');
    assert.equal(synthesizedOutput.isError, true);
  }
  assert.deepEqual(result.newItemsToPersist, [
    synthesizedOutput,
    { type: 'message', role: 'user', content: 'second task prompt' },
  ]);
});

test('resuming an unknown sessionId throws a descriptive error', () => {
  const context = createAgentRunContext({ runId: `run-${randomUUID()}` });
  const input = baseInput({ sessionId: 'no-such-session' });

  assert.throws(
    () =>
      initializeAgentSessionForStream(input, context, config, 'prompt text'),
    /Agent session not found: no-such-session/,
  );
});
