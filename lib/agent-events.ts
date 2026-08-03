import type {
  AgentResult,
  AgentStep,
  AgentTokenUsage,
  AgentUsage,
} from './agent-api-types';
import type { AgentModelStage } from './agent-model-stages';
import type {
  AgentModelAssistantMessage,
  AgentModelRequest,
  AgentModelToolCall,
  AgentModelUsageSnapshot,
  AgentModelWireApi,
} from './agent-model-types';
import type { AgentApprovalResolution } from './agent-approvals';
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunPolicy,
} from './agent-permissions';
import type { AgentSpanContext, AgentSpanTiming } from './agent-trace';

export type AgentRunStatus =
  | 'running'
  | 'waiting_for_model'
  | 'running_tool'
  | 'waiting_for_approval'
  | 'streaming_assistant'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type AgentToolRequestEvent = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
};

/**
 * Span fields are optional on every event because session files written before
 * tracing existed have none. Anything that reads persisted records has to
 * degrade when they are absent — the waterfall simply cannot be drawn for an
 * old run. Live emitters always populate them; that is enforced by tests rather
 * than by the type, so that the type stays honest about what is on disk.
 */
export type AgentEventSpanFields = {
  span?: AgentSpanContext;
};

export type AgentEventSpanStart = AgentEventSpanFields & {
  startedAt?: string;
};

export type AgentEventSpanEnd = AgentEventSpanFields & {
  timing?: AgentSpanTiming;
};

export type AgentEvent =
  | ({
      type: 'run_started';
      runId: string;
      sessionId: string;
      resumed: boolean;
      policy: AgentRunPolicy;
      /** 0 for a top-level run; > 0 identifies a derived subagent run. */
      spawnDepth?: number;
    } & AgentEventSpanStart)
  | {
      type: 'step_created';
      step: AgentStep;
    }
  | {
      type: 'model_started';
      stage: AgentModelStage;
    }
  | ({
      type: 'model_requested';
      round: number;
      model: string;
      wireApi: AgentModelWireApi;
      request: AgentModelRequest;
    } & AgentEventSpanStart)
  | ({
      type: 'model_completed';
      round: number;
      model: string;
      streamedAssistantText: string;
      assistantMessages: AgentModelAssistantMessage[];
      toolCalls: AgentModelToolCall[];
      usage: AgentModelUsageSnapshot;
    } & AgentEventSpanEnd)
  | {
      type: 'assistant_delta';
      delta: string;
    }
  | {
      type: 'tool_requested';
      toolRequests: AgentToolRequestEvent[];
    }
  | ({
      type: 'tool_started';
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
    } & AgentEventSpanStart)
  | ({
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      input: unknown;
      result: unknown;
      modelOutput: string;
      isError: boolean;
      /**
       * Set when the tool call spawned a subagent: points at the session file
       * holding that derived run. This is the on-disk half of the parent/child
       * link — the span half is `span.parentSpanId` on the subagent's
       * `run_started`.
       */
      subagentSessionId?: string;
    } & AgentEventSpanEnd)
  | {
      type: 'tool_permission_decided';
      request: AgentPermissionRequest;
      decision: AgentPermissionDecision;
    }
  | {
      type: 'approval_requested';
      runId: string;
      request: AgentPermissionRequest;
      decision: AgentPermissionDecision;
    }
  | {
      type: 'approval_resolved';
      runId: string;
      toolCallId: string;
      toolName: string;
      resolution: AgentApprovalResolution;
    }
  | {
      type: 'history_compacted';
      reason: string;
      tokenUsageBeforeCompaction: AgentTokenUsage;
      removedItemCount: number;
      keptItemCount: number;
      summary: string;
    }
  | {
      type: 'run_succeeded';
      result: AgentResult;
    }
  | {
      type: 'run_failed';
      error: string;
    }
  | {
      type: 'run_cancelled';
      reason: string;
    };

export type AgentRunState = {
  runId: string;
  sessionId: string | undefined;
  status: AgentRunStatus;
  events: AgentEvent[];
  steps: AgentStep[];
  answer: string;
  model: string | undefined;
  policy: AgentRunPolicy | undefined;
  usage: AgentUsage | undefined;
  error: string | undefined;
};

export function createAgentRunState(runId: string): AgentRunState {
  return {
    runId: runId,
    sessionId: undefined,
    status: 'running',
    events: [],
    steps: [],
    answer: '',
    model: undefined,
    policy: undefined,
    usage: undefined,
    error: undefined,
  };
}

export function applyAgentEvent(
  state: AgentRunState,
  event: AgentEvent,
): AgentRunState {
  const events = [...state.events, event];

  if (event.type === 'run_started') {
    return {
      ...state,
      status: 'running',
      events: events,
      sessionId: event.sessionId,
      policy: event.policy,
    };
  }

  if (event.type === 'step_created') {
    return {
      ...state,
      events: events,
      steps: [...state.steps, event.step],
    };
  }

  if (event.type === 'model_started') {
    return {
      ...state,
      status:
        event.stage === 'answer_generation'
          ? 'streaming_assistant'
          : 'waiting_for_model',
      events: events,
    };
  }

  if (event.type === 'model_requested') {
    return {
      ...state,
      status: 'waiting_for_model',
      events: events,
    };
  }

  if (event.type === 'model_completed') {
    return {
      ...state,
      status:
        event.toolCalls.length > 0 ? 'running_tool' : 'streaming_assistant',
      events: events,
    };
  }

  if (event.type === 'assistant_delta') {
    return {
      ...state,
      status: 'streaming_assistant',
      events: events,
    };
  }

  if (event.type === 'tool_requested') {
    return {
      ...state,
      status: 'running_tool',
      events: events,
    };
  }

  if (event.type === 'tool_started') {
    return {
      ...state,
      status: 'running_tool',
      events: events,
    };
  }

  if (event.type === 'tool_finished') {
    return {
      ...state,
      status: 'running_tool',
      events: events,
    };
  }

  if (event.type === 'tool_permission_decided') {
    return {
      ...state,
      status: 'running_tool',
      events: events,
    };
  }

  if (event.type === 'approval_requested') {
    return {
      ...state,
      status: 'waiting_for_approval',
      events: events,
    };
  }

  if (event.type === 'approval_resolved') {
    return {
      ...state,
      status: 'running_tool',
      events: events,
    };
  }

  if (event.type === 'history_compacted') {
    return {
      ...state,
      events: events,
    };
  }

  if (event.type === 'run_succeeded') {
    return {
      ...state,
      status: 'succeeded',
      events: events,
      answer: event.result.answer,
      model: event.result.model,
      usage: event.result.usage,
      error: undefined,
    };
  }

  if (event.type === 'run_failed') {
    return {
      ...state,
      status: 'failed',
      events: events,
      error: event.error,
    };
  }

  return {
    ...state,
    status: 'cancelled',
    events: events,
    error: event.reason,
  };
}
