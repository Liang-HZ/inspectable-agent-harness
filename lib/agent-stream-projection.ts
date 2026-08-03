import type { AgentStreamEvent } from './agent-api-types';
import type { AgentEvent } from './agent-events';

/**
 * Spreads only the trace fields that are actually set.
 *
 * An event replayed from a session file written before tracing existed carries
 * no span, and for those the projection has to produce exactly what it produced
 * before — otherwise every consumer downstream would have to learn to ignore an
 * explicit `span: undefined`, and the old on-the-wire contract would quietly
 * change for every existing session.
 */
function definedTraceFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function projectAgentEventToStreamEvent(
  event: AgentEvent,
): AgentStreamEvent | undefined {
  switch (event.type) {
    case 'step_created':
      return {
        type: 'step',
        step: event.step,
      };

    case 'assistant_delta':
      return {
        type: 'assistantDelta',
        delta: event.delta,
      };

    case 'run_started':
      return {
        type: 'debug',
        event: {
          type: 'runStarted',
          runId: event.runId,
          sessionId: event.sessionId,
          resumed: event.resumed,
          policy: event.policy,
          ...definedTraceFields({
            spawnDepth: event.spawnDepth,
            span: event.span,
            startedAt: event.startedAt,
          }),
        },
      };

    case 'model_started':
      return {
        type: 'debug',
        event: {
          type: 'modelStarted',
          stage: event.stage,
        },
      };

    case 'model_requested':
      return {
        type: 'debug',
        event: {
          type: 'modelRequested',
          round: event.round,
          model: event.model,
          wireApi: event.wireApi,
          request: event.request,
          ...definedTraceFields({
            span: event.span,
            startedAt: event.startedAt,
          }),
        },
      };

    case 'model_completed':
      return {
        type: 'debug',
        event: {
          type: 'modelCompleted',
          round: event.round,
          model: event.model,
          streamedAssistantText: event.streamedAssistantText,
          assistantMessages: event.assistantMessages,
          toolCalls: event.toolCalls,
          usage: event.usage,
          ...definedTraceFields({
            span: event.span,
            timing: event.timing,
          }),
        },
      };

    case 'tool_requested':
      return {
        type: 'debug',
        event: {
          type: 'toolRequested',
          toolRequests: event.toolRequests,
        },
      };

    case 'tool_started':
      return {
        type: 'debug',
        event: {
          type: 'toolStarted',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argumentsJson: event.argumentsJson,
          ...definedTraceFields({
            span: event.span,
            startedAt: event.startedAt,
          }),
        },
      };

    case 'tool_finished':
      return {
        type: 'debug',
        event: {
          type: 'toolFinished',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          result: event.result,
          modelOutput: event.modelOutput,
          isError: event.isError,
          ...definedTraceFields({
            subagentSessionId: event.subagentSessionId,
            span: event.span,
            timing: event.timing,
          }),
        },
      };

    case 'tool_permission_decided':
      return {
        type: 'debug',
        event: {
          type: 'toolPermissionDecided',
          request: event.request,
          decision: event.decision,
        },
      };

    case 'approval_requested':
      return {
        type: 'approvalRequired',
        request: {
          runId: event.runId,
          toolCallId: event.request.toolCallId,
          toolName: event.request.toolName,
          argumentsJson: event.request.argumentsJson,
          reason: event.decision.reason,
        },
      };

    case 'approval_resolved':
      return {
        type: 'approvalResolved',
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resolution: event.resolution,
      };

    case 'history_compacted':
      return {
        type: 'debug',
        event: {
          type: 'historyCompacted',
          reason: event.reason,
          tokenUsageBeforeCompaction: event.tokenUsageBeforeCompaction,
          removedItemCount: event.removedItemCount,
          keptItemCount: event.keptItemCount,
          summary: event.summary,
        },
      };

    case 'run_succeeded':
      return {
        type: 'done',
        result: event.result,
      };

    case 'run_failed':
      return {
        type: 'error',
        error: event.error,
      };

    case 'run_cancelled':
      return {
        type: 'debug',
        event: {
          type: 'runCancelled',
          reason: event.reason,
        },
      };
  }
}
