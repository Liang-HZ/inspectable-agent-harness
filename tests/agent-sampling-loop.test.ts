import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type {
  AgentDebugStreamEvent,
  AgentModelCallUsage,
  AgentStep,
} from '../lib/agent-api-types';
import { runSamplingLoop } from '../lib/agent';
import type { AgentInput } from '../lib/agent-input';
import type { AgentModelStreamEvent } from '../lib/agent-model-types';
import type { AgentModelGateway } from '../lib/model-gateway';
import type { AgentResponseItem } from '../lib/agent-response-items';
import type { AgentEvent } from '../lib/agent-events';
import { createAgentRunContext } from '../lib/agent-run-context';
import type { AgentRunPolicy } from '../lib/agent-permissions';

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
  approvalPolicy: 'on_request',
  sandboxMode: 'read_only',
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

async function runLoopWithFakeGateway(
  rounds: AgentModelStreamEvent[][],
  policy?: AgentRunPolicy,
) {
  const context = createAgentRunContext({ runId: 'test-run', policy: policy });
  const history = initialHistory();
  const steps: AgentStep[] = [];
  const events: AgentEvent[] = [];
  const debugEvents: AgentDebugStreamEvent[] = [];
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
    (event) => debugEvents.push(event),
  );

  return {
    result: result,
    history: history,
    steps: steps,
    events: events,
    debugEvents: debugEvents,
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
    output.debugEvents
      .filter((event) => event.type === 'historyCommitted')
      .map((event) => event.items),
    [output.history.slice(2)],
  );
  assert.deepEqual(
    output.events
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => event.delta),
    ['Final ', 'answer.'],
  );
});

