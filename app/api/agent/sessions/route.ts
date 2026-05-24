import { NextResponse } from 'next/server';

import { listAgentSessionSummaries } from '../../../../lib/agent-session-store';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

export async function GET() {
  try {
    const sessions = listAgentSessionSummaries();

    return NextResponse.json({
      ok: true,
      sessions: sessions,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: errorMessage(error),
      },
      { status: 500 },
    );
  }
}
