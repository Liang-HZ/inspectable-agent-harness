import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { runAgentStream } from '../../../../lib/agent';
import type { AgentStreamEvent } from '../../../../lib/agent-api-types';
import {
  logAgentError,
  logAgentInfo,
  logAgentInput,
  logAgentModelConfig,
} from '../../../../lib/agent-log';
import { parseAgentInput } from '../../../../lib/agent-input';
import { readModelConfig } from '../../../../lib/env';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown API error';
}

function encodeAgentStreamEvent(event: AgentStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  const runId = randomUUID();
  logAgentInfo(runId, 'stream_request_received');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAgentError(runId, 'invalid_json');
    return new Response('Request body must be valid JSON.', { status: 400 });
  }

  const parsedInput = parseAgentInput(body);
  if (!parsedInput.ok) {
    logAgentError(runId, 'input_validation_failed', {
      validationErrors: parsedInput.validationErrors,
    });

    return Response.json(
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

    return Response.json(
      { ok: false, error: modelConfig.error },
      { status: 500 },
    );
  }
  logAgentModelConfig(runId, modelConfig.config);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await runAgentStream(
          parsedInput.input,
          modelConfig.config,
          {
            runId: runId,
          },
          {
            onStep: (step) => {
              controller.enqueue(
                encodeAgentStreamEvent({
                  type: 'step',
                  step: step,
                }),
              );
            },
            onAnswerDelta: (delta) => {
              controller.enqueue(
                encodeAgentStreamEvent({
                  type: 'answerDelta',
                  delta: delta,
                }),
              );
            },
          },
        );

        logAgentInfo(runId, 'stream_request_finished', {
          model: result.model,
          stepCount: result.steps.length,
          answer: result.answer,
          answerLength: result.answer.length,
          result: result,
        });

        controller.enqueue(
          encodeAgentStreamEvent({
            type: 'done',
            result: result,
          }),
        );
      } catch (error) {
        const message = errorMessage(error);
        logAgentError(runId, 'stream_request_failed', {
          error: message,
        });
        controller.enqueue(
          encodeAgentStreamEvent({
            type: 'error',
            error: message,
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
