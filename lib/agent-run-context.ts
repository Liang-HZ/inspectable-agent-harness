import {
  DEFAULT_AGENT_RUN_POLICY,
  type AgentRunPolicy,
} from './agent-permissions';

export type AgentRunContextInput = {
  runId: string;
  signal?: AbortSignal;
  policy?: AgentRunPolicy;
};

export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
  policy: AgentRunPolicy;
};

export function createAgentRunContext(
  input: AgentRunContextInput,
): AgentRunContext {
  const policy =
    input.policy === undefined
      ? {
          approvalPolicy: DEFAULT_AGENT_RUN_POLICY.approvalPolicy,
          sandboxMode: DEFAULT_AGENT_RUN_POLICY.sandboxMode,
        }
      : input.policy;

  return {
    runId: input.runId,
    signal: input.signal,
    policy: policy,
  };
}

export function assertAgentRunNotAborted(context: AgentRunContext): void {
  if (context.signal?.aborted) {
    throw new Error('Agent run aborted.');
  }
}
