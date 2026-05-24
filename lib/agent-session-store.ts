import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

import type { AgentEvent } from './agent-events';
import type { AgentRunPolicy } from './agent-permissions';

export type AgentSessionSource = 'api_agent_stream';

export type AgentSession = {
  id: string;
  path: string;
};

export type AgentSessionMeta = {
  id: string;
  timestamp: string;
  cwd: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  baseURL: string;
  policy: AgentRunPolicy;
};

export type AgentTurnContext = {
  turnId: string;
  model: string;
  approvalPolicy: AgentRunPolicy['approvalPolicy'];
  sandboxMode: AgentRunPolicy['sandboxMode'];
  temperature: number | undefined;
};

export type AgentSessionRecord =
  | {
      timestamp: string;
      type: 'session_meta';
      payload: AgentSessionMeta;
    }
  | {
      timestamp: string;
      type: 'turn_context';
      payload: AgentTurnContext;
    }
  | {
      timestamp: string;
      type: 'agent_event';
      payload: AgentEvent;
    };

export type CreateAgentSessionInput = {
  id: string;
  cwd: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  baseURL: string;
  policy: AgentRunPolicy;
};

const AGENT_SESSION_ROOT = 'data/agent-sessions';

function safeTimestampForFilename(timestamp: string): string {
  return timestamp.replace(/:/g, '-').replace(/\./g, '-');
}

function sessionDirectory(timestamp: Date): string {
  const year = String(timestamp.getUTCFullYear()).padStart(4, '0');
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');

  return join(process.cwd(), AGENT_SESSION_ROOT, year, month, day);
}

function createSessionPath(id: string, timestamp: Date): string {
  const timestampText = timestamp.toISOString();
  const filename = `rollout-${safeTimestampForFilename(timestampText)}-${id}.jsonl`;

  return join(sessionDirectory(timestamp), filename);
}

function appendAgentSessionRecord(
  session: AgentSession,
  record: AgentSessionRecord,
): void {
  appendFileSync(session.path, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
  });
}

export function createAgentSession(
  input: CreateAgentSessionInput,
): AgentSession {
  const timestamp = new Date();
  const timestampText = timestamp.toISOString();
  const path = createSessionPath(input.id, timestamp);

  mkdirSync(sessionDirectory(timestamp), { recursive: true });

  const session = {
    id: input.id,
    path: path,
  } satisfies AgentSession;

  appendAgentSessionRecord(session, {
    timestamp: timestampText,
    type: 'session_meta',
    payload: {
      id: input.id,
      timestamp: timestampText,
      cwd: input.cwd,
      source: input.source,
      modelProvider: input.modelProvider,
      model: input.model,
      baseURL: input.baseURL,
      policy: input.policy,
    },
  });

  return session;
}

export function appendAgentTurnContext(
  session: AgentSession,
  turnContext: AgentTurnContext,
): void {
  appendAgentSessionRecord(session, {
    timestamp: new Date().toISOString(),
    type: 'turn_context',
    payload: turnContext,
  });
}

export function appendAgentSessionEvent(
  session: AgentSession,
  event: AgentEvent,
): void {
  appendAgentSessionRecord(session, {
    timestamp: new Date().toISOString(),
    type: 'agent_event',
    payload: event,
  });
}

export function readAgentSessionRecords(path: string): AgentSessionRecord[] {
  const text = readFileSync(path, { encoding: 'utf8' });

  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AgentSessionRecord);
}
