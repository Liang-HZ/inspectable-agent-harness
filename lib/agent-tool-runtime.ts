import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions';

import type { AgentEvent } from './agent-events';
import type { AgentRunContext } from './agent-run-context';
import { assertAgentRunNotAborted } from './agent-run-context';
import { executeAgentTool, type AgentToolExecution } from './agent-tools';

type AgentToolRuntimeCallbacks = {
  onEvent?: (event: AgentEvent) => void;
};

function createToolRequestEvent(
  toolCalls: ChatCompletionMessageFunctionToolCall[],
): AgentEvent {
  return {
    type: 'tool_requested',
    toolRequests: toolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      argumentsJson: toolCall.function.arguments,
    })),
  };
}

function createToolStartedEvent(
  toolCall: ChatCompletionMessageFunctionToolCall,
): AgentEvent {
  return {
    type: 'tool_started',
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    argumentsJson: toolCall.function.arguments,
  };
}

function createToolFinishedEvent(execution: AgentToolExecution): AgentEvent {
  return {
    type: 'tool_finished',
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    input: execution.input,
    result: execution.result,
  };
}

export function executeAgentToolCalls(
  toolCalls: ChatCompletionMessageFunctionToolCall[],
  context: AgentRunContext,
  callbacks: AgentToolRuntimeCallbacks = {},
): AgentToolExecution[] {
  assertAgentRunNotAborted(context);
  callbacks.onEvent?.(createToolRequestEvent(toolCalls));

  const toolExecutions: AgentToolExecution[] = [];

  for (const toolCall of toolCalls) {
    assertAgentRunNotAborted(context);
    callbacks.onEvent?.(createToolStartedEvent(toolCall));

    const toolExecution = executeAgentTool(toolCall);

    assertAgentRunNotAborted(context);
    callbacks.onEvent?.(createToolFinishedEvent(toolExecution));
    toolExecutions.push(toolExecution);
  }

  return toolExecutions;
}
