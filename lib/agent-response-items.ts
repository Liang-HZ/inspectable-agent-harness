import type {
  AgentModelAssistantMessage,
  AgentModelMessage,
  AgentModelProviderPhase,
  AgentModelResponse,
  AgentModelToolCall,
} from './agent-model-types';

export type AgentAssistantMessageRuntimeRole =
  | 'working_message'
  | 'final_response';

export type AgentResponseItem =
  | {
      type: 'message';
      role: 'system' | 'user' | 'assistant';
      content: string;
      providerPhase?: AgentModelProviderPhase | null;
      runtimeRole?: AgentAssistantMessageRuntimeRole;
    }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      argumentsJson: string;
    }
  | {
      type: 'function_call_output';
      callId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    };

function appendFunctionCallToMessages(
  messages: AgentModelMessage[],
  toolCall: AgentModelToolCall,
): void {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage !== undefined && lastMessage.role === 'assistant') {
    messages[messages.length - 1] = {
      ...lastMessage,
      toolCalls: [...(lastMessage.toolCalls ?? []), toolCall],
    };
    return;
  }

  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
  });
}

function toModelMessage(
  item: Extract<AgentResponseItem, { type: 'message' }>,
): AgentModelMessage {
  return {
    role: item.role,
    content: item.content,
    providerPhase: item.role === 'assistant' ? item.providerPhase : undefined,
  };
}

function serializeFunctionCallOutput(
  item: Extract<AgentResponseItem, { type: 'function_call_output' }>,
): string {
  if (item.isError) {
    return JSON.stringify({
      ok: false,
      error: item.output,
    });
  }

  return JSON.stringify(item.output);
}

export function responseItemsToModelMessages(
  items: AgentResponseItem[],
): AgentModelMessage[] {
  const messages: AgentModelMessage[] = [];

  for (const item of items) {
    if (item.type === 'message') {
      messages.push(toModelMessage(item));
      continue;
    }

    if (item.type === 'function_call') {
      appendFunctionCallToMessages(messages, {
        id: item.callId,
        name: item.name,
        argumentsJson: item.argumentsJson,
      });
      continue;
    }

    messages.push({
      role: 'tool',
      toolCallId: item.callId,
      content: serializeFunctionCallOutput(item),
    });
  }

  return messages;
}

export function createCommittedAssistantMessageItems(
  messages: AgentModelAssistantMessage[],
  runtimeRole: AgentAssistantMessageRuntimeRole,
): AgentResponseItem[] {
  return messages
    .filter(
      (message) =>
        runtimeRole === 'working_message' || message.text.trim() !== '',
    )
    .map((message) => ({
      type: 'message',
      role: 'assistant',
      content: message.text,
      providerPhase: message.providerPhase,
      runtimeRole: runtimeRole,
    }));
}

export function createAssistantResponseItems(
  response: AgentModelResponse,
): AgentResponseItem[] {
  const items: AgentResponseItem[] = [];

  if (response.text.trim() !== '') {
    items.push({
      type: 'message',
      role: 'assistant',
      content: response.text,
    });
  }

  for (const toolCall of response.toolCalls) {
    items.push({
      type: 'function_call',
      callId: toolCall.id,
      name: toolCall.name,
      argumentsJson: toolCall.argumentsJson,
    });
  }

  return items;
}
