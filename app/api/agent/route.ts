import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { runAgent } from '../../../lib/agent';
import {
  logAgentError,
  logAgentInfo,
  logAgentInput,
  logAgentModelConfig,
} from '../../../lib/agent-log';
import { parseAgentInput } from '../../../lib/agent-input';
import { readModelConfig } from '../../../lib/env';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

export async function POST(request: NextRequest) {
  const runId = randomUUID();
  logAgentInfo(runId, 'request_received');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAgentError(runId, 'invalid_json');

    return NextResponse.json(
      { ok: false, error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsedInput = parseAgentInput(body);
  if (!parsedInput.ok) {
    logAgentError(runId, 'input_validation_failed', {
      validationErrors: parsedInput.validationErrors,
    });

    return NextResponse.json(
      {
        ok: false,
        error: parsedInput.error,
        validationErrors: parsedInput.validationErrors,
      },
      { status: 400 },
    );
  }
  logAgentInput(runId, parsedInput.input);

  const modelConfig = readModelConfig(parsedInput.input.model);
  if (!modelConfig.ok) {
    logAgentError(runId, 'model_config_failed', {
      error: modelConfig.error,
    });

    return NextResponse.json(
      { ok: false, error: modelConfig.error },
      { status: 500 },
    );
  }
  logAgentModelConfig(runId, modelConfig.config);

  try {
    const result = await runAgent(parsedInput.input, modelConfig.config, {
      runId: runId,
      signal: request.signal,
    });
    logAgentInfo(runId, 'request_finished', {
      model: result.model,
      stepCount: result.steps.length,
      answer: result.answer,
      answerLength: result.answer.length,
      result: result,
    });

    return NextResponse.json({ ok: true, result: result });
  } catch (error) {
    logAgentError(runId, 'request_failed', {
      error: errorMessage(error),
    });

    return NextResponse.json(
      { ok: false, error: errorMessage(error) },
      { status: 502 },
    );
  }
}
