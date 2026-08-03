import { NextRequest, NextResponse } from 'next/server';

import {
  getObservabilityBackends,
  readObservabilityStackStatus,
  stopObservabilityStack,
  type ObservabilityBackendId,
} from '../../../lib/observability-stack';
import { exportAgentSessionToOtlp } from '../../../lib/agent-otel-export';
import { findAgentSessionPathById } from '../../../lib/agent-session-store';

export const runtime = 'nodejs';

/**
 * Local control plane for the observability backends.
 *
 * Deliberately a closed set of actions. The request never names a container, a
 * command, or an endpoint — it names an intent, and everything else comes from
 * `lib/observability-stack.ts`. That is what keeps a route that can run
 * `docker stop` from being a remote shell.
 */

type PostBody = {
  action?: unknown;
  sessionId?: unknown;
  backendId?: unknown;
};

function badRequest(error: string) {
  return NextResponse.json({ ok: false, error: error }, { status: 400 });
}

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      status: await readObservabilityStackStatus(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

function isBackendId(value: unknown): value is ObservabilityBackendId {
  return value === 'phoenix' || value === 'langfuse';
}

async function handleExport(body: PostBody) {
  if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
    return badRequest('sessionId is required to export a run.');
  }

  if (!isBackendId(body.backendId)) {
    return badRequest('backendId must be "phoenix" or "langfuse".');
  }

  // Resolved through the session store rather than taken as a path, so a
  // request cannot ask the server to read an arbitrary file.
  const sessionPath = findAgentSessionPathById(body.sessionId);

  if (sessionPath === undefined) {
    return NextResponse.json(
      { ok: false, error: `Session not found: ${body.sessionId}` },
      { status: 404 },
    );
  }

  const backend = getObservabilityBackends().find(
    (candidate) => candidate.id === body.backendId,
  );

  if (backend === undefined) {
    return badRequest('Unknown backend.');
  }

  const headers: Record<string, string> = {};
  if (backend.publicKey !== undefined && backend.secretKey !== undefined) {
    headers.authorization = `Basic ${Buffer.from(
      `${backend.publicKey}:${backend.secretKey}`,
    ).toString('base64')}`;
  }

  const result = await exportAgentSessionToOtlp(sessionPath, {
    endpoint: backend.otlpEndpoint,
    headers: headers,
    serviceName: 'inspectable-agent-harness',
  });

  return NextResponse.json({ ok: result.ok, export: result });
}

export async function POST(request: NextRequest) {
  let body: PostBody;

  try {
    body = (await request.json()) as PostBody;
  } catch {
    return badRequest('Request body must be JSON.');
  }

  if (body.action === 'stop') {
    return NextResponse.json({
      ok: true,
      stop: await stopObservabilityStack(),
      status: await readObservabilityStackStatus(),
    });
  }

  if (body.action === 'export') {
    return handleExport(body);
  }

  return badRequest('action must be "stop" or "export".');
}
