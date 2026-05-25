import type {
  AgentModelCallUsage,
  AgentResult,
  AgentStep,
} from './agent-api-types';
import type {
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
  createAssistantResponseItems,
  responseItemsToModelMessages,
  type AgentResponseItem,
} from './agent-response-items';

type RunAgentStreamCallbacks = {
  onEvent: (event: AgentEvent) => void;
};

const AGENT_SYSTEM_MESSAGE =
  'You are an inspectable tool-using agent. Decide whether the task needs a local tool. Use the inspect_text tool for text counts, length checks, line counts, or basic text statistics. If no tool is needed, answer directly. Keep the final answer practical and use the same language as the user.';
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
    output: execution.result,
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

function createAssistantFinalAnswerItem(answer: string): AgentResponseItem {
  return {
    type: 'message',
    role: 'assistant',
    content: answer,
  };
}

async function streamFinalAnswer(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  history: AgentResponseItem[],
  session: AgentSession | undefined,
  emitAgentEvent: (event: AgentEvent) => void,
): Promise<{
  model: string;
  answer: string;
  usage: AgentModelCallUsage;
}> {
  emitAgentEvent({
    type: 'model_started',
    stage: 'answer_generation',
  });

  const stream = await modelGateway.streamResponse({
    messages: responseItemsToModelMessages(history),
    tools: [],
    toolChoice: 'none',
    temperature: input.temperature,
  });

  let answer = '';
  let model = modelGateway.model;
  let usage: AgentModelUsageSnapshot = {
    tokenUsage: null,
    rawUsage: null,
  };

  for await (const event of stream) {
    if (event.type === 'completed') {
      model = event.model;
      usage = event.usage;
      continue;
    }

    if (event.delta === '') {
      continue;
    }

    answer += event.delta;
    emitAgentEvent({
      type: 'model_delta',
      delta: event.delta,
    });
  }

  if (answer.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  appendResponseItems(
    history,
    [createAssistantFinalAnswerItem(answer)],
    session,
  );

  return {
    model: model,
    answer: answer,
    usage: createAgentModelCallUsage(
      'answer_generation',
      usage.tokenUsage,
      usage.rawUsage,
    ),
  };
}

async function runToolLoop(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  context: AgentRunContext,
  history: AgentResponseItem[],
  steps: AgentStep[],
  modelCallUsages: AgentModelCallUsage[],
  session: AgentSession | undefined,
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<boolean> {
  let usedTool = false;

  for (let round = 1; round <= MAX_AGENT_ROUNDS; round += 1) {
    assertAgentRunNotAborted(context);
    emitAgentEvent?.({
      type: 'model_started',
      stage: 'tool_or_answer_selection',
    });

    const modelResponse = await modelGateway.createResponse({
      messages: responseItemsToModelMessages(history),
      tools: agentTools,
      toolChoice: 'auto',
      temperature: input.temperature,
    });
    const modelCallUsage = createAgentModelCallUsage(
      'tool_or_answer_selection',
      modelResponse.usage.tokenUsage,
      modelResponse.usage.rawUsage,
    );
    modelCallUsages.push(modelCallUsage);

    if (modelResponse.toolCalls.length === 0) {
      return usedTool;
    }

    usedTool = true;
    appendResponseItems(
      history,
      createAssistantResponseItems(modelResponse),
      session,
    );

    const toolBatch = await executeAgentToolBatch(
      modelResponse.toolCalls,
      context,
      {
        onEvent: emitAgentEvent,
      },
    );
    const toolStep = createToolStep(
      modelResponse.toolCalls,
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

  const usedTool = await runToolLoop(
    modelGateway,
    input,
    context,
    history,
    steps,
    modelCallUsages,
    undefined,
    undefined,
  );
  const finalResponse = await modelGateway.createResponse({
    messages: responseItemsToModelMessages(history),
    tools: [],
    toolChoice: 'none',
    temperature: input.temperature,
  });

  const finalAnswer = readAssistantAnswer(finalResponse.text);
  const finalCallUsage = createAgentModelCallUsage(
    'answer_generation',
    finalResponse.usage.tokenUsage,
    finalResponse.usage.rawUsage,
  );
  const finalStep = createFinalAnswerStep(
    finalResponse.model,
    finalAnswer,
    finalCallUsage,
    steps.length + 1,
    usedTool,
  );
  steps.push(finalStep);
  logAgentStep(context.runId, finalStep);
  appendResponseItems(
    history,
    [createAssistantFinalAnswerItem(finalAnswer)],
    undefined,
  );
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: finalAnswer,
    answerLength: finalAnswer.length,
    model: finalResponse.model,
    hasUsage: finalResponse.usage.tokenUsage !== null,
  });

  return {
    model: finalResponse.model,
    answer: finalAnswer,
    steps: steps,
    usage: createAgentUsage([...modelCallUsages, finalCallUsage]),
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
  const usedTool = await runToolLoop(
    modelGateway,
    input,
    context,
    history,
    steps,
    modelCallUsages,
    session,
    emitAgentEvent,
  );
  const finalAnswer = await streamFinalAnswer(
    modelGateway,
    input,
    history,
    session,
    emitAgentEvent,
  );
  const finalStep = createFinalAnswerStep(
    finalAnswer.model,
    finalAnswer.answer,
    finalAnswer.usage,
    steps.length + 1,
    usedTool,
  );
  steps.push(finalStep);
  emitAgentEvent({
    type: 'step_created',
    step: finalStep,
  });
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: finalAnswer.answer,
    answerLength: finalAnswer.answer.length,
    model: finalAnswer.model,
    hasUsage: finalAnswer.usage.tokenUsage !== null,
  });

  const usage = createAgentUsage([...modelCallUsages, finalAnswer.usage]);
  const result = {
    model: finalAnswer.model,
    answer: finalAnswer.answer,
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
