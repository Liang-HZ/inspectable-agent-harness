import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { runAgentStream } from '../../../../lib/agent';
import type { AgentStreamEvent } from '../../../../lib/agent-api-types';
import { projectAgentEventToStreamEvent } from '../../../../lib/agent-stream-projection';
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

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.includes('aborted');
  }

  return false;
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
      // `run_failed` already reaches the client as an `error` stream event
      // through the projection; the catch below only sends a fallback for
      // failures that happen before the runtime can emit events (for
      // example, resuming an unknown sessionId).
      let errorStreamEventSent = false;

      try {
        const result = await runAgentStream(
          parsedInput.input,
          modelConfig.config,
          {
            runId: runId,
            signal: request.signal,
            approvalMode: 'interactive',
          },
          {
            onEvent: (event) => {
              const streamEvent = projectAgentEventToStreamEvent(event);

              if (streamEvent === undefined) {
                return;
              }

              if (streamEvent.type === 'error') {
                errorStreamEventSent = true;
              }

              controller.enqueue(encodeAgentStreamEvent(streamEvent));
            },
            onDebugEvent: (event) => {
              controller.enqueue(
                encodeAgentStreamEvent({
                  type: 'debug',
                  event: event,
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
      } catch (error) {
        if (request.signal.aborted || isAbortLikeError(error)) {
          logAgentInfo(runId, 'stream_request_aborted');
          return;
        }

        const message = errorMessage(error);
        logAgentError(runId, 'stream_request_failed', {
          error: message,
        });

        if (!errorStreamEventSent) {
          controller.enqueue(
            encodeAgentStreamEvent({
              type: 'error',
              error: message,
            }),
          );
        }
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
