import type { AgentTokenUsage } from './agent-api-types';

export const AGENT_MODEL_WIRE_APIS = [
  'openai-chat-completions',
  'openai-responses',
] as const;

export type AgentModelWireApi = (typeof AGENT_MODEL_WIRE_APIS)[number];

export type AgentModelToolChoice = 'auto' | 'none';

export type AgentModelToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};

export type AgentModelToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type AgentModelMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
      toolCalls?: AgentModelToolCall[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      content: string;
    };

export type AgentModelUsageSnapshot = {
  tokenUsage: AgentTokenUsage | null;
  rawUsage: unknown;
};

export type AgentModelRequest = {
  messages: AgentModelMessage[];
  tools: AgentModelToolDefinition[];
  toolChoice: AgentModelToolChoice;
  temperature: number | undefined;
};

export type AgentModelResponse = {
  model: string;
  text: string;
  toolCalls: AgentModelToolCall[];
  usage: AgentModelUsageSnapshot;
};

export type AgentModelStreamEvent =
  | {
      type: 'text_delta';
      delta: string;
    }
  | {
      type: 'completed';
      model: string;
      usage: AgentModelUsageSnapshot;
    };

export type AgentModelCapabilities = {
  tools: boolean;
  streaming: boolean;
  streamingUsage: boolean;
  parallelToolCalls: boolean;
};
