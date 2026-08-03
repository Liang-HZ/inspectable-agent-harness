import type { AgentModelToolCall } from './agent-model-types';
import type { AgentEvent } from './agent-events';
import {
  type AgentApprovalResolution,
  waitForAgentApproval,
} from './agent-approvals';
import {
  AgentApprovalRequiredError,
  decideAgentToolPermission,
  resolveAgentPathAccessForRunPolicy,
  type AgentPermissionDecision,
  type AgentPermissionRequest,
} from './agent-permissions';
import type { AgentRunContext } from './agent-run-context';
import {
  assertAgentRunNotAborted,
  hasAgentFileReadRecord,
  markAgentFileRead,
} from './agent-run-context';
import { decideAgentToolPathAccess } from './agent-path-policy';
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
import { DEFAULT_AGENT_TOOL_TIMEOUT_MS } from './agent-tool-contracts';
import {
  createChildSpanContext,
  createSpanTiming,
  type AgentSpanContext,
} from './agent-trace';
import type { AgentSubagentToolSpawner } from './agent-subagent';

type AgentToolRuntimeCallbacks = {
  onEvent?: (event: AgentEvent) => void;
};

function createToolStartedEvent(
  toolCall: AgentModelToolCall,
  span: AgentSpanContext,
  startedAtMs: number,
): AgentEvent {
  return {
    type: 'tool_started',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argumentsJson: toolCall.argumentsJson,
    span: span,
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

/**
 * Note that `tool_finished` is also emitted on paths where the tool never ran —
 * unknown tool, permission denial, approval denial. Those still carry a
 * well-formed span: a span is a single record with both ends, so a rejected
 * call shows up in the waterfall as a short bar rather than vanishing. That is
 * deliberate; "why is nothing here?" is the hardest question to answer from a
 * trace.
 */
function createToolFinishedEvent(
  execution: AgentToolExecution,
  span: AgentSpanContext,
  startedAtMs: number,
): AgentEvent {
  return {
    type: 'tool_finished',
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    input: execution.input,
    result: execution.output,
    modelOutput: execution.modelOutput,
    isError: execution.isError,
    subagentSessionId: execution.subagentSessionId,
    span: span,
    timing: createSpanTiming(startedAtMs, Date.now()),
  };
}

function createPermissionRequest(
  toolCall: AgentModelToolCall,
  toolDefinition: AgentToolDefinition,
  context: AgentRunContext,
): AgentPermissionRequest {
  const pathArgumentName = toolDefinition.permissionInput?.pathArgumentName;
  const requestedPath = readPermissionPathArgument(toolCall, pathArgumentName);
  const pathAccess = resolveAgentPathAccessForRunPolicy(
    toolDefinition.pathAccess,
    context.policy.sandboxMode,
  );
  const pathDecision =
    requestedPath === undefined
      ? undefined
      : decideAgentToolPathAccess(requestedPath, pathAccess);
  const resolvedPath =
    pathDecision?.type === 'allow' ? pathDecision.path.absolutePath : undefined;
  const requiresPriorRead =
    toolDefinition.permissionInput?.requiresPriorRead === true;

  return {
    toolCallId: toolCall.id,
    toolName: toolDefinition.name,
    argumentsJson: toolCall.argumentsJson,
    annotations: toolDefinition.annotations,
    source: toolDefinition.source,
    group: toolDefinition.group,
    category: toolDefinition.category,
    declaredPathAccess: toolDefinition.pathAccess,
    pathAccess: pathAccess,
    pathArgumentName: pathArgumentName,
    requestedPath: requestedPath,
    resolvedPath: resolvedPath,
    recordsReadPath: toolDefinition.permissionInput?.recordsReadPath === true,
    requiresPriorRead: requiresPriorRead,
    priorReadSatisfied:
      resolvedPath === undefined
        ? undefined
        : hasAgentFileReadRecord(context, resolvedPath),
    executionMode: toolDefinition.executionMode,
    approvalPolicy: context.policy.approvalPolicy,
    sandboxMode: context.policy.sandboxMode,
  };
}

function readPermissionPathArgument(
  toolCall: AgentModelToolCall,
  pathArgumentName: string | undefined,
): string | undefined {
  if (pathArgumentName === undefined) {
    return undefined;
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.argumentsJson);
  } catch {
    return undefined;
  }

  if (
    typeof parsedArguments !== 'object' ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    return undefined;
  }

  const value = (parsedArguments as Record<string, unknown>)[pathArgumentName];

  return typeof value === 'string' ? value : undefined;
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
  context: AgentRunContext,
): AgentEvent {
  return {
    type: 'approval_requested',
    runId: context.runId,
    request: request,
    decision: decision,
  };
}

function createApprovalResolvedEvent(
  request: AgentPermissionRequest,
  resolution: AgentApprovalResolution,
  context: AgentRunContext,
): AgentEvent {
  return {
    type: 'approval_resolved',
    runId: context.runId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    resolution: resolution,
  };
}

function formatApprovalDeniedMessage(
  resolution: Extract<AgentApprovalResolution, { type: 'denied' }>,
): string {
  return `${resolution.reason} The action was not performed. Do not retry the same call; take a different approach or explain what you need in the final answer.`;
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

function decideAgentToolPermissionWithToolOverride(
  request: AgentPermissionRequest,
  toolDefinition: AgentToolDefinition,
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
): AgentPermissionDecision {
  const genericDecision = decideAgentToolPermission(request);

  // A generic deny (path policy, prior-read requirement, read-only writes)
  // stays authoritative. Tool overrides can only refine allow/ask decisions.
  if (genericDecision.type === 'deny') {
    return genericDecision;
  }

  const overrideDecision = toolDefinition.decidePermission?.(
    toolCall.argumentsJson,
    context.policy,
  );

  return overrideDecision ?? genericDecision;
}

async function waitForInteractiveToolApproval(
  request: AgentPermissionRequest,
  decision: Extract<AgentPermissionDecision, { type: 'ask' }>,
  context: AgentRunContext,
): Promise<AgentApprovalResolution> {
  if (context.approvalMode !== 'interactive') {
    // Non-interactive runs have no approval channel, so an ask decision
    // stays fail-closed exactly like before approval resume existed.
    throw new AgentApprovalRequiredError(request, decision);
  }

  return waitForAgentApproval({
    runId: context.runId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    argumentsJson: request.argumentsJson,
    reason: decision.reason,
    signal: context.signal,
  });
}

/**
 * Binds the run's subagent spawner to one tool call. The tool itself is never
 * told its own call id or span — the runtime closes over them here, so `task`
 * stays a plain tool that asks for a subagent and gets an answer, while the
 * parent/child join key stays an invariant of the runtime.
 */
function bindSubagentSpawner(
  context: AgentRunContext,
  toolCall: AgentModelToolCall,
  toolSpan: AgentSpanContext,
): AgentSubagentToolSpawner | undefined {
  const spawnSubagent = context.spawnSubagent;

  if (spawnSubagent === undefined) {
    return undefined;
  }

  return (request) =>
    spawnSubagent({
      ...request,
      toolCallId: toolCall.id,
      parentSpan: toolSpan,
    });
}

async function executeToolWithRuntimeLimits(
  toolDefinition: AgentToolDefinition,
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
  toolSpan: AgentSpanContext,
): Promise<AgentToolResult> {
  const timeoutMs = toolDefinition.timeoutMs;
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
        {
          pathAccess: resolveAgentPathAccessForRunPolicy(
            toolDefinition.pathAccess,
            context.policy.sandboxMode,
          ),
          sandboxMode: context.policy.sandboxMode,
          spawnSubagent: bindSubagentSpawner(context, toolCall, toolSpan),
        },
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
    subagentSessionId: toolResult.subagentSessionId,
  };
}

function recordToolStateAfterSuccessfulExecution(
  context: AgentRunContext,
  request: AgentPermissionRequest,
  execution: AgentToolExecution,
): void {
  if (execution.isError) {
    return;
  }

  if (!request.recordsReadPath) {
    return;
  }

  if (request.resolvedPath === undefined) {
    return;
  }

  markAgentFileRead(context, request.resolvedPath);
}

export async function executeAgentToolCall(
  toolCall: AgentModelToolCall,
  context: AgentRunContext,
  callbacks: AgentToolRuntimeCallbacks = {},
): Promise<AgentToolExecution> {
  assertAgentRunNotAborted(context);

  const toolDefinition = agentToolRegistry.get(toolCall.name);
  const startedAt = Date.now();
  // One span per tool call, hanging off the run's root span. A `task` call
  // becomes the parent of the subagent run's own root span, which is how a
  // derived run in a separate session file still lands in this waterfall.
  const toolSpan = createChildSpanContext(context.span);

  if (toolDefinition === undefined) {
    const execution = createErroredToolExecution(
      toolCall,
      createRespondToModelToolOutput(
        'TOOL_NOT_FOUND',
        `Unknown agent tool: ${toolCall.name}`,
      ),
      Date.now() - startedAt,
    );
    callbacks.onEvent?.(createToolFinishedEvent(execution, toolSpan, startedAt));

    return execution;
  }

  const permissionRequest = createPermissionRequest(
    toolCall,
    toolDefinition,
    context,
  );
  const permissionDecision = decideAgentToolPermissionWithToolOverride(
    permissionRequest,
    toolDefinition,
    toolCall,
    context,
  );
  callbacks.onEvent?.(
    createToolPermissionDecidedEvent(permissionRequest, permissionDecision),
  );

  if (permissionDecision.type === 'deny') {
    const execution = createErroredToolExecution(
      toolCall,
      createRespondToModelToolOutput(
        permissionDecision.errorCode,
        permissionDecision.reason,
      ),
      Date.now() - startedAt,
    );
    callbacks.onEvent?.(createToolFinishedEvent(execution, toolSpan, startedAt));

    return execution;
  }

  if (permissionDecision.type === 'ask') {
    callbacks.onEvent?.(
      createApprovalRequestedEvent(permissionRequest, permissionDecision, context),
    );
    const resolution = await waitForInteractiveToolApproval(
      permissionRequest,
      permissionDecision,
      context,
    );
    callbacks.onEvent?.(
      createApprovalResolvedEvent(permissionRequest, resolution, context),
    );

    if (resolution.type === 'denied') {
      const execution = createErroredToolExecution(
        toolCall,
        createRespondToModelToolOutput(
          'APPROVAL_DENIED',
          formatApprovalDeniedMessage(resolution),
        ),
        Date.now() - startedAt,
      );
      callbacks.onEvent?.(createToolFinishedEvent(execution, toolSpan, startedAt));

      return execution;
    }
  }

  assertAgentRunNotAborted(context);
  callbacks.onEvent?.(createToolStartedEvent(toolCall, toolSpan, startedAt));

  let execution: AgentToolExecution;
  try {
    const toolResult = await executeToolWithRuntimeLimits(
      toolDefinition,
      toolCall,
      context,
      toolSpan,
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

  recordToolStateAfterSuccessfulExecution(
    context,
    permissionRequest,
    execution,
  );
  callbacks.onEvent?.(createToolFinishedEvent(execution, toolSpan, startedAt));

  return execution;
}
