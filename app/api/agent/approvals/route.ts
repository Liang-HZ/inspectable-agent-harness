import { NextRequest, NextResponse } from 'next/server';

import { listPendingAgentApprovals } from '../../../../lib/agent-approvals';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get('runId') ?? undefined;

  return NextResponse.json({
    ok: true,
    pending: listPendingAgentApprovals(runId),
  });
}
