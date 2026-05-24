import type {
  AgentModelCallUsage,
  AgentResult,
  AgentStep,
} from './agent-api-types';
import type {
  AgentModelMessage,
  AgentModelResponse,
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
  type AgentRunContextInput,
} from './agent-run-context';
import {
  appendAgentSessionEvent,
  appendAgentTurnContext,
  createAgentSession,
} from './agent-session-store';
import { logAgentEvent, logAgentInfo, logAgentStep } from './agent-log';
import { executeAgentToolCalls } from './agent-tool-runtime';
import { agentTools } from './agent-tools';
import type { AgentToolExecution } from './agent-tools';
import type { ModelConfig } from './env';
import {
  createAgentModelGateway,
  type AgentModelGateway,
} from './model-gateway';
import { createAgentModelCallUsage, createAgentUsage } from './agent-usage';

type RunAgentStreamCallbacks = {
  onEvent: (event: AgentEvent) => void;
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

function readAssistantAnswer(text: string): string {
  if (text.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return text;
}

function buildAssistantToolCallMessage(
  response: AgentModelResponse,
): AgentModelMessage {
  return {
    role: 'assistant',
    content: response.text,
    toolCalls: response.toolCalls,
  };
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
  order: number,
): AgentStep {
  return {
    order: order,
    title: 'Run local tool',
    detail: 'The model requested a local tool, so the agent executed it.',
    output: {
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

async function streamFinalAnswer(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  messages: AgentModelMessage[],
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
    messages: messages,
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

  const baseMessages: AgentModelMessage[] = [
    {
      role: 'system',
      content: AGENT_SYSTEM_MESSAGE,
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  const decisionResponse = await modelGateway.createResponse({
    messages: baseMessages,
    tools: agentTools,
    toolChoice: 'auto',
    temperature: input.temperature,
  });

  const functionToolCalls = decisionResponse.toolCalls;
  if (functionToolCalls.length === 0) {
    const answer = readAssistantAnswer(decisionResponse.text);
    const decisionCallUsage = createAgentModelCallUsage(
      'tool_or_answer_selection',
      decisionResponse.usage.tokenUsage,
      decisionResponse.usage.rawUsage,
    );
    const directAnswerStep: AgentStep = {
      order: steps.length + 1,
      title: 'Answer directly',
      detail: 'The model decided no local tool was needed.',
      output: {
        model: decisionResponse.model,
        answer: answer,
        usage: decisionCallUsage,
      },
    };
    steps.push(directAnswerStep);
    logAgentStep(context.runId, directAnswerStep);
    logAgentInfo(context.runId, 'model_answer_received', {
      answer: answer,
      answerLength: answer.length,
      model: decisionResponse.model,
      hasUsage: decisionResponse.usage.tokenUsage !== null,
    });

    return {
      model: decisionResponse.model,
      answer: answer,
      steps: steps,
      usage: createAgentUsage([decisionCallUsage]),
    };
  }

  const decisionCallUsage = createAgentModelCallUsage(
    'tool_or_answer_selection',
    decisionResponse.usage.tokenUsage,
    decisionResponse.usage.rawUsage,
  );

  const toolExecutions = executeAgentToolCalls(functionToolCalls, context);
  const toolStep = createToolStep(
    functionToolCalls,
    toolExecutions,
    steps.length + 1,
  );
  steps.push(toolStep);
  logAgentStep(context.runId, toolStep);

  const toolMessages: AgentModelMessage[] = toolExecutions.map((execution) => ({
    role: 'tool',
    toolCallId: execution.toolCallId,
    content: JSON.stringify(execution.result),
  }));

  const finalResponse = await modelGateway.createResponse({
    messages: [
      ...baseMessages,
      buildAssistantToolCallMessage(decisionResponse),
      ...toolMessages,
    ],
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
    true,
  );
  steps.push(finalStep);
  logAgentStep(context.runId, finalStep);
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
    usage: createAgentUsage([decisionCallUsage, finalCallUsage]),
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

  const baseMessages: AgentModelMessage[] = [
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
  const decisionResponse = await modelGateway.createResponse({
    messages: baseMessages,
    tools: agentTools,
    toolChoice: 'auto',
    temperature: input.temperature,
  });

  const decisionCallUsage = createAgentModelCallUsage(
    'tool_or_answer_selection',
    decisionResponse.usage.tokenUsage,
    decisionResponse.usage.rawUsage,
  );
  const functionToolCalls = decisionResponse.toolCalls;
  if (functionToolCalls.length === 0) {
    const finalAnswer = await streamFinalAnswer(
      modelGateway,
      input,
      baseMessages,
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
    logAgentStep(context.runId, finalStep);

    const usage = createAgentUsage([decisionCallUsage, finalAnswer.usage]);
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

  const toolExecutions = executeAgentToolCalls(functionToolCalls, context, {
    onEvent: emitAgentEvent,
  });
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
  logAgentStep(context.runId, toolStep);

  const toolMessages: AgentModelMessage[] = toolExecutions.map((execution) => ({
    role: 'tool',
    toolCallId: execution.toolCallId,
    content: JSON.stringify(execution.result),
  }));
  const finalAnswer = await streamFinalAnswer(
    modelGateway,
    input,
    [
      ...baseMessages,
      buildAssistantToolCallMessage(decisionResponse),
      ...toolMessages,
    ],
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
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: finalAnswer.answer,
    answerLength: finalAnswer.answer.length,
    model: finalAnswer.model,
    hasUsage: finalAnswer.usage.tokenUsage !== null,
  });

  const usage = createAgentUsage([decisionCallUsage, finalAnswer.usage]);
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
