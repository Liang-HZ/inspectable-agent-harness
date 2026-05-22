import { NextRequest, NextResponse } from 'next/server';

import { callChatModel } from '../../../lib/chat';
import { parseChatInput } from '../../../lib/chat-input';
import { readModelConfig } from '../../../lib/env';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsedInput = parseChatInput(body);
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

  const modelConfig = readModelConfig(parsedInput.input.model);
  if (!modelConfig.ok) {
    return NextResponse.json(
      { ok: false, error: modelConfig.error },
      { status: 500 },
    );
  }

  try {
    const result = await callChatModel(parsedInput.input, modelConfig.config);
    return NextResponse.json({ ok: true, result: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: errorMessage(error) },
      { status: 502 },
    );
  }
}
