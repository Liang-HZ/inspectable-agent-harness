import * as z from 'zod';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.5';
const MISSING_API_KEY_ERROR =
  'Missing OPENAI_API_KEY in environment variables.';

export const modelConfigSchema = z.strictObject({
  apiKey: z.string({ error: MISSING_API_KEY_ERROR }).min(1, {
    error: MISSING_API_KEY_ERROR,
  }),
  baseURL: z.string().min(1),
  model: z.string().min(1),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

type ReadModelConfigResult =
  | {
      ok: true;
      config: ModelConfig;
    }
  | {
      ok: false;
      error: string;
    };

function readOptionalEnvString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readModelConfig(modelOverride?: string): ReadModelConfigResult {
  const parsedConfig = modelConfigSchema.safeParse({
    apiKey: readOptionalEnvString('OPENAI_API_KEY'),
    baseURL: readOptionalEnvString('OPENAI_BASE_URL') ?? DEFAULT_BASE_URL,
    model:
      modelOverride ?? readOptionalEnvString('OPENAI_MODEL') ?? DEFAULT_MODEL,
  });

  if (!parsedConfig.success) {
    return {
      ok: false,
      error: parsedConfig.error.issues[0]?.message ?? MISSING_API_KEY_ERROR,
    };
  }

  return {
    ok: true,
    config: parsedConfig.data,
  };
}
