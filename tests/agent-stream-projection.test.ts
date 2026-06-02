import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentEvent } from '../lib/agent-events';
import { projectAgentEventToStreamEvent } from '../lib/agent-stream-projection';

test('projects model requests into debug stream events', () => {
  const event: AgentEvent = {
    type: 'model_requested',
    round: 2,
    model: 'fake-model',
    wireApi: 'openai-responses',
    request: {
      messages: [
        {
          role: 'user',
          content: 'hello',
        },
      ],
      tools: [],
      toolChoice: 'auto',
      temperature: 0.2,
    },
  };

  assert.deepEqual(projectAgentEventToStreamEvent(event), {
    type: 'debug',
    event: {
      type: 'modelRequested',
      round: 2,
      model: 'fake-model',
      wireApi: 'openai-responses',
      request: event.request,
    },
  });
});

test('projects model completed output into debug stream events', () => {
  const usage = {
    tokenUsage: null,
    rawUsage: null,
  };
  const event: AgentEvent = {
    type: 'model_completed',
    round: 1,
    model: 'fake-model',
    streamedAssistantText: '',
    assistantMessages: [],
    toolCalls: [
      {
        id: 'call-1',
        name: 'read',
        argumentsJson: '{"path":"README.md"}',
      },
    ],
    usage: usage,
  };

  assert.deepEqual(projectAgentEventToStreamEvent(event), {
    type: 'debug',
    event: {
      type: 'modelCompleted',
      round: 1,
      model: 'fake-model',
      streamedAssistantText: '',
      assistantMessages: [],
      toolCalls: event.toolCalls,
      usage: usage,
    },
  });
});

test('projects tool finished events with model-visible output', () => {
  const event: AgentEvent = {
    type: 'tool_finished',
    toolCallId: 'call-1',
    toolName: 'read',
    input: { path: 'README.md' },
    result: {
      type: 'success',
      contentText: 'File: README.md',
    },
    modelOutput: 'File: README.md',
    isError: false,
  };

  assert.deepEqual(projectAgentEventToStreamEvent(event), {
    type: 'debug',
    event: {
      type: 'toolFinished',
      toolCallId: 'call-1',
      toolName: 'read',
      input: event.input,
      result: event.result,
      modelOutput: 'File: README.md',
      isError: false,
    },
  });
});
