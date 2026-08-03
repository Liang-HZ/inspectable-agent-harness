import path from 'node:path';

import {
  DEFAULT_AGENT_RUN_POLICY,
  type AgentRunPolicy,
} from './agent-permissions';
import { createRootSpanContext, type AgentSpanContext } from './agent-trace';
import type { AgentSubagentSpawner } from './agent-subagent';

export type AgentApprovalMode = 'interactive' | 'fail_closed';

export type AgentRunContextInput = {
  runId: string;
  signal?: AbortSignal;
  policy?: AgentRunPolicy;
  approvalMode?: AgentApprovalMode;
  /**
   * The run's root span. Omitted for a top-level run, which starts a fresh
   * trace. A subagent passes the span derived from its parent's `task` tool
   * call, which is what stitches the two session files into one waterfall.
   */
  span?: AgentSpanContext;
  /** 0 for a top-level run, incremented for every derived subagent run. */
  spawnDepth?: number;
  /**
   * How this run derives subagents. Absent for runs that cannot — the `task`
   * tool is then hidden rather than exposed and made to fail.
   */
  spawnSubagent?: AgentSubagentSpawner;
};

export type AgentRunContext = {
  runId: string;
  signal: AbortSignal | undefined;
  policy: AgentRunPolicy;
  approvalMode: AgentApprovalMode;
  toolState: AgentRunToolState;
  span: AgentSpanContext;
  spawnDepth: number;
  spawnSubagent: AgentSubagentSpawner | undefined;
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
      // Deliberately not inherited by a subagent: read-before-edit state is a
      // safety interlock, and a derived run has to earn it by reading the file
      // itself. See `createSubagentRunContext`.
      readFilePaths: new Set<string>(),
    },
    span: input.span ?? createRootSpanContext(),
    spawnDepth: input.spawnDepth ?? 0,
    spawnSubagent: input.spawnSubagent,
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
