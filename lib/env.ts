import { resolve } from 'path';

import * as z from 'zod';

import { AGENT_MODEL_WIRE_APIS } from './agent-model-types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_WIRE_API = 'openai-chat-completions';
const MISSING_API_KEY_ERROR =
  'Missing OPENAI_API_KEY in environment variables.';

export const modelConfigSchema = z.strictObject({
  apiKey: z.string({ error: MISSING_API_KEY_ERROR }).min(1, {
    error: MISSING_API_KEY_ERROR,
  }),
  baseURL: z.string().min(1),
  model: z.string().min(1),
  wireApi: z.enum(AGENT_MODEL_WIRE_APIS),
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

/**
 * Default directory for JSONL session rollouts, relative to the process working
 * directory. `lib/agent-shell-sandbox-macos.ts` carves out this same
 * project-relative path as read-only so the model cannot rewrite its own
 * transcript through the shell tool; the two values must move together.
 */
export const DEFAULT_AGENT_SESSION_ROOT = 'data/agent-sessions';

/**
 * Absolute directory that holds JSONL session rollouts.
 *
 * `AGENT_SESSION_ROOT` overrides the default; a relative value resolves against
 * the process working directory, an absolute value is used as is. Tests point
 * it at a fresh temp directory so a test run neither reads nor writes the real
 * transcripts: scanning that directory while a live run appends to a file can
 * otherwise read a half-written line.
 *
 * Read per call rather than once at module load, so a caller that sets the
 * variable after importing the store still gets the configured root.
 *
 * A root outside the project leaves the sandbox carveout above behind: the
 * shell tool blocks writes to `data/agent-sessions` by project-relative path,
 * not to wherever this resolves.
 */
export function readAgentSessionRootDirectory(): string {
  return resolve(
    process.cwd(),
    readOptionalEnvString('AGENT_SESSION_ROOT') ?? DEFAULT_AGENT_SESSION_ROOT,
  );
}

export function readModelConfig(modelOverride?: string): ReadModelConfigResult {
  const parsedConfig = modelConfigSchema.safeParse({
    apiKey: readOptionalEnvString('OPENAI_API_KEY'),
    baseURL: readOptionalEnvString('OPENAI_BASE_URL') ?? DEFAULT_BASE_URL,
    model:
      modelOverride ?? readOptionalEnvString('OPENAI_MODEL') ?? DEFAULT_MODEL,
    wireApi: readOptionalEnvString('OPENAI_WIRE_API') ?? DEFAULT_WIRE_API,
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
