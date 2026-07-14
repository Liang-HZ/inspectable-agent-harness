import type { AgentTokenUsage } from './agent-api-types';
import type { AgentModelMessage, AgentModelRequest } from './agent-model-types';
import type { AgentResponseItem } from './agent-response-items';

export const DEFAULT_COMPACTION_TOKEN_THRESHOLD = 8_000;
export const COMPACTION_RECENT_USER_MESSAGE_CHAR_BUDGET = 20_000;
const MINIMUM_HISTORY_ITEMS_TO_COMPACT = 4;

const COMPACTION_SYSTEM_INSTRUCTION =
  'You are compacting the working history of a coding agent so the conversation can continue with a shorter context. Read the transcript and write a concise summary that preserves: the user\'s original goal and task, key decisions made and why, files or resources touched and their current state, work already completed, work still remaining, and any errors encountered and how they were handled. Write a few short paragraphs or a bulleted list. Do not include a preamble such as "Here is a summary" -- output only the summary content itself.';

export type AgentCompactionDecision =
  | {
      shouldCompact: false;
    }
  | {
      shouldCompact: true;
      reason: string;
      tokenUsage: AgentTokenUsage;
    };

export function decideAgentHistoryCompaction(
  tokenUsage: AgentTokenUsage | null,
  history: AgentResponseItem[],
  threshold: number,
): AgentCompactionDecision {
  if (tokenUsage === null) {
    return { shouldCompact: false };
  }

  if (tokenUsage.totalTokens < threshold) {
    return { shouldCompact: false };
  }

  if (history.length < MINIMUM_HISTORY_ITEMS_TO_COMPACT) {
    return { shouldCompact: false };
  }

  return {
    shouldCompact: true,
    reason: `Reported token usage ${tokenUsage.totalTokens} reached the compaction threshold ${threshold}.`,
    tokenUsage: tokenUsage,
  };
}

function describeResponseItemForSummaryPrompt(item: AgentResponseItem): string {
  if (item.type === 'message') {
    return `[${item.role}] ${item.content}`;
  }

  if (item.type === 'function_call') {
    return `[tool call ${item.name}] ${item.argumentsJson}`;
  }

  if (item.type === 'function_call_output') {
    return `[tool result ${item.toolName}${item.isError ? ' (error)' : ''}] ${item.output}`;
  }

  return `[earlier summary] ${item.content}`;
}

export function serializeAgentHistoryForSummaryPrompt(
  history: AgentResponseItem[],
): string {
  return history.map(describeResponseItemForSummaryPrompt).join('\n\n');
}

export function buildCompactionSummaryRequest(
  history: AgentResponseItem[],
): AgentModelRequest {
  const messages: AgentModelMessage[] = [
    { role: 'system', content: COMPACTION_SYSTEM_INSTRUCTION },
    { role: 'user', content: serializeAgentHistoryForSummaryPrompt(history) },
  ];

  return {
    messages: messages,
    tools: [],
    toolChoice: 'none',
    temperature: undefined,
  };
}

function findLeadingSystemMessage(
  history: AgentResponseItem[],
): AgentResponseItem | undefined {
  const first = history[0];

  return first?.type === 'message' && first.role === 'system'
    ? first
    : undefined;
}

type AgentUserMessageResponseItem = Extract<
  AgentResponseItem,
  { type: 'message' }
> & { role: 'user' };

function selectRecentUserMessagesWithinBudget(
  history: AgentResponseItem[],
  charBudget: number,
): AgentUserMessageResponseItem[] {
  const userMessages = history.filter(
    (item): item is AgentUserMessageResponseItem =>
      item.type === 'message' && item.role === 'user',
  );

  const kept: AgentUserMessageResponseItem[] = [];
  let usedChars = 0;

  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const message = userMessages[index];
    if (message === undefined) {
      continue;
    }

    const messageChars = message.content.length;

    if (kept.length > 0 && usedChars + messageChars > charBudget) {
      break;
    }

    kept.unshift(message);
    usedChars += messageChars;
  }

  return kept;
}

export type AgentHistoryCompactionResult = {
  history: AgentResponseItem[];
  summaryItem: Extract<AgentResponseItem, { type: 'compaction_summary' }>;
  removedItemCount: number;
  keptItemCount: number;
};

export function applyAgentHistoryCompaction(
  history: AgentResponseItem[],
  summaryText: string,
): AgentHistoryCompactionResult {
  const leadingSystemMessage = findLeadingSystemMessage(history);
  const recentUserMessages = selectRecentUserMessagesWithinBudget(
    history,
    COMPACTION_RECENT_USER_MESSAGE_CHAR_BUDGET,
  );
  const summaryItem: Extract<AgentResponseItem, { type: 'compaction_summary' }> =
    {
      type: 'compaction_summary',
      content: summaryText,
    };

  const compactedHistory: AgentResponseItem[] = [
    ...(leadingSystemMessage === undefined ? [] : [leadingSystemMessage]),
    summaryItem,
    ...recentUserMessages,
  ];

  return {
    history: compactedHistory,
    summaryItem: summaryItem,
    removedItemCount: history.length - compactedHistory.length,
    keptItemCount: compactedHistory.length,
  };
}
