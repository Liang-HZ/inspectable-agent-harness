import type { AgentEvent } from './agent-events';
import type { AgentModelToolCall } from './agent-model-types';
import type { AgentRunContext } from './agent-run-context';
import { assertAgentRunNotAborted } from './agent-run-context';
import { executeAgentToolCall } from './agent-tool-runtime';
import {
  agentToolRegistry,
  type AgentToolExecution,
  type AgentToolExecutionMode,
} from './agent-tools';

export type AgentToolBatchExecution = {
  executionMode: AgentToolExecutionMode;
  toolExecutions: AgentToolExecution[];
};

type AgentToolSchedulerCallbacks = {
  onEvent?: (event: AgentEvent) => void;
};

function createToolRequestEvent(toolCalls: AgentModelToolCall[]): AgentEvent {
  return {
    type: 'tool_requested',
    toolRequests: toolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argumentsJson: toolCall.argumentsJson,
    })),
  };
}

function isParallelToolCall(toolCall: AgentModelToolCall): boolean {
  const toolDefinition = agentToolRegistry.get(toolCall.name);

  return toolDefinition?.executionMode === 'parallel';
}

function chooseToolBatchExecutionMode(
  toolCalls: AgentModelToolCall[],
): AgentToolExecutionMode {
  if (toolCalls.length === 0) {
    return 'sequential';
  }

  if (toolCalls.every((toolCall) => isParallelToolCall(toolCall))) {
    return 'parallel';
  }

  return 'sequential';
}

async function executeToolCallsSequentially(
  toolCalls: AgentModelToolCall[],
  context: AgentRunContext,
  callbacks: AgentToolSchedulerCallbacks,
): Promise<AgentToolExecution[]> {
  const toolExecutions: AgentToolExecution[] = [];

  for (const toolCall of toolCalls) {
    assertAgentRunNotAborted(context);
    const toolExecution = await executeAgentToolCall(
      toolCall,
      context,
      callbacks,
    );
    toolExecutions.push(toolExecution);
  }

  return toolExecutions;
}

async function executeToolCallsInParallel(
  toolCalls: AgentModelToolCall[],
  context: AgentRunContext,
  callbacks: AgentToolSchedulerCallbacks,
): Promise<AgentToolExecution[]> {
  const toolExecutionPromises = toolCalls.map((toolCall) =>
    executeAgentToolCall(toolCall, context, callbacks),
  );

  return Promise.all(toolExecutionPromises);
}

export async function executeAgentToolBatch(
  toolCalls: AgentModelToolCall[],
  context: AgentRunContext,
  callbacks: AgentToolSchedulerCallbacks = {},
): Promise<AgentToolBatchExecution> {
  assertAgentRunNotAborted(context);
  callbacks.onEvent?.(createToolRequestEvent(toolCalls));

  const executionMode = chooseToolBatchExecutionMode(toolCalls);
  const toolExecutions =
    executionMode === 'parallel'
      ? await executeToolCallsInParallel(toolCalls, context, callbacks)
      : await executeToolCallsSequentially(toolCalls, context, callbacks);

  return {
    executionMode: executionMode,
    toolExecutions: toolExecutions,
  };
}
