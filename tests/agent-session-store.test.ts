import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';

import { applyAgentHistoryCompaction } from '../lib/agent-compaction';
import type { AgentResponseItem } from '../lib/agent-response-items';
import {
  appendAgentResponseItem,
  appendAgentTurnContext,
  createAgentSession,
  listAgentSessionSummaries,
  normalizeAgentResponseItemHistory,
  resumeAgentSession,
  type AgentSession,
} from '../lib/agent-session-store';
import { SANDBOX_READONLY_CARVEOUTS } from '../lib/agent-shell-sandbox';
import { DEFAULT_AGENT_SESSION_ROOT } from '../lib/env';

// Every store call resolves its root through AGENT_SESSION_ROOT, so pointing it
// at a fresh temp directory keeps this file out of the real
// `data/agent-sessions`. Without that, `resumeAgentSession` scans the real
// directory and parses the first line of every transcript there -- including a
// session a live dev-server run is appending to, whose last line is routinely
// half-written. That produced random JSON.parse failures in this suite.
let sessionRoot = '';

before(async () => {
  sessionRoot = await mkdtemp(join(tmpdir(), 'agent-session-store-test-'));
  process.env.AGENT_SESSION_ROOT = sessionRoot;
});

after(async () => {
  delete process.env.AGENT_SESSION_ROOT;
  await rm(sessionRoot, { recursive: true, force: true });
});

function createTestSession(): AgentSession {
  return createAgentSession({
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
}

test('a new session file lands under the configured root, partitioned by UTC date', () => {
  const session = createTestSession();

  const relativePath = relative(sessionRoot, session.path);

  assert.ok(
    !relativePath.startsWith('..'),
    `session escaped the configured root: ${session.path}`,
  );
  assert.match(
    relativePath,
    /^\d{4}[/\\]\d{2}[/\\]\d{2}[/\\]rollout-.+\.jsonl$/,
  );
});

test('listAgentSessionSummaries reads only sessions under the configured root', () => {
  const first = createTestSession();
  const second = createTestSession();

  const ids = listAgentSessionSummaries().map((summary) => summary.id);

  assert.ok(ids.includes(first.id));
  assert.ok(ids.includes(second.id));
  // Nothing from the real session directory leaked into the scan.
  assert.ok(ids.every((id) => id.startsWith('test-session-')));
});

// Relocating the default would move transcripts out of the shell tool's
// read-only carveout, which is what stops the model from rewriting its own
// audit trail. The carveout is a project-relative path, so it cannot follow an
// AGENT_SESSION_ROOT pointed elsewhere -- the default at least must match.
test('the default session root is the path the shell sandbox keeps read-only', () => {
  assert.ok(SANDBOX_READONLY_CARVEOUTS.includes(DEFAULT_AGENT_SESSION_ROOT));
});

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

test('resumeAgentSession replays compaction instead of returning the uncompacted transcript', () => {
  const session = createTestSession();
  appendAgentTurnContext(session, {
    turnId: session.id,
    model: 'fake-model',
    wireApi: 'openai-chat-completions',
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
    temperature: undefined,
  });

  const preCompactionItems: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'long task' },
    {
      type: 'message',
      role: 'assistant',
      content: 'working on it',
      runtimeRole: 'working_message',
    },
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'read',
      argumentsJson: JSON.stringify({ path: 'package.json' }),
    },
    {
      type: 'function_call_output',
      callId: 'call-1',
      toolName: 'read',
      output: 'file contents',
      isError: false,
    },
  ];
  for (const item of preCompactionItems) {
    appendAgentResponseItem(session, item);
  }

  // The live run replaced its in-memory history with the compacted form and
  // persisted only the summary item -- mirror exactly what
  // compactAgentHistoryIfNeeded does.
  const liveCompaction = applyAgentHistoryCompaction(
    preCompactionItems,
    'summary of the long task so far',
  );
  appendAgentResponseItem(session, liveCompaction.summaryItem);

  const postCompactionItem: AgentResponseItem = {
    type: 'message',
    role: 'assistant',
    content: 'continuing after compaction',
    runtimeRole: 'final_response',
  };
  appendAgentResponseItem(session, postCompactionItem);

  const result = resumeAgentSession(session.id);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.history, [
      ...liveCompaction.history,
      postCompactionItem,
    ]);
    // The dropped assistant/tool items must not reappear.
    assert.ok(
      !result.history.some(
        (item) => item.type === 'function_call' || item.type === 'function_call_output',
      ),
    );
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
