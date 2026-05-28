import type {
  AgentModelCallUsage,
  AgentResult,
  AgentStep,
} from './agent-api-types';
import type {
  AgentModelAssistantMessage,
  AgentModelToolCall,
  AgentModelUsageSnapshot,
} from './agent-model-types';
import {
  applyAgentEvent,
  createAgentRunState,
  type AgentEvent,
} from './agent-events';
import type { AgentInput } from './agent-input';
import {
  assertAgentRunNotAborted,
  createAgentRunContext,
  type AgentRunContext,
  type AgentRunContextInput,
} from './agent-run-context';
import {
  appendAgentResponseItem,
  appendAgentSessionEvent,
  appendAgentTurnContext,
  createAgentSession,
  type AgentSession,
} from './agent-session-store';
import { logAgentEvent, logAgentInfo, logAgentStep } from './agent-log';
import { executeAgentToolBatch } from './agent-tool-scheduler';
import { agentTools } from './agent-tools';
import type { AgentToolExecution, AgentToolExecutionMode } from './agent-tools';
import type { ModelConfig } from './env';
import {
  createAgentModelGateway,
  type AgentModelGateway,
} from './model-gateway';
import { createAgentModelCallUsage, createAgentUsage } from './agent-usage';
import {
  createCommittedAssistantMessageItems,
  createAssistantResponseItems,
  responseItemsToModelMessages,
  type AgentResponseItem,
} from './agent-response-items';

type RunAgentStreamCallbacks = {
  onEvent: (event: AgentEvent) => void;
};

type SamplingLoopResult = {
  model: string;
  answer: string;
  finalCallUsage: AgentModelCallUsage;
  usedTool: boolean;
};

type SamplingRoundResult = {
  model: string;
  streamedAssistantText: string;
  assistantMessages: AgentModelAssistantMessage[];
  toolCalls: AgentModelToolCall[];
  usage: AgentModelUsageSnapshot;
  sawToolCallDelta: boolean;
};

const AGENT_SYSTEM_MESSAGE =
  'You are an inspectable tool-using agent. Decide whether the task needs a local tool. Use ls/find/grep/read for workspace exploration: find file paths before reading, grep for text or symbols, and read exact files with pagination. Use inspect_text only for direct text counts, length checks, line counts, or basic text statistics. If no tool is needed, answer directly. Keep the final answer practical and use the same language as the user.';
const MAX_AGENT_ROUNDS = 5;

function buildAgentPrompt(input: AgentInput): string {
  const sections = [
    `Task:\n${input.task}`,
    input.goal === undefined ? undefined : `Goal:\n${input.goal}`,
    input.context === undefined ? undefined : `Context:\n${input.context}`,
  ];

  return sections
    .filter((section): section is string => section !== undefined)
    .join('\n\n');
}

function readAssistantAnswer(text: string): string {
  if (text.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return text;
}

function createPromptStep(
  input: AgentInput,
  prompt: string,
  order: number,
): AgentStep {
  return {
    order: order,
    title: 'Build prompt',
    detail: 'The agent converted the validated request into a model prompt.',
    output: {
      task: input.task,
      goal: input.goal,
      context: input.context,
      modelOverride: input.model,
      temperature: input.temperature,
      prompt: prompt,
    },
  };
}

function createToolStep(
  functionToolCalls: AgentModelToolCall[],
  toolExecutions: AgentToolExecution[],
  executionMode: AgentToolExecutionMode,
  round: number,
  order: number,
): AgentStep {
  const detail =
    functionToolCalls.length === 1
      ? 'The model requested a local tool, so the agent executed it.'
      : executionMode === 'parallel'
        ? 'The model requested independent local tools, so the agent executed the batch in parallel.'
        : 'The model requested local tools, so the agent executed the batch sequentially.';

  return {
    order: order,
    title:
      functionToolCalls.length === 1 ? 'Run local tool' : 'Run local tools',
    detail: detail,
    output: {
      round: round,
      executionMode: executionMode,
      modelToolRequests: functionToolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsJson: toolCall.argumentsJson,
      })),
      toolExecutions: toolExecutions,
    },
  };
}

function createFinalAnswerStep(
  model: string,
  answer: string,
  usage: AgentModelCallUsage,
  order: number,
  usedTool: boolean,
): AgentStep {
  return {
    order: order,
    title: usedTool ? 'Return final answer' : 'Answer directly',
    detail: usedTool
      ? 'The agent used the tool result to produce the final answer.'
      : 'The model decided no local tool was needed.',
    output: {
      model: model,
      answer: answer,
      usage: usage,
    },
  };
}

function createInitialResponseItems(prompt: string): AgentResponseItem[] {
  return [
    {
      type: 'message',
      role: 'system',
      content: AGENT_SYSTEM_MESSAGE,
    },
    {
      type: 'message',
      role: 'user',
      content: prompt,
    },
  ];
}

function createToolOutputItem(
  execution: AgentToolExecution,
): AgentResponseItem {
  return {
    type: 'function_call_output',
    callId: execution.toolCallId,
    toolName: execution.toolName,
    output: execution.modelOutput,
    isError: execution.isError,
  };
}

