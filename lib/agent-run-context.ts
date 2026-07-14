import path from 'node:path';

import {
  DEFAULT_AGENT_RUN_POLICY,
  type AgentRunPolicy,
} from './agent-permissions';

export type AgentApprovalMode = 'interactive' | 'fail_closed';

export type AgentRunContextInput = {
  runId: string;
  signal?: AbortSignal;
  policy?: AgentRunPolicy;
  approvalMode?: AgentApprovalMode;
};

export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
  policy: AgentRunPolicy;
  approvalMode: AgentApprovalMode;
  toolState: AgentRunToolState;
};

export type AgentRunToolState = {
  readFilePaths: Set<string>;
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
    approvalMode: input.approvalMode ?? 'fail_closed',
    toolState: {
      readFilePaths: new Set<string>(),
    },
  };
}

export function assertAgentRunNotAborted(context: AgentRunContext): void {
  if (context.signal?.aborted) {
    throw new Error('Agent run aborted.');
  }
}

function normalizeAgentToolStatePath(absolutePath: string): string {
  return path.resolve(absolutePath);
}

export function markAgentFileRead(
  context: AgentRunContext,
  absolutePath: string,
): void {
  context.toolState.readFilePaths.add(
    normalizeAgentToolStatePath(absolutePath),
  );
}

export function hasAgentFileReadRecord(
  context: AgentRunContext,
  absolutePath: string,
): boolean {
  return context.toolState.readFilePaths.has(
    normalizeAgentToolStatePath(absolutePath),
  );
}
