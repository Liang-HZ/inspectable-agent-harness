import type { ChatInput } from './chat-input';
import type { ChatResult } from './chat-api-types';
import type { ModelConfig } from './env';
import { createOpenAICompatibleClient } from './openai-compatible-client';

export async function callChatModel(
  input: ChatInput,
  config: ModelConfig,
): Promise<ChatResult> {
  const client = createOpenAICompatibleClient(config);

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          'You are a concise assistant. Answer in the same language as the user.',
      },
      {
        role: 'user',
        content: input.message,
      },
    ],
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
  });

  return {
    model: completion.model,
    content: completion.choices[0]?.message?.content ?? '',
    usage: completion.usage ?? null,
  };
}
