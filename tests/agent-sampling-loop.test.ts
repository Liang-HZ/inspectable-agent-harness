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
    output:
      'Character count: 11\nLine count: 1\nWord count: 2\nPreview: hello world',
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

test('records workspace read tool output through the sampling loop', async () => {
  const output = await runLoopWithFakeGateway([
    [
      { type: 'text_delta', delta: 'Reading the file.' },
      {
        type: 'assistant_message_done',
        message: { text: 'Reading the file.', providerPhase: null },
      },
      {
        type: 'tool_call_delta',
        index: 0,
        itemId: 'item-1',
        toolCallId: undefined,
        name: undefined,
        delta: JSON.stringify({
          path: 'tests/fixtures/workspace-tools/src/example.ts',
          limit: 20,
        }),
      },
      {
        type: 'tool_call_committed',
        toolCall: {
          id: 'call-read-1',
          name: 'read',
          argumentsJson: JSON.stringify({
            path: 'tests/fixtures/workspace-tools/src/example.ts',
            limit: 20,
          }),
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
    [
      { type: 'text_delta', delta: 'The file exports meaningfulFunction.' },
      {
        type: 'assistant_message_done',
        message: {
          text: 'The file exports meaningfulFunction.',
          providerPhase: null,
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
  ]);

  assert.equal(output.result.answer, 'The file exports meaningfulFunction.');
  assert.equal(output.result.usedTool, true);

  const toolOutput = output.history.find(
    (item) => item.type === 'function_call_output' && item.toolName === 'read',
  );

  assert.notEqual(toolOutput, undefined);
  assert.equal(toolOutput?.type, 'function_call_output');
  assert.equal(toolOutput?.isError, false);

  assert.equal(typeof toolOutput.output, 'string');
  assert.match(
    toolOutput.output,
    /File: tests\/fixtures\/workspace-tools\/src\/example\.ts/,
  );
  assert.match(toolOutput.output, /meaningfulFunction/);
});

test('serializes recoverable tool errors as plain model-visible text', async () => {
  const output = await runLoopWithFakeGateway([
    [
      {
        type: 'tool_call_committed',
        toolCall: {
          id: 'call-read-error',
          name: 'read',
          argumentsJson: JSON.stringify({ path: '../package.json' }),
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
    [
      { type: 'text_delta', delta: 'The path is outside the workspace.' },
      {
        type: 'assistant_message_done',
        message: {
          text: 'The path is outside the workspace.',
          providerPhase: null,
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
  ]);

  const toolOutput = output.history.find(
    (item) =>
      item.type === 'function_call_output' && item.callId === 'call-read-error',
  );

  assert.notEqual(toolOutput, undefined);
  assert.equal(toolOutput?.type, 'function_call_output');
  assert.equal(toolOutput?.isError, true);
  assert.equal(typeof toolOutput.output, 'string');
  assert.match(toolOutput.output, /^Error \[PATH_OUTSIDE_WORKSPACE\]:/);
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
