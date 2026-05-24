import type { AgentResult, AgentStep } from './agent-api-types';

export type AgentRunStatus =
  | 'running'
  | 'waiting_for_model'
  | 'running_tool'
  | 'streaming_answer'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AgentModelStage = 'tool_or_answer_selection' | 'answer_generation';

export type AgentToolRequestEvent = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
};

export type AgentEvent =
  | {
      type: 'run_started';
      runId: string;
    }
  | {
      type: 'step_created';
      step: AgentStep;
    }
  | {
      type: 'model_started';
      stage: AgentModelStage;
    }
  | {
      type: 'model_delta';
      delta: string;
    }
  | {
      type: 'tool_requested';
      toolRequests: AgentToolRequestEvent[];
    }
  | {
      type: 'tool_started';
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
    }
  | {
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      input: unknown;
      result: unknown;
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
  status: AgentRunStatus;
  events: AgentEvent[];
  steps: AgentStep[];
  answer: string;
  model: string | undefined;
  usage: unknown;
  error: string | undefined;
};

export function createAgentRunState(runId: string): AgentRunState {
  return {
    runId: runId,
    status: 'running',
    events: [],
    steps: [],
    answer: '',
    model: undefined,
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
          ? 'streaming_answer'
          : 'waiting_for_model',
      events: events,
    };
  }

  if (event.type === 'model_delta') {
    return {
      ...state,
      status: 'streaming_answer',
      events: events,
      answer: state.answer + event.delta,
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
