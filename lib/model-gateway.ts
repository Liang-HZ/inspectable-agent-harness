import {
  assertAgentRunNotAborted,
  type AgentRunContext,
} from './agent-run-context';
import type {
  AgentModelCapabilities,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamEvent,
  AgentModelWireApi,
} from './agent-model-types';
import type { ModelConfig } from './env';
import { createOpenAICompatibleClient } from './openai-compatible-client';
import { openAIChatCompletionsDialect } from './openai-chat-completions-dialect';
import { openAIResponsesDialect } from './openai-responses-dialect';
import type {
  ModelProviderDialect,
  ModelRequestOptions,
} from './model-provider-dialect';

export type AgentModelGateway = {
  model: string;
  wireApi: AgentModelWireApi;
  capabilities: AgentModelCapabilities;
  createResponse: (request: AgentModelRequest) => Promise<AgentModelResponse>;
  streamResponse: (
    request: AgentModelRequest,
  ) => Promise<AsyncIterable<AgentModelStreamEvent>>;
};

function sdkRequestOptions(context: AgentRunContext): ModelRequestOptions {
  return {
    signal: context.signal,
  };
}

function selectDialect(wireApi: AgentModelWireApi): ModelProviderDialect {
  if (wireApi === 'openai-chat-completions') {
    return openAIChatCompletionsDialect;
  }

  return openAIResponsesDialect;
}

async function* guardStreamCancellation(
  stream: AsyncIterable<AgentModelStreamEvent>,
  context: AgentRunContext,
): AsyncIterable<AgentModelStreamEvent> {
  for await (const event of stream) {
    assertAgentRunNotAborted(context);
    yield event;
  }
}

export function createAgentModelGateway(
  config: ModelConfig,
  context: AgentRunContext,
): AgentModelGateway {
  const client = createOpenAICompatibleClient(config);
  const dialect = selectDialect(config.wireApi);

  return {
    model: config.model,
    wireApi: dialect.wireApi,
    capabilities: dialect.capabilities,

    async createResponse(
      request: AgentModelRequest,
    ): Promise<AgentModelResponse> {
      assertAgentRunNotAborted(context);
      const response = await dialect.createResponse(
        client,
        config,
        request,
        sdkRequestOptions(context),
      );
      assertAgentRunNotAborted(context);

      return response;
    },

    async streamResponse(
      request: AgentModelRequest,
    ): Promise<AsyncIterable<AgentModelStreamEvent>> {
      assertAgentRunNotAborted(context);
      const stream = await dialect.streamResponse(
        client,
        config,
        request,
        sdkRequestOptions(context),
      );
      assertAgentRunNotAborted(context);

      return guardStreamCancellation(stream, context);
    },
  };
}
