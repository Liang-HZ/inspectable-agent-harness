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

function sumNullableTokenCounts(
  totalValue: number | null,
  nextValue: number | null,
): number | null {
  if (totalValue === null || nextValue === null) {
    return null;
  }

  return totalValue + nextValue;
}

function sumAgentTokenUsages(usages: AgentTokenUsage[]): AgentTokenUsage {
  return usages.reduce(
    (totalUsage, usage) => ({
      inputTokens: totalUsage.inputTokens + usage.inputTokens,
      cachedInputTokens: sumNullableTokenCounts(
        totalUsage.cachedInputTokens,
        usage.cachedInputTokens,
      ),
      outputTokens: totalUsage.outputTokens + usage.outputTokens,
      reasoningOutputTokens:
        totalUsage.reasoningOutputTokens + usage.reasoningOutputTokens,
      totalTokens: totalUsage.totalTokens + usage.totalTokens,
    }),
    createEmptyAgentTokenUsage(),
  );
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
  const callTokenUsages: AgentTokenUsage[] = [];
  let lastTokenUsage: AgentTokenUsage | null = null;

  for (const call of calls) {
    if (call.tokenUsage === null) {
      continue;
    }

    callTokenUsages.push(call.tokenUsage);
    lastTokenUsage = call.tokenUsage;
  }

  return {
    totalTokenUsage: sumAgentTokenUsages(callTokenUsages),
    lastTokenUsage: lastTokenUsage,
    calls: calls,
  };
}
