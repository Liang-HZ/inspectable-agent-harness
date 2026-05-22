import * as z from 'zod';

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
});

export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentResultSchema = z.strictObject({
  model: z.string(),
  answer: z.string(),
  steps: z.array(agentStepSchema),
  usage: z.unknown(),
});

export type AgentResult = z.infer<typeof agentResultSchema>;

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
