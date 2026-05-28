import * as z from 'zod';

import type { AgentModelToolDefinition } from './agent-model-types';
import type { AgentToolAnnotations } from './agent-permissions';
import {
  AgentToolRespondToModelError,
  createSuccessToolOutput,
  type AgentToolOutput,
} from './agent-tool-output';
import { workspaceReadToolDefinitions } from './agent-workspace-tools';

const INSPECT_TEXT_TOOL_NAME = 'inspect_text';

export type AgentToolExecutionMode = 'sequential' | 'parallel';

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
  output: AgentToolOutput;
};

export type AgentToolDefinition = {
  name: string;
  annotations: AgentToolAnnotations;
  executionMode?: AgentToolExecutionMode;
  modelTool: AgentModelToolDefinition;
  execute: (
    argumentsJson: string,
    signal: AbortSignal | undefined,
  ) => AgentToolResult | Promise<AgentToolResult>;
  timeoutMs?: number;
};

export type AgentToolExecution = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: AgentToolOutput;
  modelOutput: string;
  isError: boolean;
  durationMs: number;
};

const inspectTextToolDefinition = {
  name: INSPECT_TEXT_TOOL_NAME,
  annotations: {
    readOnly: true,
    destructive: false,
    openWorld: false,
    idempotent: true,
  },
  executionMode: 'parallel',
  modelTool: {
    name: INSPECT_TEXT_TOOL_NAME,
    description:
      'Inspect plain text and return character, line, and word counts. Use this when the user asks about length, counts, or basic text statistics.',
    inputSchema: {
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
    schemaStrict: true,
  },
  execute: (argumentsJson: string): AgentToolResult => {
    const input = parseInspectTextInput(argumentsJson);
    const result = inspectText(input);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatInspectTextResult(result),
        details: result,
      }),
    };
  },
} satisfies AgentToolDefinition;

export const agentToolDefinitions: AgentToolDefinition[] = [
  inspectTextToolDefinition,
  ...workspaceReadToolDefinitions,
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

function formatInspectTextResult(result: InspectTextResult): string {
  return [
    `Character count: ${result.characterCount}`,
    `Line count: ${result.lineCount}`,
    `Word count: ${result.wordCount}`,
    `Preview: ${result.preview}`,
  ].join('\n');
}

function parseInspectTextInput(argumentsJson: string): InspectTextInput {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argumentsJson);
  } catch {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      'Tool `inspect_text` received invalid JSON arguments.',
    );
  }

  const parsedInput = inspectTextInputSchema.safeParse(parsedJson);

  if (!parsedInput.success) {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      'Tool `inspect_text` received invalid arguments.',
    );
  }

  return parsedInput.data;
}
