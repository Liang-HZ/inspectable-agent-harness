import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import * as z from 'zod';

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

export type AgentToolExecution = {
  toolCallId: string;
  toolName: typeof INSPECT_TEXT_TOOL_NAME;
  input: InspectTextInput;
  result: InspectTextResult;
};

export const agentTools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
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
  },
];

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

export function executeAgentTool(
  toolCall: ChatCompletionMessageFunctionToolCall,
): AgentToolExecution {
  if (toolCall.function.name !== INSPECT_TEXT_TOOL_NAME) {
    throw new Error(`Unknown agent tool: ${toolCall.function.name}`);
  }

  const input = parseInspectTextInput(toolCall.function.arguments);

  return {
    toolCallId: toolCall.id,
    toolName: INSPECT_TEXT_TOOL_NAME,
    input: input,
    result: inspectText(input),
  };
}
