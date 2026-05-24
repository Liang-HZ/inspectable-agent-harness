import type OpenAI from 'openai';
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';

import type { AgentTokenUsage } from './agent-api-types';
import type { ModelConfig } from './env';
import type {
  AgentModelMessage,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamEvent,
  AgentModelToolCall,
  AgentModelToolDefinition,
  AgentModelUsageSnapshot,
} from './agent-model-types';
import type {
  ModelProviderDialect,
  ModelRequestOptions,
} from './model-provider-dialect';

function normalizeResponsesUsage(
  usage: ResponseUsage | null | undefined,
): AgentTokenUsage | null {
  if (usage === undefined || usage === null) {
    return null;
  }

  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

function createUsageSnapshot(
  usage: ResponseUsage | null | undefined,
): AgentModelUsageSnapshot {
  return {
    tokenUsage: normalizeResponsesUsage(usage),
    rawUsage: usage ?? null,
  };
}

function toResponsesTool(tool: AgentModelToolDefinition): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  };
}

function messageText(message: Extract<AgentModelMessage, { role: string }>) {
  return message.content;
}

function appendTextMessage(
  input: ResponseInputItem[],
  message: Exclude<AgentModelMessage, { role: 'tool' }>,
): void {
  if (message.content.trim() === '') {
    return;
  }

  input.push({
    type: 'message',
    role: message.role,
    content: messageText(message),
  } satisfies EasyInputMessage);
}

function appendToolCalls(
  input: ResponseInputItem[],
  toolCalls: AgentModelToolCall[] | undefined,
): void {
  if (toolCalls === undefined) {
    return;
  }

  for (const toolCall of toolCalls) {
    input.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    });
  }
}

function toResponsesInput(messages: AgentModelMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }

    appendTextMessage(input, message);
    appendToolCalls(input, message.toolCalls);
  }

  return input;
}

function toResponsesToolChoice(
  request: AgentModelRequest,
): ResponseCreateParamsNonStreaming['tool_choice'] {
  if (request.tools.length === 0 || request.toolChoice === 'none') {
    return 'none';
  }

  return 'auto';
}

function toResponsesRequest(
  config: ModelConfig,
  request: AgentModelRequest,
): ResponseCreateParamsNonStreaming {
  return {
    model: config.model,
    input: toResponsesInput(request.messages),
    tools:
      request.tools.length === 0 || request.toolChoice === 'none'
        ? undefined
        : request.tools.map((tool) => toResponsesTool(tool)),
    tool_choice: toResponsesToolChoice(request),
    store: false,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
  };
}

function toAgentToolCall(item: ResponseFunctionToolCall): AgentModelToolCall {
  return {
    id: item.call_id,
    name: item.name,
    argumentsJson: item.arguments,
  };
}

function readResponseToolCalls(response: Response): AgentModelToolCall[] {
  return response.output
    .filter(
      (item): item is ResponseFunctionToolCall => item.type === 'function_call',
    )
    .map((item) => toAgentToolCall(item));
}

function toAgentModelResponse(response: Response): AgentModelResponse {
  return {
    model: response.model,
    text: response.output_text,
    toolCalls: readResponseToolCalls(response),
    usage: createUsageSnapshot(response.usage),
  };
}

async function* mapResponsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
  fallbackModel: string,
): AsyncIterable<AgentModelStreamEvent> {
  let model = fallbackModel;
  let usage: ResponseUsage | null = null;

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      yield {
        type: 'text_delta',
        delta: event.delta,
      };
      continue;
    }

    if (event.type === 'response.completed') {
      model = event.response.model;
      usage = event.response.usage ?? null;
    }
  }

  yield {
    type: 'completed',
    model: model,
    usage: createUsageSnapshot(usage),
  };
}

export const openAIResponsesDialect = {
  wireApi: 'openai-responses',
  capabilities: {
    tools: true,
    streaming: true,
    streamingUsage: true,
    parallelToolCalls: true,
  },
  async createResponse(
    client: OpenAI,
    config: ModelConfig,
    request: AgentModelRequest,
    options: ModelRequestOptions,
  ): Promise<AgentModelResponse> {
    const response = await client.responses.create(
      toResponsesRequest(config, request),
      options,
    );

    return toAgentModelResponse(response);
  },
  async streamResponse(
    client: OpenAI,
    config: ModelConfig,
    request: AgentModelRequest,
    options: ModelRequestOptions,
  ): Promise<AsyncIterable<AgentModelStreamEvent>> {
    const responseRequest = {
      ...toResponsesRequest(config, request),
      stream: true,
      stream_options: {
        include_obfuscation: false,
      },
    } satisfies ResponseCreateParamsStreaming;

    const stream = await client.responses.create(responseRequest, options);

    return mapResponsesStream(stream, config.model);
  },
} satisfies ModelProviderDialect;
