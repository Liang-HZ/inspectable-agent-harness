import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions';

import type { AgentEvent } from './agent-events';
import {
  AgentApprovalRequiredError,
  AgentPermissionDeniedError,
  decideAgentToolPermission,
  type AgentPermissionDecision,
  type AgentPermissionRequest,
} from './agent-permissions';
import type { AgentRunContext } from './agent-run-context';
import { assertAgentRunNotAborted } from './agent-run-context';
import {
  agentToolRegistry,
  type AgentToolDefinition,
  type AgentToolExecution,
} from './agent-tools';

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

function createPermissionRequest(
  toolCall: ChatCompletionMessageFunctionToolCall,
  toolDefinition: AgentToolDefinition,
  context: AgentRunContext,
): AgentPermissionRequest {
  return {
    toolCallId: toolCall.id,
    toolName: toolDefinition.name,
    argumentsJson: toolCall.function.arguments,
    annotations: toolDefinition.annotations,
    approvalPolicy: context.policy.approvalPolicy,
    sandboxMode: context.policy.sandboxMode,
  };
}

function createToolPermissionDecidedEvent(
  request: AgentPermissionRequest,
  decision: AgentPermissionDecision,
): AgentEvent {
  return {
    type: 'tool_permission_decided',
    request: request,
    decision: decision,
  };
}

function createApprovalRequestedEvent(
  request: AgentPermissionRequest,
  decision: AgentPermissionDecision,
): AgentEvent {
  return {
    type: 'approval_requested',
    request: request,
    decision: decision,
  };
}

function readAgentToolDefinition(toolName: string): AgentToolDefinition {
  const toolDefinition = agentToolRegistry.get(toolName);

  if (toolDefinition === undefined) {
    throw new Error(`Unknown agent tool: ${toolName}`);
  }

  return toolDefinition;
}

function assertToolPermissionCanContinue(
  request: AgentPermissionRequest,
  decision: AgentPermissionDecision,
): void {
  if (decision.type === 'deny') {
    throw new AgentPermissionDeniedError(request, decision);
  }

  if (decision.type === 'ask') {
    throw new AgentApprovalRequiredError(request, decision);
  }
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

    const toolDefinition = readAgentToolDefinition(toolCall.function.name);
    const permissionRequest = createPermissionRequest(
      toolCall,
      toolDefinition,
      context,
    );
    const permissionDecision = decideAgentToolPermission(permissionRequest);
    callbacks.onEvent?.(
      createToolPermissionDecidedEvent(permissionRequest, permissionDecision),
    );

    if (permissionDecision.type === 'ask') {
      callbacks.onEvent?.(
        createApprovalRequestedEvent(permissionRequest, permissionDecision),
      );
    }

    assertToolPermissionCanContinue(permissionRequest, permissionDecision);
    assertAgentRunNotAborted(context);
    callbacks.onEvent?.(createToolStartedEvent(toolCall));

    const toolResult = toolDefinition.execute(toolCall.function.arguments);
    const toolExecution: AgentToolExecution = {
      toolCallId: toolCall.id,
      toolName: toolDefinition.name,
      input: toolResult.input,
      result: toolResult.result,
    };

    assertAgentRunNotAborted(context);
    callbacks.onEvent?.(createToolFinishedEvent(toolExecution));
    toolExecutions.push(toolExecution);
  }

  return toolExecutions;
}
