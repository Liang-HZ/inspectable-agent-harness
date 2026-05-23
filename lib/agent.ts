import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import type { AgentResult, AgentStep } from './agent-api-types';
import type { AgentInput } from './agent-input';
import { logAgentInfo, logAgentStep } from './agent-log';
import { agentTools, executeAgentTool } from './agent-tools';
import type { AgentToolExecution } from './agent-tools';
import type { ModelConfig } from './env';
import { createOpenAICompatibleClient } from './openai-compatible-client';

type RunAgentOptions = {
  runId: string;
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
  console.log(message)
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

export async function runAgent(
  input: AgentInput,
  config: ModelConfig,
  options: RunAgentOptions,
): Promise<AgentResult> {
  const client = createOpenAICompatibleClient(config);
  const prompt = buildAgentPrompt(input);
  const steps: AgentStep[] = [];

  const promptStep: AgentStep = {
    order: steps.length + 1,
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
  steps.push(promptStep);
  logAgentStep(options.runId, promptStep);
  logAgentInfo(options.runId, 'prompt_built', {
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

  const decisionCompletion = await client.chat.completions.create({
    model: config.model,
    messages: baseMessages,
    tools: agentTools,
    tool_choice: 'auto',
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
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
    logAgentStep(options.runId, directAnswerStep);
    logAgentInfo(options.runId, 'model_answer_received', {
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

  const toolExecutions = functionToolCalls.map(
    (toolCall): AgentToolExecution => executeAgentTool(toolCall),
  );
  const toolStep: AgentStep = {
    order: steps.length + 1,
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
  steps.push(toolStep);
  logAgentStep(options.runId, toolStep);

  const toolMessages: ChatCompletionMessageParam[] = toolExecutions.map(
    (execution) => ({
      role: 'tool',
      tool_call_id: execution.toolCallId,
      content: JSON.stringify(execution.result),
    }),
  );

  const finalCompletion = await client.chat.completions.create({
    model: config.model,
    messages: [
      ...baseMessages,
      buildAssistantToolCallMessage(decisionMessage),
      ...toolMessages,
    ],
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
  });

  const finalMessage = finalCompletion.choices[0]?.message;
  if (finalMessage === undefined) {
    throw new Error('Model returned no final agent answer.');
  }

  const finalAnswer = readAssistantAnswer(finalMessage);
  const finalStep: AgentStep = {
    order: steps.length + 1,
    title: 'Return final answer',
    detail: 'The agent used the tool result to produce the final answer.',
    output: {
      model: finalCompletion.model,
      answer: finalAnswer,
      usage: finalCompletion.usage ?? null,
    },
  };
  steps.push(finalStep);
  logAgentStep(options.runId, finalStep);
  logAgentInfo(options.runId, 'model_answer_received', {
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
