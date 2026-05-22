import * as z from 'zod';

import type { AgentInputValidationErrors } from './agent-api-types';

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
      error: 'Field must be a non-empty string when provided.',
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

export const agentInputSchema = z.strictObject(
  {
    task: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? 'Field `task` is required.'
            : 'Field `task` must be a string.',
      })
      .trim()
      .min(1, { error: 'Field `task` is required.' }),
    goal: optionalTrimmedStringSchema,
    context: optionalTrimmedStringSchema,
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

export type AgentInput = z.infer<typeof agentInputSchema>;

type ParseAgentInputResult =
  | {
      ok: true;
      input: AgentInput;
    }
  | {
      ok: false;
      error: string;
      validationErrors: AgentInputValidationErrors;
    };

function flattenAgentInputError(error: z.ZodError): AgentInputValidationErrors {
  return z.flattenError(error);
}

export function parseAgentInput(body: unknown): ParseAgentInputResult {
  const parsedBody = agentInputSchema.safeParse(body);
  if (!parsedBody.success) {
    const validationErrors = flattenAgentInputError(parsedBody.error);

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
