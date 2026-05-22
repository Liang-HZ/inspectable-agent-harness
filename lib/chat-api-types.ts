import * as z from 'zod';

export type ChatRequestBody = {
  message: string;
  model: string | undefined;
  temperature: string | undefined;
};

export const chatResultSchema = z.strictObject({
  model: z.string(),
  content: z.string(),
  usage: z.unknown(),
});

export type ChatResult = z.infer<typeof chatResultSchema>;

export const chatInputValidationErrorsSchema = z.strictObject({
  formErrors: z.array(z.string()),
  fieldErrors: z.strictObject({
    message: z.array(z.string()).optional(),
    model: z.array(z.string()).optional(),
    temperature: z.array(z.string()).optional(),
  }),
});

export type ChatInputValidationErrors = z.infer<
  typeof chatInputValidationErrorsSchema
>;

export const chatApiResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: chatResultSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string(),
    validationErrors: chatInputValidationErrorsSchema.optional(),
  }),
]);

export type ChatApiResponse = z.infer<typeof chatApiResponseSchema>;
