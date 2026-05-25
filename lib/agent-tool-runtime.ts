import type { AgentModelToolCall } from './agent-model-types';
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

function createToolStartedEvent(toolCall: AgentModelToolCall): AgentEvent {
  return {
    type: 'tool_started',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argumentsJson: toolCall.argumentsJson,
  };
}

function createToolFinishedEvent(execution: AgentToolExecution): AgentEvent {
  return {
    type: 'tool_finished',
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    input: execution.input,
    result: execution.result,
    isError: execution.isError,
  };
}

function createPermissionRequest(
  toolCall: AgentModelToolCall,
  toolDefinition: AgentToolDefinition,
  context: AgentRunContext,
): AgentPermissionRequest {
  return {
    toolCallId: toolCall.id,
    toolName: toolDefinition.name,
    argumentsJson: toolCall.argumentsJson,
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

function createErroredToolExecution(
  toolCall: AgentModelToolCall,
  error: unknown,
): AgentToolExecution {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    input: {
      argumentsJson: toolCall.argumentsJson,
    },
    result: error instanceof Error ? error.message : String(error),
    isError: true,
  };
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

export async function executeAgentToolCall(
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
  callbacks: AgentToolRuntimeCallbacks = {},
): Promise<AgentToolExecution> {
  assertAgentRunNotAborted(context);

  const toolDefinition = agentToolRegistry.get(toolCall.name);

  if (toolDefinition === undefined) {
    const execution = createErroredToolExecution(
      toolCall,
      `Unknown agent tool: ${toolCall.name}`,
    );
    callbacks.onEvent?.(createToolFinishedEvent(execution));

    return execution;
  }

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

  let execution: AgentToolExecution;
  try {
    const toolResult = await toolDefinition.execute(
      toolCall.argumentsJson,
      context.signal,
    );
    execution = {
      toolCallId: toolCall.id,
      toolName: toolDefinition.name,
      input: toolResult.input,
      result: toolResult.result,
      isError: false,
    };
  } catch (error) {
    execution = createErroredToolExecution(toolCall, error);
  }

  assertAgentRunNotAborted(context);
  callbacks.onEvent?.(createToolFinishedEvent(execution));

  return execution;
}

export async function executeAgentToolCalls(
  toolCalls: AgentModelToolCall[],
  context: AgentRunContext,
  callbacks: AgentToolRuntimeCallbacks = {},
): Promise<AgentToolExecution[]> {
  assertAgentRunNotAborted(context);
  callbacks.onEvent?.(createToolRequestEvent(toolCalls));

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
