import { NextRequest, NextResponse } from 'next/server';

import { readAgentSessionRecordsById } from '../../../../../lib/agent-session-store';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const params = await context.params;

  if (isBlank(params.id)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Agent session id is required.',
      },
      { status: 400 },
    );
  }

  try {
    const records = readAgentSessionRecordsById(params.id);

    if (records === undefined) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Agent session was not found.',
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      id: params.id,
      records: records,
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
