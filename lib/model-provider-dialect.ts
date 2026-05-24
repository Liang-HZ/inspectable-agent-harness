import type OpenAI from 'openai';

import type { ModelConfig } from './env';
import type {
  AgentModelCapabilities,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamEvent,
  AgentModelWireApi,
} from './agent-model-types';

export type ModelRequestOptions = {
  signal: AbortSignal | undefined;
};

export type ModelProviderDialect = {
  wireApi: AgentModelWireApi;
  capabilities: AgentModelCapabilities;
  createResponse: (
    client: OpenAI,
    config: ModelConfig,
    request: AgentModelRequest,
    options: ModelRequestOptions,
  ) => Promise<AgentModelResponse>;
  streamResponse: (
    client: OpenAI,
    config: ModelConfig,
    request: AgentModelRequest,
    options: ModelRequestOptions,
  ) => Promise<AsyncIterable<AgentModelStreamEvent>>;
};
