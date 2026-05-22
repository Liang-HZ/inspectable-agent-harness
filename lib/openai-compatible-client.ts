import OpenAI from "openai";

import type { ModelConfig } from "./env";

export function createOpenAICompatibleClient(config: Pick<ModelConfig, "apiKey" | "baseURL">) {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}
