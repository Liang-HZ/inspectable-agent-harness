import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAgentHistoryCompaction,
  buildCompactionSummaryRequest,
  decideAgentHistoryCompaction,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  serializeAgentHistoryForSummaryPrompt,
} from '../lib/agent-compaction';
import type { AgentResponseItem } from '../lib/agent-response-items';

function createEmptyTokenUsage(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: null,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: totalTokens,
  };
}

const longHistory: AgentResponseItem[] = [
  { type: 'message', role: 'system', content: 'system prompt' },
  { type: 'message', role: 'user', content: 'first task' },
  {
    type: 'function_call',
    callId: 'call-1',
    name: 'read',
    argumentsJson: '{"path":"a.ts"}',
  },
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
    content: 'working on it',
    runtimeRole: 'working_message',
  },
];

test('decideAgentHistoryCompaction skips when token usage is unavailable', () => {
  const decision = decideAgentHistoryCompaction(
    null,
    longHistory,
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  );

  assert.equal(decision.shouldCompact, false);
});

test('decideAgentHistoryCompaction skips when below the threshold', () => {
  const decision = decideAgentHistoryCompaction(
    createEmptyTokenUsage(100),
    longHistory,
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  );

  assert.equal(decision.shouldCompact, false);
});

test('decideAgentHistoryCompaction skips when history is too short to bother', () => {
  const decision = decideAgentHistoryCompaction(
    createEmptyTokenUsage(50_000),
    [{ type: 'message', role: 'system', content: 'system' }],
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  );

  assert.equal(decision.shouldCompact, false);
});

test('decideAgentHistoryCompaction triggers once usage reaches the threshold on a real history', () => {
  const decision = decideAgentHistoryCompaction(
    createEmptyTokenUsage(DEFAULT_COMPACTION_TOKEN_THRESHOLD),
    longHistory,
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  );

  assert.equal(decision.shouldCompact, true);
  if (decision.shouldCompact) {
    assert.match(decision.reason, /reached the compaction threshold/);
    assert.equal(decision.tokenUsage.totalTokens, DEFAULT_COMPACTION_TOKEN_THRESHOLD);
  }
});

test('serializeAgentHistoryForSummaryPrompt renders every item kind readably', () => {
  const text = serializeAgentHistoryForSummaryPrompt(longHistory);

  assert.match(text, /\[system\] system prompt/);
  assert.match(text, /\[user\] first task/);
  assert.match(text, /\[tool call read\]/);
  assert.match(text, /\[tool result read\] file contents/);
  assert.match(text, /\[assistant\] working on it/);
});

test('buildCompactionSummaryRequest asks for a summary with no tools', () => {
  const request = buildCompactionSummaryRequest(longHistory);

  assert.equal(request.tools.length, 0);
  assert.equal(request.toolChoice, 'none');
  assert.equal(request.messages[0]?.role, 'system');
  assert.equal(request.messages[1]?.role, 'user');
  assert.match(String(request.messages[1]?.content), /first task/);
});

test('applyAgentHistoryCompaction keeps the leading system message and the summary', () => {
  const result = applyAgentHistoryCompaction(longHistory, 'concise summary text');

  assert.equal(result.history.length, 3);
  assert.deepEqual(result.history[0], {
    type: 'message',
    role: 'system',
    content: 'system prompt',
  });
  assert.equal(result.history[1]?.type, 'compaction_summary');
  if (result.history[1]?.type === 'compaction_summary') {
    assert.equal(result.history[1].content, 'concise summary text');
  }
  assert.deepEqual(result.history[2], {
    type: 'message',
    role: 'user',
    content: 'first task',
  });
  assert.equal(result.summaryItem.type, 'compaction_summary');
  assert.equal(result.keptItemCount, 3);
  assert.equal(result.removedItemCount, longHistory.length - 3);
});

test('applyAgentHistoryCompaction never leaves an orphan function_call behind', () => {
  const result = applyAgentHistoryCompaction(longHistory, 'summary');

  assert.equal(
    result.history.some((item) => item.type === 'function_call'),
    false,
  );
  assert.equal(
    result.history.some((item) => item.type === 'function_call_output'),
    false,
  );
});

test('applyAgentHistoryCompaction always keeps the most recent user message even if it alone exceeds the budget', () => {
  const oversizedHistory: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'x'.repeat(30_000) },
  ];

  const result = applyAgentHistoryCompaction(oversizedHistory, 'summary');

  const keptUser = result.history.find(
    (item) => item.type === 'message' && item.role === 'user',
  );
  assert.notEqual(keptUser, undefined);
});

test('applyAgentHistoryCompaction drops older user messages once the char budget is exceeded', () => {
  const manyUserMessages: AgentResponseItem[] = [
    { type: 'message', role: 'system', content: 'system' },
    { type: 'message', role: 'user', content: 'oldest'.repeat(4000) },
    { type: 'message', role: 'user', content: 'newest' },
  ];

  const result = applyAgentHistoryCompaction(manyUserMessages, 'summary');

  const keptUserMessages = result.history.filter(
    (item) => item.type === 'message' && item.role === 'user',
  );
  assert.equal(keptUserMessages.length, 1);
  assert.deepEqual(keptUserMessages[0], {
    type: 'message',
    role: 'user',
    content: 'newest',
  });
});

test('applyAgentHistoryCompaction handles a history without a leading system message', () => {
  const historyWithoutSystem: AgentResponseItem[] = [
    { type: 'message', role: 'user', content: 'hello' },
    {
      type: 'message',
      role: 'assistant',
      content: 'hi',
      runtimeRole: 'final_response',
    },
  ];

  const result = applyAgentHistoryCompaction(historyWithoutSystem, 'summary');

  assert.equal(result.history[0]?.type, 'compaction_summary');
});
