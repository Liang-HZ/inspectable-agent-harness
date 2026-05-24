import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import type { AgentResult, AgentStep } from './agent-api-types';
import {
  applyAgentEvent,
  createAgentRunState,
  type AgentEvent,
} from './agent-events';
import type { AgentInput } from './agent-input';
import {
  assertAgentRunNotAborted,
  createAgentRunContext,
  type AgentRunContextInput,
} from './agent-run-context';
import { logAgentEvent, logAgentInfo, logAgentStep } from './agent-log';
import { agentTools, executeAgentTool } from './agent-tools';
import type { AgentToolExecution } from './agent-tools';
import type { ModelConfig } from './env';
import {
  createAgentModelGateway,
  type AgentModelGateway,
} from './model-gateway';

type RunAgentStreamCallbacks = {
  onStep: (step: AgentStep) => void;
  onAnswerDelta: (delta: string) => void;
  onEvent?: (event: AgentEvent) => void;
};

const AGENT_SYSTEM_MESSAGE =
  'You are an inspectable tool-using agent. Decide whether the task needs a local tool. Use the inspect_text tool for text counts, length checks, line counts, or basic text statistics. If no tool is needed, answer directly. Keep the final answer practical and use the same language as the user.';

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

function readAssistantAnswer(message: ChatCompletionMessage): string {
  const content = message.content;

  if (content === undefined || content === null || content.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return content;
}

function readFunctionToolCalls(
  message: ChatCompletionMessage,
): ChatCompletionMessageFunctionToolCall[] {
  return (message.tool_calls ?? []).filter(
    (toolCall): toolCall is ChatCompletionMessageFunctionToolCall =>
      toolCall.type === 'function',
  );
}

function buildAssistantToolCallMessage(
  message: ChatCompletionMessage,
): ChatCompletionAssistantMessageParam {
  return {
    role: 'assistant',
    content: message.content,
    tool_calls: message.tool_calls,
  };
}

function temperatureParam(input: AgentInput) {
  return input.temperature === undefined
    ? {}
    : { temperature: input.temperature };
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
  functionToolCalls: ChatCompletionMessageFunctionToolCall[],
  toolExecutions: AgentToolExecution[],
  order: number,
): AgentStep {
  return {
    order: order,
    title: 'Run local tool',
    detail: 'The model requested a local tool, so the agent executed it.',
    output: {
      modelToolRequests: functionToolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        argumentsJson: toolCall.function.arguments,
      })),
      toolExecutions: toolExecutions,
    },
  };
}

