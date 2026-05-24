import type {
  AgentModelCallUsage,
  AgentTokenUsage,
  AgentUsage,
} from './agent-api-types';
import type { AgentModelStage } from './agent-model-stages';

export function createEmptyAgentTokenUsage(): AgentTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export function addAgentTokenUsage(
  left: AgentTokenUsage,
  right: AgentTokenUsage,
): AgentTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function createAgentModelCallUsage(
  stage: AgentModelStage,
  tokenUsage: AgentTokenUsage | null,
  rawUsage: unknown,
): AgentModelCallUsage {
  return {
    stage: stage,
    tokenUsage: tokenUsage,
    rawUsage: rawUsage,
  };
}

export function createAgentUsage(calls: AgentModelCallUsage[]): AgentUsage {
  let totalTokenUsage = createEmptyAgentTokenUsage();
  let lastTokenUsage: AgentTokenUsage | null = null;

  for (const call of calls) {
    if (call.tokenUsage === null) {
      continue;
    }

    totalTokenUsage = addAgentTokenUsage(totalTokenUsage, call.tokenUsage);
    lastTokenUsage = call.tokenUsage;
  }

  return {
    totalTokenUsage: totalTokenUsage,
    lastTokenUsage: lastTokenUsage,
    calls: calls,
  };
}
