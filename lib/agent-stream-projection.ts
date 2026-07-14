import type { AgentStreamEvent } from './agent-api-types';
import type { AgentEvent } from './agent-events';

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
