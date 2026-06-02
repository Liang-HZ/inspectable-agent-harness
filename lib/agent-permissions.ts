import type {
  AgentToolCategory,
  AgentToolExecutionMode,
  AgentToolGroupName,
  AgentToolSource,
} from './agent-tool-contracts';
import type { AgentToolPathAccessPolicy } from './agent-path-policy';

export type AgentToolAnnotations = {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  idempotent?: boolean;
};

export type AgentApprovalPolicy = 'strict' | 'on_request' | 'never';

export type AgentSandboxMode =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';

export type AgentRunPolicy = {
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
};

export type AgentPermissionDecisionSource =
  | 'annotation'
  | 'policy'
  | 'tool_override'
  | 'hook'
  | 'user'
  | 'guardian';

export type AgentPermissionRequest = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  annotations: AgentToolAnnotations;
  source: AgentToolSource;
  group: AgentToolGroupName;
  category: AgentToolCategory;
  pathAccess: AgentToolPathAccessPolicy;
  executionMode: AgentToolExecutionMode;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
};

export type AgentPermissionDecision =
  | {
      type: 'allow';
      source: AgentPermissionDecisionSource;
      reason: string;
    }
  | {
      type: 'ask';
      source: AgentPermissionDecisionSource;
      reason: string;
    }
  | {
      type: 'deny';
      source: AgentPermissionDecisionSource;
      reason: string;
    };

export type AgentApprovalRequiredDecision = Extract<
  AgentPermissionDecision,
  { type: 'ask' }
>;

export type AgentPermissionDeniedDecision = Extract<
  AgentPermissionDecision,
  { type: 'deny' }
>;

export class AgentApprovalRequiredError extends Error {
  readonly request: AgentPermissionRequest;
  readonly decision: AgentApprovalRequiredDecision;

  constructor(
    request: AgentPermissionRequest,
    decision: AgentApprovalRequiredDecision,
  ) {
    super(
      `Tool \`${request.toolName}\` requires approval, but interactive approval is not implemented yet: ${decision.reason}`,
    );
    this.name = 'AgentApprovalRequiredError';
    this.request = request;
    this.decision = decision;
  }
}

export class AgentPermissionDeniedError extends Error {
  readonly request: AgentPermissionRequest;
  readonly decision: AgentPermissionDeniedDecision;

  constructor(
    request: AgentPermissionRequest,
    decision: AgentPermissionDeniedDecision,
  ) {
    super(
      `Tool \`${request.toolName}\` was denied by permission policy: ${decision.reason}`,
    );
    this.name = 'AgentPermissionDeniedError';
    this.request = request;
    this.decision = decision;
  }
}

export const DEFAULT_AGENT_RUN_POLICY = {
  approvalPolicy: 'on_request',
  sandboxMode: 'read_only',
} satisfies AgentRunPolicy;

function hasKnownSafeAnnotations(annotations: AgentToolAnnotations): boolean {
  return (
    annotations.readOnly === true &&
    annotations.destructive === false &&
    annotations.openWorld === false
  );
}

function hasKnownRiskyAnnotations(annotations: AgentToolAnnotations): boolean {
  return annotations.destructive === true || annotations.openWorld === true;
}

export function decideAgentToolPermission(
  request: AgentPermissionRequest,
): AgentPermissionDecision {
  if (request.approvalPolicy === 'never') {
    return {
      type: 'allow',
      source: 'policy',
      reason: 'Approval policy is never, so the tool call is auto-approved.',
    };
  }

  if (hasKnownSafeAnnotations(request.annotations)) {
    return {
      type: 'allow',
      source: 'annotation',
      reason:
        'Tool annotations mark this call as read-only, non-destructive, and closed-world.',
    };
  }

  if (hasKnownRiskyAnnotations(request.annotations)) {
    return {
      type: 'ask',
      source: 'annotation',
      reason:
        'Tool annotations mark this call as destructive or open-world, so user approval is required.',
    };
  }

  if (request.approvalPolicy === 'strict') {
    return {
      type: 'ask',
      source: 'policy',
      reason:
        'Strict approval policy requires approval unless tool annotations prove the call is safe.',
    };
  }

  return {
    type: 'ask',
    source: 'policy',
    reason:
      'Tool annotations are incomplete, so the default on-request policy requires approval.',
  };
}
