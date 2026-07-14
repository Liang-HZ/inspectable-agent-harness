export const APPROVAL_WAIT_TIMEOUT_MS = 120_000;

export type AgentApprovalUserDecision = 'approve' | 'deny';

export type AgentApprovalResolution =
  | {
      type: 'approved';
      source: 'user';
    }
  | {
      type: 'denied';
      source: 'user' | 'timeout' | 'abort';
      reason: string;
    };

export type PendingAgentApproval = {
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  requestedAt: string;
};

type PendingAgentApprovalEntry = PendingAgentApproval & {
  settle: (resolution: AgentApprovalResolution) => void;
};

type AgentApprovalRegistry = Map<string, PendingAgentApprovalEntry>;

type ResolveAgentApprovalResult =
  | {
      ok: true;
      pending: PendingAgentApproval;
      resolution: AgentApprovalResolution;
    }
  | {
      ok: false;
      error: string;
    };

// The registry is stashed on globalThis because Next.js can bundle the
// stream route and the approvals route as separate module instances of this
// file. Pending approvals are process-local on purpose: like Codex and
// Claude Code, a dead server process means the approval is denied, and the
// durable record lives in the session JSONL events instead.
const AGENT_APPROVAL_REGISTRY_KEY = Symbol.for(
  'myJsTest.agentApprovalRegistry',
);

function getAgentApprovalRegistry(): AgentApprovalRegistry {
  const globalStash = globalThis as {
    [AGENT_APPROVAL_REGISTRY_KEY]?: AgentApprovalRegistry;
  };

  if (globalStash[AGENT_APPROVAL_REGISTRY_KEY] === undefined) {
    globalStash[AGENT_APPROVAL_REGISTRY_KEY] = new Map();
  }

  return globalStash[AGENT_APPROVAL_REGISTRY_KEY];
}

function pendingApprovalKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

export function waitForAgentApproval(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  signal: AbortSignal | undefined;
  timeoutMs?: number;
}): Promise<AgentApprovalResolution> {
  const registry = getAgentApprovalRegistry();
  const key = pendingApprovalKey(input.runId, input.toolCallId);
  const timeoutMs = input.timeoutMs ?? APPROVAL_WAIT_TIMEOUT_MS;

  return new Promise<AgentApprovalResolution>((resolve) => {
    let settled = false;

    function settle(resolution: AgentApprovalResolution): void {
      if (settled) {
        return;
      }

      settled = true;
      registry.delete(key);
      clearTimeout(timeoutHandle);
      input.signal?.removeEventListener('abort', handleAbort);
      resolve(resolution);
    }

    function handleAbort(): void {
      settle({
        type: 'denied',
        source: 'abort',
        reason: 'The run was cancelled while waiting for approval.',
      });
    }

    const timeoutHandle = setTimeout(() => {
      settle({
        type: 'denied',
        source: 'timeout',
        reason: `The approval request timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    if (input.signal?.aborted) {
      handleAbort();
      return;
    }

    input.signal?.addEventListener('abort', handleAbort, { once: true });

    registry.set(key, {
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argumentsJson: input.argumentsJson,
      reason: input.reason,
      requestedAt: new Date().toISOString(),
      settle: settle,
    });
  });
}

export function resolveAgentApproval(
  runId: string,
  toolCallId: string,
  decision: AgentApprovalUserDecision,
): ResolveAgentApprovalResult {
  const registry = getAgentApprovalRegistry();
  const key = pendingApprovalKey(runId, toolCallId);
  const entry = registry.get(key);

  if (entry === undefined) {
    return {
      ok: false,
      error: `No pending approval found for run ${runId} and tool call ${toolCallId}. It may have already been resolved or timed out.`,
    };
  }

  const resolution: AgentApprovalResolution =
    decision === 'approve'
      ? {
          type: 'approved',
          source: 'user',
        }
      : {
          type: 'denied',
          source: 'user',
          reason: 'The user declined this tool call.',
        };

  const pending: PendingAgentApproval = {
    runId: entry.runId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    argumentsJson: entry.argumentsJson,
    reason: entry.reason,
    requestedAt: entry.requestedAt,
  };

  entry.settle(resolution);

  return {
    ok: true,
    pending: pending,
    resolution: resolution,
  };
}

export function listPendingAgentApprovals(
  runId?: string,
): PendingAgentApproval[] {
  const registry = getAgentApprovalRegistry();

  return [...registry.values()]
    .filter((entry) => runId === undefined || entry.runId === runId)
    .map((entry) => ({
      runId: entry.runId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      argumentsJson: entry.argumentsJson,
      reason: entry.reason,
      requestedAt: entry.requestedAt,
    }));
}
