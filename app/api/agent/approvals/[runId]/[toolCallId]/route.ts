import { NextRequest, NextResponse } from 'next/server';

import { parseAgentApprovalInput } from '../../../../../../lib/agent-approval-input';
import { resolveAgentApproval } from '../../../../../../lib/agent-approvals';

export const runtime = 'nodejs';

function isBlank(value: string): boolean {
  return value.trim() === '';
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string; toolCallId: string }> },
) {
  const params = await context.params;

  if (isBlank(params.runId) || isBlank(params.toolCallId)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Run id and tool call id are required.',
      },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsedInput = parseAgentApprovalInput(body);
  if (!parsedInput.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: parsedInput.error,
        validationErrors: parsedInput.validationErrors,
      },
      { status: 400 },
    );
  }

  const result = resolveAgentApproval(
    params.runId,
    params.toolCallId,
    parsedInput.input.decision,
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    pending: result.pending,
    resolution: result.resolution,
  });
}
