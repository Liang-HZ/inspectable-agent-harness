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
  AgentToolFatalError,
  createRespondToModelToolOutput,
  createToolOutputFromThrownError,
  serializeAgentToolOutputForModel,
  type AgentToolOutput,
} from './agent-tool-output';
import {
  agentToolRegistry,
  type AgentToolDefinition,
  type AgentToolExecution,
  type AgentToolResult,
} from './agent-tools';

type AgentToolRuntimeCallbacks = {
  onEvent?: (event: AgentEvent) => void;
};

const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 10_000;

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
    result: execution.output,
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
  output: AgentToolOutput,
  durationMs: number,
): AgentToolExecution {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    input: {
      argumentsJson: toolCall.argumentsJson,
    },
    output: output,
    modelOutput: serializeAgentToolOutputForModel(output),
    isError: true,
    durationMs: durationMs,
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

async function executeToolWithRuntimeLimits(
  toolDefinition: AgentToolDefinition,
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
): Promise<AgentToolResult> {
  const timeoutMs = toolDefinition.timeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  const toolAbortController = new AbortController();

  return new Promise<AgentToolResult>((resolve, reject) => {
    let settled = false;

    function settleWithResult(result: AgentToolResult): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    }

    function settleWithError(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function timeoutToolCall(): void {
      toolAbortController.abort();
      settleWithResult({
        input: {
          argumentsJson: toolCall.argumentsJson,
        },
        output: createRespondToModelToolOutput(
          'TIMEOUT',
          `Tool \`${toolDefinition.name}\` timed out after ${timeoutMs}ms.`,
        ),
      });
    }

    function abortToolCall(): void {
      toolAbortController.abort();
      settleWithResult({
        input: {
          argumentsJson: toolCall.argumentsJson,
        },
        output: createRespondToModelToolOutput(
          'ABORTED',
          `Tool \`${toolDefinition.name}\` was aborted by the run signal.`,
        ),
      });
    }

    function cleanup(): void {
      clearTimeout(timeoutHandle);
      context.signal?.removeEventListener('abort', abortToolCall);
    }

    const timeoutHandle = setTimeout(timeoutToolCall, timeoutMs);

    if (context.signal?.aborted) {
      abortToolCall();
      return;
    }

    context.signal?.addEventListener('abort', abortToolCall, { once: true });

    Promise.resolve(
      toolDefinition.execute(
        toolCall.argumentsJson,
        toolAbortController.signal,
      ),
    ).then(settleWithResult, settleWithError);
  });
}

function createToolExecution(
  toolCall: AgentModelToolCall,
  toolName: string,
  toolResult: AgentToolResult,
  durationMs: number,
): AgentToolExecution {
  const modelOutput = serializeAgentToolOutputForModel(toolResult.output);

  return {
    toolCallId: toolCall.id,
    toolName: toolName,
    input: toolResult.input,
    output: toolResult.output,
    modelOutput: modelOutput,
    isError: toolResult.output.type !== 'success',
    durationMs: durationMs,
  };
}

export async function executeAgentToolCall(
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
  callbacks: AgentToolRuntimeCallbacks = {},
): Promise<AgentToolExecution> {
  assertAgentRunNotAborted(context);

  const toolDefinition = agentToolRegistry.get(toolCall.name);
  const startedAt = Date.now();

  if (toolDefinition === undefined) {
    const execution = createErroredToolExecution(
      toolCall,
      createRespondToModelToolOutput(
        'TOOL_NOT_FOUND',
        `Unknown agent tool: ${toolCall.name}`,
      ),
      Date.now() - startedAt,
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
    const toolResult = await executeToolWithRuntimeLimits(
      toolDefinition,
      toolCall,
      context,
    );
    if (toolResult.output.type === 'fatal') {
      throw new AgentToolFatalError(
        toolResult.output.error.code,
        toolResult.output.error.message,
        toolResult.output.details,
      );
    }

    execution = createToolExecution(
      toolCall,
      toolDefinition.name,
      toolResult,
      Date.now() - startedAt,
    );
  } catch (error) {
    const output = createToolOutputFromThrownError(error);

    if (output.type === 'fatal') {
      throw new AgentToolFatalError(
        output.error.code,
        output.error.message,
        output.details,
      );
    }

    execution = createErroredToolExecution(
      toolCall,
      output,
      Date.now() - startedAt,
    );
  }

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
