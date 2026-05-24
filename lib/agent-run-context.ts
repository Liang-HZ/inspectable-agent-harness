export type AgentRunContextInput = {
  runId: string;
  signal?: AbortSignal;
};

export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
};

export function createAgentRunContext(
  input: AgentRunContextInput,
): AgentRunContext {
  return {
    runId: input.runId,
    signal: input.signal,
  };
}

export function assertAgentRunNotAborted(context: AgentRunContext): void {
  if (context.signal?.aborted) {
    throw new Error('Agent run aborted.');
  }
}
