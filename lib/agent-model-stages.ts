export const AGENT_MODEL_STAGES = [
  'tool_or_answer_selection',
  'answer_generation',
] as const;

export type AgentModelStage = (typeof AGENT_MODEL_STAGES)[number];
