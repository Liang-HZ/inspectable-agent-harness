import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../lib/agent-model-types';
import {
  fromAnthropicMessagesResponse,
  mapAnthropicStream,
  normalizeAnthropicUsage,
  toAnthropicMessagesRequest,
  type AnthropicStreamEvent,
} from '../lib/anthropic-messages-mapping';

const baseRequest = (
  overrides: Partial<AgentModelRequest> = {},
): AgentModelRequest => ({
  messages: [],
  tools: [],
  toolChoice: 'auto',
  temperature: undefined,
  ...overrides,
});

test('system messages become the top-level system parameter, not a message', () => {
  const request = toAnthropicMessagesRequest('claude-x', baseRequest({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
  }));

  assert.equal(request.system, 'You are helpful.');
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0]?.role, 'user');
  assert.deepEqual(request.messages[0]?.content, [
    { type: 'text', text: 'hi' },
  ]);
  assert.equal(request.max_tokens, 4096);
});

test('assistant tool calls become tool_use blocks with parsed input', () => {
  const request = toAnthropicMessagesRequest('claude-x', baseRequest({
    messages: [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: 'let me look',
        toolCalls: [
          {
            id: 'call-1',
            name: 'read',
            argumentsJson: JSON.stringify({ path: 'package.json' }),
          },
        ],
      },
    ],
  }));

  const assistant = request.messages[1];
  assert.equal(assistant?.role, 'assistant');
  assert.deepEqual(assistant?.content, [
    { type: 'text', text: 'let me look' },
    {
      type: 'tool_use',
      id: 'call-1',
      name: 'read',
      input: { path: 'package.json' },
    },
  ]);
});

test('tool results become tool_result blocks and merge into one user turn', () => {
  const request = toAnthropicMessagesRequest('claude-x', baseRequest({
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'read', argumentsJson: '{}' },
          { id: 'call-2', name: 'ls', argumentsJson: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: 'file contents' },
      { role: 'tool', toolCallId: 'call-2', content: 'dir listing' },
    ],
  }));

  // Two tool messages must collapse into a single user message (Anthropic
  // rejects consecutive same-role messages).
  const userTurn = request.messages[1];
  assert.equal(userTurn?.role, 'user');
  assert.deepEqual(userTurn?.content, [
    { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' },
    { type: 'tool_result', tool_use_id: 'call-2', content: 'dir listing' },
  ]);
  assert.equal(request.messages.length, 2);
});

test('tools translate to input_schema and tool_choice; none omits tools', () => {
  const withTools = toAnthropicMessagesRequest('claude-x', baseRequest({
    tools: [
      {
        name: 'read',
        description: 'read a file',
        inputSchema: { type: 'object', properties: {} },
        schemaStrict: true,
      },
    ],
  }));

  assert.deepEqual(withTools.tools, [
    {
      name: 'read',
      description: 'read a file',
      input_schema: { type: 'object', properties: {} },
    },
  ]);
  assert.deepEqual(withTools.tool_choice, { type: 'auto' });

  const noneChoice = toAnthropicMessagesRequest('claude-x', baseRequest({
    tools: [
      {
        name: 'read',
        description: 'read a file',
        inputSchema: {},
        schemaStrict: false,
      },
    ],
    toolChoice: 'none',
  }));

  assert.equal(noneChoice.tools, undefined);
  assert.equal(noneChoice.tool_choice, undefined);
});

test('temperature is forwarded only when set', () => {
  assert.equal(
    toAnthropicMessagesRequest('m', baseRequest()).temperature,
    undefined,
  );
  assert.equal(
    toAnthropicMessagesRequest('m', baseRequest({ temperature: 0 }))
      .temperature,
    0,
  );
});

test('non-streaming response reads text and tool_use blocks', () => {
  const response = fromAnthropicMessagesResponse({
    model: 'claude-x',
    content: [
      { type: 'text', text: 'Here is the answer.' },
      {
        type: 'tool_use',
        id: 'call-9',
        name: 'grep',
        input: { pattern: 'agent' },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
  });

  assert.equal(response.model, 'claude-x');
  assert.equal(response.text, 'Here is the answer.');
  assert.deepEqual(response.toolCalls, [
    { id: 'call-9', name: 'grep', argumentsJson: '{"pattern":"agent"}' },
  ]);
  assert.deepEqual(response.usage.tokenUsage, {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 15,
  });
});

test('usage normalization reports null cache when the field is absent', () => {
  const usage = normalizeAnthropicUsage({ input_tokens: 8, output_tokens: 2 });
  assert.equal(usage?.cachedInputTokens, null);
  assert.equal(usage?.totalTokens, 10);
  assert.equal(normalizeAnthropicUsage(null), null);
});

async function collectStream(
  events: AnthropicStreamEvent[],
): Promise<AgentModelStreamEvent[]> {
  const source = (async function* () {
    for (const event of events) {
      yield event;
    }
  })();

  const collected: AgentModelStreamEvent[] = [];
  for await (const event of mapAnthropicStream(source, 'fallback-model')) {
    collected.push(event);
  }
  return collected;
}

test('streaming maps text deltas, a tool call, and final usage', async () => {
  const events = await collectStream([
    { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'read' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', usage: { input_tokens: 12, output_tokens: 7 } },
    { type: 'message_stop' },
  ]);

  const textDeltas = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e.type === 'text_delta' ? e.delta : ''));
  assert.deepEqual(textDeltas, ['Look', 'ing']);

  const done = events.find((e) => e.type === 'assistant_message_done');
  assert.equal(done?.type === 'assistant_message_done' && done.message.text, 'Looking');

  const committed = events.find((e) => e.type === 'tool_call_committed');
  assert.ok(committed?.type === 'tool_call_committed');
  if (committed?.type === 'tool_call_committed') {
    assert.deepEqual(committed.toolCall, {
      id: 'call-1',
      name: 'read',
      argumentsJson: '{"path":"a.ts"}',
    });
  }

  const completed = events.at(-1);
  assert.equal(completed?.type, 'completed');
  if (completed?.type === 'completed') {
    assert.equal(completed.model, 'claude-x');
    assert.deepEqual(completed.usage.tokenUsage, {
      inputTokens: 12,
      cachedInputTokens: null,
      outputTokens: 7,
      reasoningOutputTokens: 0,
      totalTokens: 19,
    });
  }
});

test('streaming emits assistant_message_done before tool_call_committed', async () => {
  const events = await collectStream([
    { type: 'message_start', message: { model: 'claude-x' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'ls' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);

  const doneIndex = events.findIndex((e) => e.type === 'assistant_message_done');
  const committedIndex = events.findIndex((e) => e.type === 'tool_call_committed');
  assert.ok(doneIndex >= 0 && committedIndex >= 0);
  assert.ok(doneIndex < committedIndex, 'assistant_message_done must precede tool_call_committed');
});
