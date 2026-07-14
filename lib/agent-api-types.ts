import * as z from 'zod';

import { AGENT_MODEL_STAGES } from './agent-model-stages';
import type { AgentModelStage } from './agent-model-stages';
import type {
  AgentModelAssistantMessage,
  AgentModelRequest,
  AgentModelToolCall,
  AgentModelUsageSnapshot,
  AgentModelWireApi,
} from './agent-model-types';
import type { AgentApprovalResolution } from './agent-approvals';
import type {
  AgentApprovalPolicy,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunPolicy,
  AgentSandboxMode,
} from './agent-permissions';
import type { AgentResponseItem } from './agent-response-items';

export type AgentRequestBody = {
  task: string;
  goal: string | undefined;
  context: string | undefined;
  model: string | undefined;
  temperature: string | undefined;
  approvalPolicy: AgentApprovalPolicy | undefined;
  sandboxMode: AgentSandboxMode | undefined;
};

export const agentStepSchema = z.strictObject({
  order: z.number(),
  title: z.string(),
  detail: z.string(),
  output: z.unknown().optional(),
});

export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentTokenUsageSchema = z.strictObject({
  inputTokens: z.number(),
  cachedInputTokens: z.number().nullable(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
});

export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;

export const agentModelCallUsageSchema = z.strictObject({
  stage: z.enum(AGENT_MODEL_STAGES),
  tokenUsage: agentTokenUsageSchema.nullable(),
  rawUsage: z.unknown(),
});

export type AgentModelCallUsage = z.infer<typeof agentModelCallUsageSchema>;

export const agentUsageSchema = z.strictObject({
  totalTokenUsage: agentTokenUsageSchema,
  lastTokenUsage: agentTokenUsageSchema.nullable(),
  calls: z.array(agentModelCallUsageSchema),
});

export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const agentResultSchema = z.strictObject({
  model: z.string(),
  answer: z.string(),
  steps: z.array(agentStepSchema),
  usage: agentUsageSchema,
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export type AgentToolDebugRequest = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
};

export type AgentDebugStreamEvent =
  | {
      type: 'runStarted';
      runId: string;
      policy: AgentRunPolicy;
    }
  | {
      type: 'modelStarted';
      stage: AgentModelStage;
    }
  | {
      type: 'modelRequested';
      round: number;
      model: string;
      wireApi: AgentModelWireApi;
      request: AgentModelRequest;
    }
  | {
      type: 'modelCompleted';
      round: number;
      model: string;
      streamedAssistantText: string;
      assistantMessages: AgentModelAssistantMessage[];
      toolCalls: AgentModelToolCall[];
      usage: AgentModelUsageSnapshot;
    }
  | {
      type: 'historyCommitted';
      items: AgentResponseItem[];
    }
  | {
      type: 'toolRequested';
      toolRequests: AgentToolDebugRequest[];
    }
  | {
      type: 'toolStarted';
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
    }
  | {
      type: 'toolFinished';
      toolCallId: string;
      toolName: string;
      input: unknown;
      result: unknown;
      modelOutput: string;
      isError: boolean;
    }
  | {
      type: 'toolPermissionDecided';
      request: AgentPermissionRequest;
      decision: AgentPermissionDecision;
    }
  | {
      type: 'approvalRequested';
      request: AgentPermissionRequest;
      decision: AgentPermissionDecision;
    }
  | {
      type: 'approvalResolved';
      toolCallId: string;
      toolName: string;
      resolution: AgentApprovalResolution;
    }
  | {
      type: 'runCancelled';
      reason: string;
    };

export type AgentApprovalStreamRequest = {
  runId: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
};

export type AgentStreamEvent =
  | {
      type: 'step';
      step: AgentStep;
    }
  | {
      type: 'assistantDelta';
      delta: string;
    }
  | {
      type: 'approvalRequired';
      request: AgentApprovalStreamRequest;
    }
  | {
      type: 'approvalResolved';
      runId: string;
      toolCallId: string;
      toolName: string;
      resolution: AgentApprovalResolution;
    }
  | {
      type: 'debug';
      event: AgentDebugStreamEvent;
    }
  | {
      type: 'done';
      result: AgentResult;
    }
  | {
      type: 'error';
      error: string;
    };

export const agentInputValidationErrorsSchema = z.strictObject({
  formErrors: z.array(z.string()),
  fieldErrors: z.strictObject({
    task: z.array(z.string()).optional(),
    goal: z.array(z.string()).optional(),
    context: z.array(z.string()).optional(),
    model: z.array(z.string()).optional(),
    temperature: z.array(z.string()).optional(),
    approvalPolicy: z.array(z.string()).optional(),
    sandboxMode: z.array(z.string()).optional(),
  }),
});

export type AgentInputValidationErrors = z.infer<
  typeof agentInputValidationErrorsSchema
>;

export const agentApiResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: agentResultSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string(),
    validationErrors: agentInputValidationErrorsSchema.optional(),
  }),
]);

export type AgentApiResponse = z.infer<typeof agentApiResponseSchema>;
