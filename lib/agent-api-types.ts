import * as z from 'zod';

import { AGENT_MODEL_STAGES } from './agent-model-stages';

export type AgentRequestBody = {
  task: string;
  goal: string | undefined;
  context: string | undefined;
  model: string | undefined;
  temperature: string | undefined;
};

export const agentStepSchema = z.strictObject({
  order: z.number(),
  title: z.string(),
  detail: z.string(),
  output: z.unknown().optional(),
});

export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentTokenUsageSchema = z.strictObject({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
});

export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;

export const agentModelCallUsageSchema = z.strictObject({
  stage: z.enum(AGENT_MODEL_STAGES),
  tokenUsage: agentTokenUsageSchema.nullable(),
  rawUsage: z.unknown(),
});

export type AgentModelCallUsage = z.infer<typeof agentModelCallUsageSchema>;

export const agentUsageSchema = z.strictObject({
  totalTokenUsage: agentTokenUsageSchema,
  lastTokenUsage: agentTokenUsageSchema.nullable(),
  calls: z.array(agentModelCallUsageSchema),
});

export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const agentResultSchema = z.strictObject({
  model: z.string(),
  answer: z.string(),
  steps: z.array(agentStepSchema),
  usage: agentUsageSchema,
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export type AgentStreamEvent =
  | {
      type: 'step';
      step: AgentStep;
    }
  | {
      type: 'answerDelta';
      delta: string;
    }
  | {
      type: 'done';
      result: AgentResult;
    }
  | {
      type: 'error';
      error: string;
    };

export const agentInputValidationErrorsSchema = z.strictObject({
  formErrors: z.array(z.string()),
  fieldErrors: z.strictObject({
    task: z.array(z.string()).optional(),
    goal: z.array(z.string()).optional(),
    context: z.array(z.string()).optional(),
    model: z.array(z.string()).optional(),
    temperature: z.array(z.string()).optional(),
  }),
});

export type AgentInputValidationErrors = z.infer<
  typeof agentInputValidationErrorsSchema
>;

export const agentApiResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: agentResultSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string(),
    validationErrors: agentInputValidationErrorsSchema.optional(),
  }),
]);

export type AgentApiResponse = z.infer<typeof agentApiResponseSchema>;
