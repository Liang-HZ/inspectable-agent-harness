import * as z from 'zod';

import type { ChatInputValidationErrors } from './chat-api-types';

const REQUEST_BODY_VALIDATION_ERROR = 'Request body validation failed.';

const optionalTrimmedStringSchema = z.preprocess(
  (value: unknown) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string({
      error: 'Field `model` must be a non-empty string when provided.',
    })
    .optional(),
);

const optionalTemperatureSchema = z.preprocess(
  (value: unknown) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    }

    return value;
  },
  z.coerce
    .number({ error: 'Field `temperature` must be a number.' })
    .min(0, { error: 'Field `temperature` must be at least 0.' })
    .max(1, { error: 'Field `temperature` must be at most 1.' })
    .optional(),
);

export const chatInputSchema = z.strictObject(
  {
    message: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? 'Field `message` is required.'
            : 'Field `message` must be a string.',
      })
      .trim()
      .min(1, { error: 'Field `message` is required.' }),
    model: optionalTrimmedStringSchema,
    temperature: optionalTemperatureSchema,
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'Request body contains unknown fields.'
        : 'Request body must be a JSON object.',
  },
);

export type ChatInput = z.infer<typeof chatInputSchema>;

type ParseChatInputResult =
  | {
      ok: true;
      input: ChatInput;
    }
  | {
      ok: false;
      error: string;
      validationErrors: ChatInputValidationErrors;
    };

function flattenChatInputError(error: z.ZodError): ChatInputValidationErrors {
  return z.flattenError(error);
}

export function parseChatInput(body: unknown): ParseChatInputResult {
  const parsedBody = chatInputSchema.safeParse(body);
  if (!parsedBody.success) {
    const validationErrors = flattenChatInputError(parsedBody.error);

    return {
      ok: false,
      error: REQUEST_BODY_VALIDATION_ERROR,
      validationErrors: validationErrors,
    };
  }

  return {
    ok: true,
    input: parsedBody.data,
  };
}
