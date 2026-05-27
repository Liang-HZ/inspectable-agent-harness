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

    case 'run_started':
    case 'model_started':
    case 'tool_requested':
    case 'tool_permission_decided':
    case 'approval_requested':
    case 'tool_started':
    case 'tool_finished':
    case 'run_cancelled':
      return undefined;
  }
}
