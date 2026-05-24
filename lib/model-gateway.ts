import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

import {
  assertAgentRunNotAborted,
  type AgentRunContext,
} from './agent-run-context';
import type { ModelConfig } from './env';
import { createOpenAICompatibleClient } from './openai-compatible-client';

export type AgentChatCompletionRequest = Omit<
  ChatCompletionCreateParamsNonStreaming,
  'model'
>;

export type AgentChatCompletionStreamRequest = Omit<
  ChatCompletionCreateParamsStreaming,
  'model' | 'stream'
>;

export type AgentModelGateway = {
  model: string;
  createChatCompletion: (
    request: AgentChatCompletionRequest,
  ) => Promise<ChatCompletion>;
  streamChatCompletion: (
    request: AgentChatCompletionStreamRequest,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>;
};

function sdkRequestOptions(context: AgentRunContext) {
  return context.signal === undefined ? {} : { signal: context.signal };
}

async function* guardStreamCancellation(
  stream: AsyncIterable<ChatCompletionChunk>,
  context: AgentRunContext,
): AsyncIterable<ChatCompletionChunk> {
  for await (const chunk of stream) {
    assertAgentRunNotAborted(context);
    yield chunk;
  }
}

export function createAgentModelGateway(
  config: ModelConfig,
  context: AgentRunContext,
): AgentModelGateway {
  const client = createOpenAICompatibleClient(config);

  return {
    model: config.model,

    async createChatCompletion(
      request: AgentChatCompletionRequest,
    ): Promise<ChatCompletion> {
      assertAgentRunNotAborted(context);
      const completionRequest = {
        model: config.model,
        ...request,
      } satisfies ChatCompletionCreateParamsNonStreaming;

      const completion = await client.chat.completions.create(
        completionRequest,
        sdkRequestOptions(context),
      );
      assertAgentRunNotAborted(context);

      return completion;
    },

    async streamChatCompletion(
      request: AgentChatCompletionStreamRequest,
    ): Promise<AsyncIterable<ChatCompletionChunk>> {
      assertAgentRunNotAborted(context);
      const completionRequest = {
        model: config.model,
        stream: true,
        ...request,
      } satisfies ChatCompletionCreateParamsStreaming;

      const stream = await client.chat.completions.create(
        completionRequest,
        sdkRequestOptions(context),
      );
      assertAgentRunNotAborted(context);

      return guardStreamCancellation(stream, context);
    },
  };
}
