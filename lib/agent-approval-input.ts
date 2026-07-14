import * as z from 'zod';

import type { AgentApprovalUserDecision } from './agent-approvals';

const REQUEST_BODY_VALIDATION_ERROR = 'Request body validation failed.';

const agentApprovalRequestBodySchema = z.strictObject(
  {
    decision: z.enum(['approve', 'deny'], {
      error: (issue) =>
        issue.input === undefined
          ? 'Field `decision` is required.'
          : 'Field `decision` must be `approve` or `deny`.',
    }),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'Request body contains unknown fields.'
        : 'Request body must be a JSON object.',
  },
);

export type AgentApprovalInput = {
  decision: AgentApprovalUserDecision;
};

export type AgentApprovalInputValidationErrors = {
  formErrors: string[];
  fieldErrors: {
    decision?: string[];
  };
};

export type AgentApprovalInputParseResult =
  | {
      ok: true;
      input: AgentApprovalInput;
    }
  | {
      ok: false;
      error: string;
      validationErrors: AgentApprovalInputValidationErrors;
    };

export function parseAgentApprovalInput(
  body: unknown,
): AgentApprovalInputParseResult {
  const parsedBody = agentApprovalRequestBodySchema.safeParse(body);

  if (!parsedBody.success) {
    return {
      ok: false,
      error: REQUEST_BODY_VALIDATION_ERROR,
      validationErrors: z.flattenError(parsedBody.error),
    };
  }

  return {
    ok: true,
    input: {
      decision: parsedBody.data.decision,
    },
  };
}
