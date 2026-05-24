import type { AgentStep } from './agent-api-types';
import type { AgentEvent } from './agent-events';
import type { AgentInput } from './agent-input';
import type { ModelConfig } from './env';

type AgentLogFields = Record<string, unknown>;

function writeAgentLog(
  level: 'info' | 'error',
  runId: string,
  event: string,
  fields: AgentLogFields,
): void {
  const logRecord = {
    level: level,
    scope: 'agent',
    runId: runId,
    event: event,
    ...fields,
  };

  if (level === 'error') {
    console.error(JSON.stringify(logRecord));
    return;
  }

  console.info(JSON.stringify(logRecord));
}

export function logAgentInfo(
  runId: string,
  event: string,
  fields: AgentLogFields = {},
): void {
  writeAgentLog('info', runId, event, fields);
}

export function logAgentError(
  runId: string,
  event: string,
  fields: AgentLogFields = {},
): void {
  writeAgentLog('error', runId, event, fields);
}

export function logAgentInput(runId: string, input: AgentInput): void {
  logAgentInfo(runId, 'input_validated', {
    task: input.task,
    taskLength: input.task.length,
    goal: input.goal,
    hasGoal: input.goal !== undefined,
    goalLength: input.goal === undefined ? 0 : input.goal.length,
    context: input.context,
    hasContext: input.context !== undefined,
    contextLength: input.context === undefined ? 0 : input.context.length,
    modelOverride: input.model,
    hasModelOverride: input.model !== undefined,
    temperature: input.temperature,
  });
}

export function logAgentModelConfig(runId: string, config: ModelConfig): void {
  logAgentInfo(runId, 'model_config_loaded', {
    baseURL: config.baseURL,
    model: config.model,
  });
}

export function logAgentStep(runId: string, step: AgentStep): void {
  logAgentInfo(runId, 'step', {
    order: step.order,
    title: step.title,
    detail: step.detail,
    output: step.output,
  });
}

export function logAgentEvent(runId: string, event: AgentEvent): void {
  logAgentInfo(runId, 'runtime_event', {
    runtimeEvent: event,
  });
}