function appendResponseItems(
  history: AgentResponseItem[],
  items: AgentResponseItem[],
  session: AgentSession | undefined,
): void {
  for (const item of items) {
    history.push(item);

    if (session !== undefined) {
      appendAgentResponseItem(session, item);
    }
  }
}

function appendExistingResponseItemsToSession(
  items: AgentResponseItem[],
  session: AgentSession,
): void {
  for (const item of items) {
    appendAgentResponseItem(session, item);
  }
}

function readCommittedAssistantText(
  messages: AgentModelAssistantMessage[],
): string {
  return messages.map((message) => message.text).join('');
}

function assertNoIncompleteToolCall(roundResult: SamplingRoundResult): void {
  if (roundResult.sawToolCallDelta && roundResult.toolCalls.length === 0) {
    throw new Error(
      'Model streamed tool-call arguments but did not complete a tool call.',
    );
  }
}

function assertCommittedAssistantMessage(
  roundResult: SamplingRoundResult,
): void {
  if (
    roundResult.streamedAssistantText !== '' &&
    roundResult.assistantMessages.length === 0
  ) {
    throw new Error(
      'Model streamed assistant text but did not commit an assistant message.',
    );
  }
}

async function runSamplingRound(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  context: AgentRunContext,
  history: AgentResponseItem[],
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<SamplingRoundResult> {
  const stream = await modelGateway.streamResponse({
    messages: responseItemsToModelMessages(history),
    tools: agentTools,
    toolChoice: 'auto',
    temperature: input.temperature,
  });

  let streamedAssistantText = '';
  let model = modelGateway.model;
  let usage: AgentModelUsageSnapshot = {
    tokenUsage: null,
    rawUsage: null,
  };
  let sawToolCallDelta = false;
  const assistantMessages: AgentModelAssistantMessage[] = [];
  const toolCalls: AgentModelToolCall[] = [];

  for await (const event of stream) {
    assertAgentRunNotAborted(context);

    switch (event.type) {
      case 'completed':
        model = event.model;
        usage = event.usage;
        break;

      case 'assistant_message_done':
        assistantMessages.push(event.message);
        break;

      case 'tool_call_committed':
        toolCalls.push(event.toolCall);
        break;

      case 'tool_call_delta':
        sawToolCallDelta = true;
        break;

      case 'text_delta':
        if (event.delta === '') {
          break;
        }

        streamedAssistantText += event.delta;
        emitAgentEvent?.({
          type: 'assistant_delta',
          delta: event.delta,
        });
        break;
    }
  }

  return {
    model: model,
    streamedAssistantText: streamedAssistantText,
    assistantMessages: assistantMessages,
    toolCalls: toolCalls,
    usage: usage,
    sawToolCallDelta: sawToolCallDelta,
  };
}

export async function runSamplingLoop(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  context: AgentRunContext,
  history: AgentResponseItem[],
  steps: AgentStep[],
  modelCallUsages: AgentModelCallUsage[],
  session: AgentSession | undefined,
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<SamplingLoopResult> {
  let usedTool = false;

  for (let round = 1; round <= MAX_AGENT_ROUNDS; round += 1) {
    assertAgentRunNotAborted(context);
    emitAgentEvent?.({
      type: 'model_started',
      stage: 'tool_or_answer_selection',
    });

    const roundResult = await runSamplingRound(
      modelGateway,
      input,
      context,
      history,
      emitAgentEvent,
    );
    assertNoIncompleteToolCall(roundResult);
    assertCommittedAssistantMessage(roundResult);

    const modelCallUsage = createAgentModelCallUsage(
      'tool_or_answer_selection',
      roundResult.usage.tokenUsage,
      roundResult.usage.rawUsage,
    );
    modelCallUsages.push(modelCallUsage);

    if (roundResult.toolCalls.length === 0) {
      const answer = readAssistantAnswer(
        readCommittedAssistantText(roundResult.assistantMessages),
      );
      appendResponseItems(
        history,
        createCommittedAssistantMessageItems(
          roundResult.assistantMessages,
          'final_response',
        ),
        session,
      );

      return {
        model: roundResult.model,
        answer: answer,
        finalCallUsage: modelCallUsage,
        usedTool: usedTool,
      };
    }

    usedTool = true;
    appendResponseItems(
      history,
      [
        ...createCommittedAssistantMessageItems(
          roundResult.assistantMessages,
          'working_message',
        ),
        ...createAssistantResponseItems({
          model: roundResult.model,
          text: '',
          toolCalls: roundResult.toolCalls,
          usage: roundResult.usage,
        }),
      ],
      session,
    );

    const toolBatch = await executeAgentToolBatch(
      roundResult.toolCalls,
      context,
      {
        onEvent: emitAgentEvent,
      },
    );
    const toolStep = createToolStep(
      roundResult.toolCalls,
      toolBatch.toolExecutions,
      toolBatch.executionMode,
      round,
      steps.length + 1,
    );
    steps.push(toolStep);
    emitAgentEvent?.({
      type: 'step_created',
      step: toolStep,
    });
    logAgentStep(context.runId, toolStep);

    appendResponseItems(
      history,
      toolBatch.toolExecutions.map((execution) =>
        createToolOutputItem(execution),
      ),
      session,
    );
  }

  throw new Error(`Agent exceeded maximum tool rounds: ${MAX_AGENT_ROUNDS}.`);
}

export async function runAgent(
  input: AgentInput,
  config: ModelConfig,
  contextInput: AgentRunContextInput,
): Promise<AgentResult> {
  const context = createAgentRunContext(contextInput);
  const modelGateway = createAgentModelGateway(config, context);
  const prompt = buildAgentPrompt(input);
  const steps: AgentStep[] = [];
  const history = createInitialResponseItems(prompt);
  const modelCallUsages: AgentModelCallUsage[] = [];

  assertAgentRunNotAborted(context);
  const promptStep = createPromptStep(input, prompt, steps.length + 1);
  steps.push(promptStep);
  logAgentStep(context.runId, promptStep);
  logAgentInfo(context.runId, 'prompt_built', {
    prompt: prompt,
    promptLength: prompt.length,
  });

  const samplingResult = await runSamplingLoop(
    modelGateway,
    input,
    context,
    history,
    steps,
    modelCallUsages,
    undefined,
    undefined,
  );
  const finalStep = createFinalAnswerStep(
    samplingResult.model,
    samplingResult.answer,
    samplingResult.finalCallUsage,
    steps.length + 1,
    samplingResult.usedTool,
  );
  steps.push(finalStep);
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: samplingResult.answer,
    answerLength: samplingResult.answer.length,
    model: samplingResult.model,
    hasUsage: samplingResult.finalCallUsage.tokenUsage !== null,
  });

  return {
    model: samplingResult.model,
    answer: samplingResult.answer,
    steps: steps,
    usage: createAgentUsage(modelCallUsages),
  };
}

