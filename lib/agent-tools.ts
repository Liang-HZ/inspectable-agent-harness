import * as z from 'zod';

import type { AgentModelToolDefinition } from './agent-model-types';
import type { AgentToolAnnotations } from './agent-permissions';

const INSPECT_TEXT_TOOL_NAME = 'inspect_text';

const inspectTextInputSchema = z.strictObject({
  text: z.string(),
});

type InspectTextInput = z.infer<typeof inspectTextInputSchema>;

type InspectTextResult = {
  characterCount: number;
  lineCount: number;
  wordCount: number;
  preview: string;
};

export type AgentToolResult = {
  input: unknown;
  result: unknown;
};

export type AgentToolDefinition = {
  name: string;
  annotations: AgentToolAnnotations;
  modelTool: AgentModelToolDefinition;
  execute: (argumentsJson: string) => AgentToolResult;
};

export type AgentToolExecution = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: unknown;
};

const inspectTextToolDefinition = {
  name: INSPECT_TEXT_TOOL_NAME,
  annotations: {
    readOnly: true,
    destructive: false,
    openWorld: false,
    idempotent: true,
  },
  modelTool: {
    name: INSPECT_TEXT_TOOL_NAME,
    description:
      'Inspect plain text and return character, line, and word counts. Use this when the user asks about length, counts, or basic text statistics.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'The exact text to inspect.',
        },
      },
      required: ['text'],
    },
    strict: true,
  },
  execute: (argumentsJson: string): AgentToolResult => {
    const input = parseInspectTextInput(argumentsJson);

    return {
      input: input,
      result: inspectText(input),
    };
  },
} satisfies AgentToolDefinition;

export const agentToolDefinitions: AgentToolDefinition[] = [
  inspectTextToolDefinition,
];

export const agentToolRegistry = new Map<string, AgentToolDefinition>(
  agentToolDefinitions.map((toolDefinition) => [
    toolDefinition.name,
    toolDefinition,
  ]),
);

export const agentTools: AgentModelToolDefinition[] = agentToolDefinitions.map(
  (toolDefinition) => toolDefinition.modelTool,
);

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches === null ? 0 : matches.length;
}

function inspectText(input: InspectTextInput) {
  return {
    characterCount: input.text.length,
    lineCount: input.text === '' ? 0 : input.text.split(/\r\n|\r|\n/).length,
    wordCount: countWords(input.text),
    preview: input.text.slice(0, 120),
  } satisfies InspectTextResult;
}

function parseInspectTextInput(argumentsJson: string): InspectTextInput {
  const parsedJson = JSON.parse(argumentsJson);
  const parsedInput = inspectTextInputSchema.safeParse(parsedJson);

  if (!parsedInput.success) {
    throw new Error('Tool `inspect_text` received invalid arguments.');
  }

  return parsedInput.data;
}
