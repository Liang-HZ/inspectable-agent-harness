import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

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

function normalizeChatCompletionUsage(
  usage: CompletionUsage | null | undefined,
): AgentTokenUsage | null {
  if (usage === undefined || usage === null) {
    return null;
  }

  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    outputTokens: usage.completion_tokens,
    reasoningOutputTokens:
      usage.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens,
  };
}

function createUsageSnapshot(
  usage: CompletionUsage | null | undefined,
): AgentModelUsageSnapshot {
  return {
    tokenUsage: normalizeChatCompletionUsage(usage),
    rawUsage: usage ?? null,
  };
}

function toChatCompletionTool(
  tool: AgentModelToolDefinition,
): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.schemaStrict,
    },
  };
}

function toChatCompletionToolCalls(
  toolCalls: AgentModelToolCall[],
): ChatCompletionAssistantMessageParam['tool_calls'] {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    },
  }));
}

function toChatCompletionMessage(
  message: AgentModelMessage,
): ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls:
        message.toolCalls === undefined
          ? undefined
          : toChatCompletionToolCalls(message.toolCalls),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toChatCompletionToolChoice(
  request: AgentModelRequest,
): ChatCompletionCreateParamsNonStreaming['tool_choice'] {
  if (request.tools.length === 0 || request.toolChoice === 'none') {
    return undefined;
  }

  return 'auto';
}

function toChatCompletionTools(
  request: AgentModelRequest,
): ChatCompletionTool[] | undefined {
  if (request.tools.length === 0 || request.toolChoice === 'none') {
    return undefined;
  }

  return request.tools.map((tool) => toChatCompletionTool(tool));
}

function toChatCompletionRequest(
  config: ModelConfig,
  request: AgentModelRequest,
): ChatCompletionCreateParamsNonStreaming {
  return {
    model: config.model,
    messages: request.messages.map((message) =>
      toChatCompletionMessage(message),
    ),
    tools: toChatCompletionTools(request),
    tool_choice: toChatCompletionToolChoice(request),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
  };
}

function readChatCompletionToolCalls(
  message: ChatCompletionMessage,
): AgentModelToolCall[] {
  return (message.tool_calls ?? [])
    .filter(
      (toolCall): toolCall is ChatCompletionMessageFunctionToolCall =>
        toolCall.type === 'function',
    )
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      argumentsJson: toolCall.function.arguments,
    }));
}

function readChatCompletionText(message: ChatCompletionMessage): string {
  if (message.content === undefined || message.content === null) {
    return '';
  }

  return message.content;
}

function presentString(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return value;
}

function toAgentModelResponse(completion: ChatCompletion): AgentModelResponse {
  const message = completion.choices[0]?.message;

  if (message === undefined) {
    throw new Error('Model returned no agent response.');
  }

  return {
    model: completion.model,
    text: readChatCompletionText(message),
    toolCalls: readChatCompletionToolCalls(message),
    usage: createUsageSnapshot(completion.usage),
  };
}

async function* mapChatCompletionStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  fallbackModel: string,
): AsyncIterable<AgentModelStreamEvent> {
  let model = fallbackModel;
  let usage: CompletionUsage | null = null;
  let assistantText = '';
  const toolCallParts = new Map<
    number,
    {
      id: string | undefined;
      name: string | undefined;
      argumentsJson: string;
    }
  >();
  let emittedToolCalls = false;

  function completedToolCalls(): AgentModelToolCall[] {
    return [...toolCallParts.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, toolCallPart]) => {
        if (toolCallPart.id === undefined) {
          throw new Error('Model streamed a tool call without an id.');
        }

        if (toolCallPart.name === undefined) {
          throw new Error(
            'Model streamed a tool call without a function name.',
          );
        }

        return {
          id: toolCallPart.id,
          name: toolCallPart.name,
          argumentsJson: toolCallPart.argumentsJson,
        };
      });
  }

  for await (const chunk of stream) {
    model = chunk.model ?? model;

    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = chunk.usage;
    }

    const choice = chunk.choices[0];
    const contentDelta = choice?.delta.content;
    if (
      contentDelta !== undefined &&
      contentDelta !== null &&
      contentDelta !== ''
    ) {
      assistantText += contentDelta;
      yield {
        type: 'text_delta',
        delta: contentDelta,
      };
    }

    for (const toolCallDelta of choice?.delta.tool_calls ?? []) {
      const current = toolCallParts.get(toolCallDelta.index) ?? {
        id: undefined,
        name: undefined,
        argumentsJson: '',
      };
      const id = presentString(toolCallDelta.id) ?? current.id;
      const name = presentString(toolCallDelta.function?.name) ?? current.name;
      const argumentsDelta = toolCallDelta.function?.arguments ?? '';

      toolCallParts.set(toolCallDelta.index, {
        id: id,
        name: name,
        argumentsJson: current.argumentsJson + argumentsDelta,
      });

      if (argumentsDelta !== '') {
        yield {
          type: 'tool_call_delta',
          index: toolCallDelta.index,
          itemId: undefined,
          toolCallId: id,
          name: name,
          delta: argumentsDelta,
        };
      }
    }

    if (choice?.finish_reason === 'tool_calls' && !emittedToolCalls) {
      for (const toolCall of completedToolCalls()) {
        yield {
          type: 'tool_call_committed',
          toolCall: toolCall,
        };
      }
      emittedToolCalls = true;
    }
  }

  yield {
    type: 'assistant_message_done',
    message: {
      text: assistantText,
      providerPhase: null,
    },
  };

  if (toolCallParts.size > 0 && !emittedToolCalls) {
    for (const toolCall of completedToolCalls()) {
      yield {
        type: 'tool_call_committed',
        toolCall: toolCall,
      };
    }
  }

  yield {
    type: 'completed',
    model: model,
    usage: createUsageSnapshot(usage),
  };
}

export const openAIChatCompletionsDialect = {
  wireApi: 'openai-chat-completions',
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
    const completion = await client.chat.completions.create(
      toChatCompletionRequest(config, request),
      options,
    );

    return toAgentModelResponse(completion);
  },
  async streamResponse(
    client: OpenAI,
    config: ModelConfig,
    request: AgentModelRequest,
    options: ModelRequestOptions,
  ): Promise<AsyncIterable<AgentModelStreamEvent>> {
    const completionRequest = {
      ...toChatCompletionRequest(config, request),
      stream: true,
      stream_options: {
        include_usage: true,
      },
    } satisfies ChatCompletionCreateParamsStreaming;

    const stream = await client.chat.completions.create(
      completionRequest,
      options,
    );

    return mapChatCompletionStream(stream, config.model);
  },
} satisfies ModelProviderDialect;