export async function runAgentStream(
  input: AgentInput,
  config: ModelConfig,
  contextInput: AgentRunContextInput,
  callbacks: RunAgentStreamCallbacks,
): Promise<AgentResult> {
  const context = createAgentRunContext(contextInput);
  const modelGateway = createAgentModelGateway(config, context);
  const session = createAgentSession({
    id: context.runId,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: config.model,
    baseURL: config.baseURL,
    wireApi: config.wireApi,
    policy: context.policy,
  });
  appendAgentTurnContext(session, {
    turnId: context.runId,
    model: config.model,
    wireApi: config.wireApi,
    approvalPolicy: context.policy.approvalPolicy,
    sandboxMode: context.policy.sandboxMode,
    temperature: input.temperature,
  });
  let runState = createAgentRunState(context.runId);
  const prompt = buildAgentPrompt(input);
  const steps: AgentStep[] = [];
  const history = createInitialResponseItems(prompt);
  const modelCallUsages: AgentModelCallUsage[] = [];

  function emitAgentEvent(event: AgentEvent): void {
    appendAgentSessionEvent(session, event);
    runState = applyAgentEvent(runState, event);
    callbacks.onEvent(event);
    logAgentEvent(context.runId, event);
  }

  logAgentInfo(context.runId, 'session_created', {
    path: session.path,
  });

  emitAgentEvent({
    type: 'run_started',
    runId: context.runId,
  });

  assertAgentRunNotAborted(context);
  const promptStep = createPromptStep(input, prompt, steps.length + 1);
  steps.push(promptStep);
  emitAgentEvent({
    type: 'step_created',
    step: promptStep,
  });
  logAgentStep(context.runId, promptStep);
  logAgentInfo(context.runId, 'prompt_built', {
    prompt: prompt,
    promptLength: prompt.length,
  });

  appendExistingResponseItemsToSession(history, session);
  const samplingResult = await runSamplingLoop(
    modelGateway,
    input,
    context,
    history,
    steps,
    modelCallUsages,
    session,
    emitAgentEvent,
  );
  const finalStep = createFinalAnswerStep(
    samplingResult.model,
    samplingResult.answer,
    samplingResult.finalCallUsage,
    steps.length + 1,
    samplingResult.usedTool,
  );
  steps.push(finalStep);
  emitAgentEvent({
    type: 'step_created',
    step: finalStep,
  });
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: samplingResult.answer,
    answerLength: samplingResult.answer.length,
    model: samplingResult.model,
    hasUsage: samplingResult.finalCallUsage.tokenUsage !== null,
  });

  const usage = createAgentUsage(modelCallUsages);
  const result = {
    model: samplingResult.model,
    answer: samplingResult.answer,
    steps: steps,
    usage: usage,
  };
  emitAgentEvent({
    type: 'run_succeeded',
    result: result,
  });
  logAgentInfo(context.runId, 'runtime_state_finished', {
    status: runState.status,
    eventCount: runState.events.length,
  });

  return result;
}
