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
import {
  DEFAULT_MODEL_RETRY_POLICY,
  runWithModelRetry,
  type ModelRetryPolicy,
} from './model-retry';
import { logAgentInfo } from './agent-log';

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
  retryPolicy: ModelRetryPolicy = DEFAULT_MODEL_RETRY_POLICY,
): AgentModelGateway {
  const client = createOpenAICompatibleClient(config);
  const dialect = selectDialect(config.wireApi);

  function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return runWithModelRetry(operation, retryPolicy, {
      signal: context.signal,
      onRetry: ({ attempt, delayMs, error }) => {
        logAgentInfo(context.runId, 'model_call_retry', {
          attempt: attempt,
          delayMs: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  return {
    model: config.model,
    wireApi: dialect.wireApi,
    capabilities: dialect.capabilities,

    async createResponse(
      request: AgentModelRequest,
    ): Promise<AgentModelResponse> {
      assertAgentRunNotAborted(context);
      const response = await withRetry(() =>
        dialect.createResponse(
          client,
          config,
          request,
          sdkRequestOptions(context),
        ),
      );
      assertAgentRunNotAborted(context);

      return response;
    },

    async streamResponse(
      request: AgentModelRequest,
    ): Promise<AsyncIterable<AgentModelStreamEvent>> {
      assertAgentRunNotAborted(context);
      // Retry only covers establishing the stream. Once events start flowing,
      // the runtime may already have committed assistant text, so a mid-stream
      // reconnect would double-emit; that failure surfaces as run_failed
      // instead. This is the same boundary Codex draws around streamed turns.
      const stream = await withRetry(() =>
        dialect.streamResponse(
          client,
          config,
          request,
          sdkRequestOptions(context),
        ),
      );
      assertAgentRunNotAborted(context);

      return guardStreamCancellation(stream, context);
    },
  };
}
