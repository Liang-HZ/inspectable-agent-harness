import type { AgentTokenUsage } from './agent-api-types';
import type {
  AgentModelMessage,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamEvent,
  AgentModelToolCall,
  AgentModelUsageSnapshot,
} from './agent-model-types';

// This module is the anti-corruption boundary for Anthropic's Messages API.
// It exists to prove the agent's provider-neutral IR is genuinely neutral:
// the OpenAI dialects share a near-identical message model, so they cannot
// show whether the IR survives a *different* shape. Anthropic's shape is
// different in three load-bearing ways, and each is handled here:
//
//   1. `system` is a top-level request parameter, not a message role.
//   2. Content is an array of typed blocks (text / tool_use / tool_result),
//      not a flat string plus a sibling tool_calls array.
//   3. A tool result is a `tool_result` block inside a *user* message, not a
//      dedicated `tool` role.
//
// The pure functions below are fully unit-tested against these documented wire
// shapes. Wiring them to a live `@anthropic-ai/sdk` client is a separate step
// (see the note in docs/architecture.md): the ModelProviderDialect contract is
// currently typed to the OpenAI client, and the agent runtime does not depend
// on this mapping yet. What this module establishes is that the IR is the
// correct waist for a second provider — the remaining work is plumbing, not
// modeling.

// Anthropic requires max_tokens on every Messages request; the OpenAI IR has
// no equivalent, so the dialect supplies a default.
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4_096;

export type AnthropicTextBlock = {
  type: 'text';
  text: string;
};

export type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: { type: 'auto' };
  temperature?: number;
};

export function toAnthropicMessagesRequest(
  model: string,
  request: AgentModelRequest,
  maxTokens: number = DEFAULT_ANTHROPIC_MAX_TOKENS,
): AnthropicMessagesRequest {
  const systemParts: string[] = [];
  const roleTaggedMessages: AnthropicMessage[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content.trim() !== '') {
        systemParts.push(message.content);
      }
      continue;
    }

    roleTaggedMessages.push(toAnthropicMessage(message));
  }

  const useTools = request.tools.length > 0 && request.toolChoice !== 'none';

  return {
    model: model,
    max_tokens: maxTokens,
    ...(systemParts.length === 0
      ? {}
      : { system: systemParts.join('\n\n') }),
    messages: coalesceAdjacentSameRole(roleTaggedMessages),
    ...(useTools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          tool_choice: { type: 'auto' as const },
        }
      : {}),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
  };
}

function toAnthropicMessage(
  message: Exclude<AgentModelMessage, { role: 'system' }>,
): AnthropicMessage {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }

  if (message.role === 'assistant') {
    const blocks: AnthropicContentBlock[] = [];

    if (message.content.trim() !== '') {
      blocks.push({ type: 'text', text: message.content });
    }

    for (const toolCall of message.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: parseToolCallInput(toolCall.argumentsJson),
      });
    }

    return { role: 'assistant', content: blocks };
  }

  return {
    role: 'user',
    content: [{ type: 'text', text: message.content }],
  };
}

// Anthropic rejects two consecutive messages with the same role. Our IR emits
// one `tool` message per tool result, which each become a user message; they
// must merge into a single user turn carrying all the tool_result blocks.
function coalesceAdjacentSameRole(
  messages: AnthropicMessage[],
): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];

    if (previous !== undefined && previous.role === message.role) {
      previous.content = [...previous.content, ...message.content];
      continue;
    }

    merged.push({ role: message.role, content: [...message.content] });
  }

  return merged;
}

function parseToolCallInput(argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(argumentsJson);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object; a malformed tool call should not crash
    // the request translation.
  }

  return {};
}

// Non-streaming Messages responses.
export type AnthropicMessagesResponse = {
  model: string;
  content: AnthropicContentBlock[];
  usage?: AnthropicUsage;
};

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
};

export function fromAnthropicMessagesResponse(
  response: AnthropicMessagesResponse,
): AgentModelResponse {
  let text = '';
  const toolCalls: AgentModelToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        argumentsJson: JSON.stringify(block.input),
      });
    }
  }

  return {
    model: response.model,
    text: text,
    toolCalls: toolCalls,
    usage: toUsageSnapshot(response.usage),
  };
}

export function normalizeAnthropicUsage(
  usage: AnthropicUsage | undefined | null,
): AgentTokenUsage | null {
  if (usage === undefined || usage === null) {
    return null;
  }

  const cachedInputTokens = usage.cache_read_input_tokens ?? null;

  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: cachedInputTokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: 0,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function toUsageSnapshot(
  usage: AnthropicUsage | undefined | null,
): AgentModelUsageSnapshot {
  return {
    tokenUsage: normalizeAnthropicUsage(usage),
    rawUsage: usage ?? null,
  };
}

// Anthropic's streaming event shapes, narrowed to the fields this mapping
// reads. The real SDK types are richer; the runtime only needs these.
export type AnthropicStreamEvent =
  | { type: 'message_start'; message: { model: string; usage?: AnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id: string; name: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: AnthropicUsage }
  | { type: 'message_stop' };

type StreamingToolBlock = {
  id: string;
  name: string;
  argumentsJson: string;
};

export async function* mapAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
  fallbackModel: string,
): AsyncIterable<AgentModelStreamEvent> {
  let model = fallbackModel;
  let usage: AnthropicUsage | null = null;
  let assistantText = '';
  const toolBlocks = new Map<number, StreamingToolBlock>();

  for await (const event of stream) {
    if (event.type === 'message_start') {
      model = event.message.model ?? model;
      if (event.message.usage !== undefined) {
        usage = event.message.usage;
      }
      continue;
    }

    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        toolBlocks.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          argumentsJson: '',
        });
      } else if (
        event.content_block.type === 'text' &&
        event.content_block.text !== undefined &&
        event.content_block.text !== ''
      ) {
        assistantText += event.content_block.text;
        yield { type: 'text_delta', delta: event.content_block.text };
      }
      continue;
    }

    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        assistantText += event.delta.text;
        yield { type: 'text_delta', delta: event.delta.text };
      } else {
        const block = toolBlocks.get(event.index);
        if (block !== undefined) {
          block.argumentsJson += event.delta.partial_json;
          yield {
            type: 'tool_call_delta',
            index: event.index,
            itemId: block.id,
            toolCallId: block.id,
            name: block.name,
            delta: event.delta.partial_json,
          };
        }
      }
      continue;
    }

    if (event.type === 'message_delta' && event.usage !== undefined) {
      usage = mergeUsage(usage, event.usage);
      continue;
    }
  }

  yield {
    type: 'assistant_message_done',
    message: { text: assistantText, providerPhase: null },
  };

  for (const [, block] of [...toolBlocks.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    yield {
      type: 'tool_call_committed',
      toolCall: {
        id: block.id,
        name: block.name,
        argumentsJson: block.argumentsJson,
      },
    };
  }

  yield {
    type: 'completed',
    model: model,
    usage: toUsageSnapshot(usage),
  };
}

// Anthropic reports input tokens on message_start and output tokens on
// message_delta; the final usage combines both.
function mergeUsage(
  base: AnthropicUsage | null,
  update: AnthropicUsage,
): AnthropicUsage {
  if (base === null) {
    return update;
  }

  return {
    input_tokens: update.input_tokens || base.input_tokens,
    output_tokens: update.output_tokens || base.output_tokens,
    cache_read_input_tokens:
      update.cache_read_input_tokens ?? base.cache_read_input_tokens,
  };
}
