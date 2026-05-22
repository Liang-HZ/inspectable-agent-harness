import type { AgentResult, AgentStep } from './agent-api-types';
import type { AgentInput } from './agent-input';
import type { ModelConfig } from './env';
import { createOpenAICompatibleClient } from './openai-compatible-client';

function buildAgentPrompt(input: AgentInput): string {
  const sections = [
    `Task:\n${input.task}`,
    input.goal === undefined ? undefined : `Goal:\n${input.goal}`,
    input.context === undefined ? undefined : `Context:\n${input.context}`,
  ];

  return sections
    .filter((section): section is string => section !== undefined)
    .join('\n\n');
}

function createStep(order: number, title: string, detail: string): AgentStep {
  return {
    order: order,
    title: title,
    detail: detail,
  };
}

export async function runAgent(
  input: AgentInput,
  config: ModelConfig,
): Promise<AgentResult> {
  const client = createOpenAICompatibleClient(config);
  const prompt = buildAgentPrompt(input);
  const steps = [
    createStep(
      1,
      'Read task',
      'The agent normalized the request into task, goal, and context fields.',
    ),
    createStep(
      2,
      'Call model',
      'The agent asked the configured OpenAI-compatible chat model for a single-step answer.',
    ),
  ];

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          'You are an inspectable single-step agent. First reason about the user task, then give a practical answer. Keep the answer concise and use the same language as the user.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
  });

  const answer = completion.choices[0]?.message?.content;
  if (answer === undefined || answer === null || answer.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return {
    model: completion.model,
    answer: answer,
    steps: [
      ...steps,
      createStep(
        3,
        'Return answer',
        'The agent returned the model answer together with these inspectable steps.',
      ),
    ],
    usage: completion.usage ?? null,
  };
}
