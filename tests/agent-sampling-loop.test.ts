import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AgentModelCallUsage, AgentStep } from '../lib/agent-api-types';
import { runSamplingLoop } from '../lib/agent';
import type { AgentInput } from '../lib/agent-input';
import type { AgentModelStreamEvent } from '../lib/agent-model-types';
import type { AgentModelGateway } from '../lib/model-gateway';
import type { AgentResponseItem } from '../lib/agent-response-items';
import type { AgentEvent } from '../lib/agent-events';
import { createAgentRunContext } from '../lib/agent-run-context';

const usage = {
  tokenUsage: null,
  rawUsage: null,
};

const baseInput: AgentInput = {
  task: 'test task',
  goal: undefined,
  context: undefined,
  model: undefined,
  temperature: undefined,
};

const initialHistory = (): AgentResponseItem[] => [
  {
    type: 'message',
    role: 'system',
    content: 'system',
  },
  {
    type: 'message',
    role: 'user',
    content: 'user',
  },
];

function createFakeGateway(
  rounds: AgentModelStreamEvent[][],
): AgentModelGateway {
  const pendingRounds = rounds.map((round) => [...round]);

  return {
    model: 'fake-model',
    wireApi: 'openai-responses',
    capabilities: {
      tools: true,
      streaming: true,
      streamingUsage: true,
      parallelToolCalls: true,
    },

    async createResponse() {
      throw new Error(
        'createResponse should not be used by sampling-loop tests.',
      );
    },

    async streamResponse() {
      const round = pendingRounds.shift();
      if (round === undefined) {
        throw new Error(
          'Fake gateway received more sampling rounds than expected.',
        );
      }

      return (async function* streamRound() {
        for (const event of round) {
          yield event;
        }
      })();
    },
  };
}

async function runLoopWithFakeGateway(rounds: AgentModelStreamEvent[][]) {
  const context = createAgentRunContext({ runId: 'test-run' });
  const history = initialHistory();
  const steps: AgentStep[] = [];
  const events: AgentEvent[] = [];
  const modelCallUsages: AgentModelCallUsage[] = [];
  const result = await runSamplingLoop(
    createFakeGateway(rounds),
    baseInput,
    context,
    history,
    steps,
    modelCallUsages,
    undefined,
    (event) => events.push(event),
  );

  return {
    result: result,
    history: history,
    steps: steps,
    events: events,
    modelCallUsages: modelCallUsages,
  };
}

const originalInfo = console.info;

beforeEach(() => {
  console.info = () => {};
});

afterEach(() => {
  console.info = originalInfo;
});

test('uses a no-tool assistant message as the final response', async () => {
  const output = await runLoopWithFakeGateway([
    [
      { type: 'text_delta', delta: 'Final ' },
      { type: 'text_delta', delta: 'answer.' },
      {
        type: 'assistant_message_done',
        message: { text: 'Final answer.', providerPhase: null },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
  ]);

  assert.equal(output.result.answer, 'Final answer.');
  assert.equal(output.result.usedTool, false);
  assert.deepEqual(output.history.slice(2), [
    {
      type: 'message',
      role: 'assistant',
      content: 'Final answer.',
      providerPhase: null,
      runtimeRole: 'final_response',
    },
  ]);
  assert.deepEqual(
    output.events
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => event.delta),
    ['Final ', 'answer.'],
  );
});

test('records working message, function call, tool output, and final response', async () => {
  const output = await runLoopWithFakeGateway([
    [
      { type: 'text_delta', delta: 'Checking text.' },
      {
        type: 'assistant_message_done',
        message: { text: 'Checking text.', providerPhase: null },
      },
      {
        type: 'tool_call_delta',
        index: 0,
        itemId: 'item-1',
        toolCallId: undefined,
        name: undefined,
        delta: '{"text":"hello world"}',
      },
      {
        type: 'tool_call_committed',
        toolCall: {
          id: 'call-1',
          name: 'inspect_text',
          argumentsJson: JSON.stringify({ text: 'hello world' }),
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
    [
      { type: 'text_delta', delta: 'The text has 11 characters.' },
      {
        type: 'assistant_message_done',
        message: {
          text: 'The text has 11 characters.',
          providerPhase: null,
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
  ]);

  assert.equal(output.result.answer, 'The text has 11 characters.');
  assert.equal(output.result.usedTool, true);
  assert.equal(output.steps.length, 1);
  assert.equal(output.steps[0].title, 'Run local tool');

  const responseItems = output.history.slice(2);
  assert.equal(responseItems.length, 4);
  assert.deepEqual(responseItems[0], {
    type: 'message',
    role: 'assistant',
    content: 'Checking text.',
    providerPhase: null,
    runtimeRole: 'working_message',
  });
  assert.deepEqual(responseItems[1], {
    type: 'function_call',
    callId: 'call-1',
    name: 'inspect_text',
    argumentsJson: JSON.stringify({ text: 'hello world' }),
  });
  assert.deepEqual(responseItems[2], {
    type: 'function_call_output',
    callId: 'call-1',
    toolName: 'inspect_text',
    output: {
      characterCount: 11,
      lineCount: 1,
      wordCount: 2,
      preview: 'hello world',
    },
    isError: false,
  });
  assert.deepEqual(responseItems[3], {
    type: 'message',
    role: 'assistant',
    content: 'The text has 11 characters.',
    providerPhase: null,
    runtimeRole: 'final_response',
  });
});

test('rejects streamed text without an assistant message commit', async () => {
  await assert.rejects(
    () =>
      runLoopWithFakeGateway([
        [
          { type: 'text_delta', delta: 'orphan text' },
          { type: 'completed', model: 'fake-model', usage: usage },
        ],
      ]),
    /Model streamed assistant text but did not commit an assistant message\./,
  );
});

test('rejects tool argument deltas without a completed tool call', async () => {
  await assert.rejects(
    () =>
      runLoopWithFakeGateway([
        [
          {
            type: 'tool_call_delta',
            index: 0,
            itemId: 'item-1',
            toolCallId: undefined,
            name: undefined,
            delta: '{"text":"hello"}',
          },
          { type: 'completed', model: 'fake-model', usage: usage },
        ],
      ]),
    /Model streamed tool-call arguments but did not complete a tool call\./,
  );
});