test('exposes read-only built-in tools plus safe-command shell to the model in safe mode', async () => {
  const output = await runLoopWithFakeGateway([
    [
      {
        type: 'text_delta',
        delta: 'No edit is needed.',
      },
      {
        type: 'assistant_message_done',
        message: { text: 'No edit is needed.', providerPhase: null },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
  ]);
  const modelRequestedEvent = output.events.find(
    (event) => event.type === 'model_requested',
  );

  assert.notEqual(modelRequestedEvent, undefined);
  assert.equal(modelRequestedEvent?.type, 'model_requested');
  assert.deepEqual(
    modelRequestedEvent.request.tools.map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls', 'shell'],
  );
});

test('exposes editing built-in tools to the model in workspace write mode', async () => {
  const output = await runLoopWithFakeGateway(
    [
      [
        {
          type: 'text_delta',
          delta: 'No edit is needed.',
        },
        {
          type: 'assistant_message_done',
          message: { text: 'No edit is needed.', providerPhase: null },
        },
        { type: 'completed', model: 'fake-model', usage: usage },
      ],
    ],
    {
      approvalPolicy: 'never',
      sandboxMode: 'workspace_write',
    },
  );
  const modelRequestedEvent = output.events.find(
    (event) => event.type === 'model_requested',
  );

  assert.notEqual(modelRequestedEvent, undefined);
  assert.equal(modelRequestedEvent?.type, 'model_requested');
  assert.deepEqual(
    modelRequestedEvent.request.tools.map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls', 'write', 'edit', 'shell'],
  );
});

test('records working message, function call, tool output, and final response', async () => {
  const output = await runLoopWithFakeGateway([
    [
      { type: 'text_delta', delta: 'Reading project file.' },
      {
        type: 'assistant_message_done',
        message: { text: 'Reading project file.', providerPhase: null },
      },
      {
        type: 'tool_call_delta',
        index: 0,
        itemId: 'item-1',
        toolCallId: undefined,
        name: undefined,
        delta: JSON.stringify({
          path: 'tests/fixtures/builtin-tools/src/example.ts',
          limit: 20,
        }),
      },
      {
        type: 'tool_call_committed',
        toolCall: {
          id: 'call-1',
          name: 'read',
          argumentsJson: JSON.stringify({
            path: 'tests/fixtures/builtin-tools/src/example.ts',
            limit: 20,
          }),
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ],
    [
      {
        type: 'text_delta',
        delta: 'The file exports meaningfulFunction.',
      },
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
  assert.equal(output.steps.length, 1);
  assert.equal(output.steps[0].title, 'Run local tool');

  const responseItems = output.history.slice(2);
  assert.equal(responseItems.length, 4);
  assert.deepEqual(responseItems[0], {
    type: 'message',
    role: 'assistant',
    content: 'Reading project file.',
    providerPhase: null,
    runtimeRole: 'working_message',
  });
  assert.deepEqual(responseItems[1], {
    type: 'function_call',
    callId: 'call-1',
    name: 'read',
    argumentsJson: JSON.stringify({
      path: 'tests/fixtures/builtin-tools/src/example.ts',
      limit: 20,
    }),
  });
  assert.deepEqual(responseItems[2], {
    type: 'function_call_output',
    callId: 'call-1',
    toolName: 'read',
    output:
      "File: tests/fixtures/builtin-tools/src/example.ts\nLines: 1-6 of 6\n\nexport function meaningfulFunction(): string {\n  return 'built-in tool fixture';\n}\n\nexport const sharedMarker = 'builtin-search-marker';\n",
    isError: false,
  });
  assert.deepEqual(responseItems[3], {
    type: 'message',
    role: 'assistant',
    content: 'The file exports meaningfulFunction.',
    providerPhase: null,
    runtimeRole: 'final_response',
  });
  assert.deepEqual(
    output.debugEvents
      .filter((event) => event.type === 'historyCommitted')
      .map((event) => event.items),
    [
      [responseItems[0], responseItems[1]],
      [responseItems[2]],
      [responseItems[3]],
    ],
  );
  assert.equal(
    output.events.some(
      (event) => (event as { type: string }).type === 'history_committed',
    ),
    false,
  );
});

test('records built-in read tool output through the sampling loop', async () => {
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
          path: 'tests/fixtures/builtin-tools/src/example.ts',
          limit: 20,
        }),
      },
      {
        type: 'tool_call_committed',
        toolCall: {
          id: 'call-read-1',
          name: 'read',
          argumentsJson: JSON.stringify({
            path: 'tests/fixtures/builtin-tools/src/example.ts',
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
    /File: tests\/fixtures\/builtin-tools\/src\/example\.ts/,
  );
  assert.match(toolOutput.output, /meaningfulFunction/);
});

test('allows more than five tool rounds before the final response', async () => {
  const rounds: AgentModelStreamEvent[][] = [];

  for (let index = 1; index <= 6; index += 1) {
    rounds.push([
      {
        type: 'tool_call_committed',
        toolCall: {
          id: `call-read-${index}`,
          name: 'read',
          argumentsJson: JSON.stringify({
            path: 'tests/fixtures/builtin-tools/src/example.ts',
            offset: index,
            limit: 1,
          }),
        },
      },
      { type: 'completed', model: 'fake-model', usage: usage },
    ]);
  }

  rounds.push([
    {
      type: 'text_delta',
      delta: 'Finished after six file reads.',
    },
    {
      type: 'assistant_message_done',
      message: {
        text: 'Finished after six file reads.',
        providerPhase: null,
      },
    },
    { type: 'completed', model: 'fake-model', usage: usage },
  ]);

  const output = await runLoopWithFakeGateway(rounds);

  assert.equal(output.result.answer, 'Finished after six file reads.');
  assert.equal(output.result.usedTool, true);
  assert.equal(
    output.history.filter((item) => item.type === 'function_call_output')
      .length,
    6,
  );
});

test('stops repeated identical tool-call loops without a global round limit', async () => {
  const repeatedReadRound = (callId: string): AgentModelStreamEvent[] => [
    {
      type: 'tool_call_committed',
      toolCall: {
        id: callId,
        name: 'read',
        argumentsJson: JSON.stringify({
          path: 'tests/fixtures/builtin-tools/src/example.ts',
          limit: 20,
        }),
      },
    },
    { type: 'completed', model: 'fake-model', usage: usage },
  ];
  const history = initialHistory();

  await assert.rejects(
    () =>
      runSamplingLoop(
        createFakeGateway([
          repeatedReadRound('call-repeat-1'),
          repeatedReadRound('call-repeat-2'),
          repeatedReadRound('call-repeat-3'),
          repeatedReadRound('call-repeat-4'),
        ]),
        baseInput,
        createAgentRunContext({ runId: 'test-run' }),
        history,
        [],
        [],
        undefined,
        undefined,
        undefined,
      ),
    /same `read` tool call with the same result more than 3 times/,
  );
  assert.equal(
    history.filter((item) => item.type === 'function_call_output').length,
    4,
  );
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
      {
        type: 'text_delta',
        delta: 'The path is outside the current allowed root.',
      },
      {
        type: 'assistant_message_done',
        message: {
          text: 'The path is outside the current allowed root.',
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
  assert.match(toolOutput.output, /^Error \[PATH_OUTSIDE_ALLOWED_ROOT\]:/);
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