function createFinalAnswerStep(
  model: string,
  answer: string,
  usage: unknown,
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

async function streamFinalAnswer(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  messages: ChatCompletionMessageParam[],
  callbacks: RunAgentStreamCallbacks,
  emitAgentEvent: (event: AgentEvent) => void,
): Promise<{
  model: string;
  answer: string;
  usage: unknown;
}> {
  emitAgentEvent({
    type: 'model_started',
    stage: 'answer_generation',
  });

  const stream = await modelGateway.streamChatCompletion({
    messages: messages,
    ...temperatureParam(input),
  });

  let answer = '';
  let model = modelGateway.model;

  for await (const chunk of stream) {
    model = chunk.model ?? model;

    const delta = chunk.choices[0]?.delta.content;
    if (delta === undefined || delta === null || delta === '') {
      continue;
    }

    answer += delta;
    emitAgentEvent({
      type: 'model_delta',
      delta: delta,
    });
    callbacks.onAnswerDelta(delta);
  }

  if (answer.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return {
    model: model,
    answer: answer,
    usage: null,
  };
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

  assertAgentRunNotAborted(context);
  const promptStep = createPromptStep(input, prompt, steps.length + 1);
  steps.push(promptStep);
  logAgentStep(context.runId, promptStep);
  logAgentInfo(context.runId, 'prompt_built', {
    prompt: prompt,
    promptLength: prompt.length,
  });

  const baseMessages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: AGENT_SYSTEM_MESSAGE,
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  const decisionCompletion = await modelGateway.createChatCompletion({
    messages: baseMessages,
    tools: agentTools,
    tool_choice: 'auto',
    ...temperatureParam(input),
  });

  const decisionMessage = decisionCompletion.choices[0]?.message;
  if (decisionMessage === undefined) {
    throw new Error('Model returned no agent decision.');
  }

  const functionToolCalls = readFunctionToolCalls(decisionMessage);
  if (functionToolCalls.length === 0) {
    const answer = readAssistantAnswer(decisionMessage);
    const directAnswerStep: AgentStep = {
      order: steps.length + 1,
      title: 'Answer directly',
      detail: 'The model decided no local tool was needed.',
      output: {
        model: decisionCompletion.model,
        answer: answer,
        usage: decisionCompletion.usage ?? null,
      },
    };
    steps.push(directAnswerStep);
    logAgentStep(context.runId, directAnswerStep);
    logAgentInfo(context.runId, 'model_answer_received', {
      answer: answer,
      answerLength: answer.length,
      model: decisionCompletion.model,
      hasUsage:
        decisionCompletion.usage !== undefined &&
        decisionCompletion.usage !== null,
    });

    return {
      model: decisionCompletion.model,
      answer: answer,
      steps: steps,
      usage: decisionCompletion.usage ?? null,
    };
  }

  assertAgentRunNotAborted(context);
  const toolExecutions = functionToolCalls.map(
    (toolCall): AgentToolExecution => executeAgentTool(toolCall),
  );
  assertAgentRunNotAborted(context);
  const toolStep = createToolStep(
    functionToolCalls,
    toolExecutions,
    steps.length + 1,
  );
  steps.push(toolStep);
  logAgentStep(context.runId, toolStep);

  const toolMessages: ChatCompletionMessageParam[] = toolExecutions.map(
    (execution) => ({
      role: 'tool',
      tool_call_id: execution.toolCallId,
      content: JSON.stringify(execution.result),
    }),
  );

  const finalCompletion = await modelGateway.createChatCompletion({
    messages: [
      ...baseMessages,
      buildAssistantToolCallMessage(decisionMessage),
      ...toolMessages,
    ],
    ...temperatureParam(input),
  });

  const finalMessage = finalCompletion.choices[0]?.message;
  if (finalMessage === undefined) {
    throw new Error('Model returned no final agent answer.');
  }

  const finalAnswer = readAssistantAnswer(finalMessage);
  const finalStep = createFinalAnswerStep(
    finalCompletion.model,
    finalAnswer,
    finalCompletion.usage ?? null,
    steps.length + 1,
    true,
  );
  steps.push(finalStep);
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: finalAnswer,
    answerLength: finalAnswer.length,
    model: finalCompletion.model,
    hasUsage:
      finalCompletion.usage !== undefined && finalCompletion.usage !== null,
  });

  return {
    model: finalCompletion.model,
    answer: finalAnswer,
    steps: steps,
    usage: finalCompletion.usage ?? null,
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
  let runState = createAgentRunState(context.runId);
  const prompt = buildAgentPrompt(input);
  const steps: AgentStep[] = [];

  function emitAgentEvent(event: AgentEvent): void {
    runState = applyAgentEvent(runState, event);
    callbacks.onEvent?.(event);
    logAgentEvent(context.runId, event);
  }

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
  callbacks.onStep(promptStep);
  logAgentStep(context.runId, promptStep);
  logAgentInfo(context.runId, 'prompt_built', {
    prompt: prompt,
    promptLength: prompt.length,
  });

  const baseMessages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: AGENT_SYSTEM_MESSAGE,
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  emitAgentEvent({
    type: 'model_started',
    stage: 'tool_or_answer_selection',
  });
  const decisionCompletion = await modelGateway.createChatCompletion({
    messages: baseMessages,
    tools: agentTools,
    tool_choice: 'auto',
    ...temperatureParam(input),
  });

  const decisionMessage = decisionCompletion.choices[0]?.message;
  if (decisionMessage === undefined) {
    throw new Error('Model returned no agent decision.');
  }

  const functionToolCalls = readFunctionToolCalls(decisionMessage);
  if (functionToolCalls.length === 0) {
    const finalAnswer = await streamFinalAnswer(
      modelGateway,
      input,
      baseMessages,
      callbacks,
      emitAgentEvent,
    );
    const finalStep = createFinalAnswerStep(
      finalAnswer.model,
      finalAnswer.answer,
      finalAnswer.usage,
      steps.length + 1,
      false,
    );
    steps.push(finalStep);
    emitAgentEvent({
      type: 'step_created',
      step: finalStep,
    });
    callbacks.onStep(finalStep);
    logAgentStep(context.runId, finalStep);

    const result = {
      model: finalAnswer.model,
      answer: finalAnswer.answer,
      steps: steps,
      usage: finalAnswer.usage,
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

  assertAgentRunNotAborted(context);
  emitAgentEvent({
    type: 'tool_requested',
    toolRequests: functionToolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      argumentsJson: toolCall.function.arguments,
    })),
  });
  const toolExecutions = functionToolCalls.map(
    (toolCall): AgentToolExecution => executeAgentTool(toolCall),
  );
  assertAgentRunNotAborted(context);
  const toolStep = createToolStep(
    functionToolCalls,
    toolExecutions,
    steps.length + 1,
  );
  steps.push(toolStep);
  emitAgentEvent({
    type: 'step_created',
    step: toolStep,
  });
  callbacks.onStep(toolStep);
  logAgentStep(context.runId, toolStep);

  const toolMessages: ChatCompletionMessageParam[] = toolExecutions.map(
    (execution) => ({
      role: 'tool',
      tool_call_id: execution.toolCallId,
      content: JSON.stringify(execution.result),
    }),
  );
  const finalAnswer = await streamFinalAnswer(
    modelGateway,
    input,
    [
      ...baseMessages,
      buildAssistantToolCallMessage(decisionMessage),
      ...toolMessages,
    ],
    callbacks,
    emitAgentEvent,
  );
  const finalStep = createFinalAnswerStep(
    finalAnswer.model,
    finalAnswer.answer,
    finalAnswer.usage,
    steps.length + 1,
    true,
  );
  steps.push(finalStep);
  emitAgentEvent({
    type: 'step_created',
    step: finalStep,
  });
  callbacks.onStep(finalStep);
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: finalAnswer.answer,
    answerLength: finalAnswer.answer.length,
    model: finalAnswer.model,
    hasUsage: finalAnswer.usage !== undefined && finalAnswer.usage !== null,
  });

  const result = {
    model: finalAnswer.model,
    answer: finalAnswer.answer,
    steps: steps,
    usage: finalAnswer.usage,
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
