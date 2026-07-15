import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { join, relative } from 'path';

import { applyAgentHistoryCompaction } from './agent-compaction';
import type { AgentEvent } from './agent-events';
import type { AgentModelWireApi } from './agent-model-types';
import type { AgentRunPolicy } from './agent-permissions';
import type { AgentResponseItem } from './agent-response-items';

export type AgentSessionSource = 'api_agent_stream';

export type AgentSession = {
  id: string;
  path: string;
};

export type AgentSessionSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  wireApi: AgentModelWireApi | undefined;
  approvalPolicy: AgentRunPolicy['approvalPolicy'];
  sandboxMode: AgentRunPolicy['sandboxMode'];
  recordCount: number;
  relativePath: string;
};

export type AgentSessionMeta = {
  id: string;
  timestamp: string;
  cwd: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  baseURL: string;
  wireApi?: AgentModelWireApi;
  policy: AgentRunPolicy;
};

export type AgentTurnContext = {
  turnId: string;
  model: string;
  wireApi: AgentModelWireApi;
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
    }
  | {
      timestamp: string;
      type: 'response_item';
      payload: AgentResponseItem;
    };

export type CreateAgentSessionInput = {
  id: string;
  cwd: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  baseURL: string;
  wireApi: AgentModelWireApi;
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

function sessionRootDirectory(): string {
  return join(process.cwd(), AGENT_SESSION_ROOT);
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
      wireApi: input.wireApi,
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

export function appendAgentResponseItem(
  session: AgentSession,
  item: AgentResponseItem,
): void {
  appendAgentSessionRecord(session, {
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: item,
  });
}

export function readAgentSessionRecords(path: string): AgentSessionRecord[] {
  const text = readFileSync(path, { encoding: 'utf8' });

  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AgentSessionRecord);
}

function readSessionMetaRecord(path: string): AgentSessionRecord {
  const firstLine = readFileSync(path, { encoding: 'utf8' }).split('\n')[0];

  if (firstLine === undefined || firstLine.trim() === '') {
    throw new Error(`Agent session file is empty: ${path}`);
  }

  return JSON.parse(firstLine) as AgentSessionRecord;
}

function countSessionRecords(path: string): number {
  return readFileSync(path, { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

function listAgentSessionPathsFromDirectory(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const paths: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...listAgentSessionPathsFromDirectory(path));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      paths.push(path);
    }
  }

  return paths;
}

function createAgentSessionSummary(path: string): AgentSessionSummary {
  const metaRecord = readSessionMetaRecord(path);

  if (metaRecord.type !== 'session_meta') {
    throw new Error(`Agent session file is missing session_meta: ${path}`);
  }

  const stats = statSync(path);

  return {
    id: metaRecord.payload.id,
    createdAt: metaRecord.payload.timestamp,
    updatedAt: stats.mtime.toISOString(),
    source: metaRecord.payload.source,
    modelProvider: metaRecord.payload.modelProvider,
    model: metaRecord.payload.model,
    wireApi: metaRecord.payload.wireApi,
    approvalPolicy: metaRecord.payload.policy.approvalPolicy,
    sandboxMode: metaRecord.payload.policy.sandboxMode,
    recordCount: countSessionRecords(path),
    relativePath: relative(process.cwd(), path),
  };
}

export function listAgentSessionSummaries(): AgentSessionSummary[] {
  return listAgentSessionPathsFromDirectory(sessionRootDirectory())
    .map((path) => createAgentSessionSummary(path))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findAgentSessionPathById(id: string): string | undefined {
  const paths = listAgentSessionPathsFromDirectory(sessionRootDirectory());

  for (const path of paths) {
    const metaRecord = readSessionMetaRecord(path);

    if (metaRecord.type === 'session_meta' && metaRecord.payload.id === id) {
      return path;
    }
  }

  return undefined;
}

export function readAgentSessionRecordsById(
  id: string,
): AgentSessionRecord[] | undefined {
  const path = findAgentSessionPathById(id);

  if (path === undefined) {
    return undefined;
  }

  return readAgentSessionRecords(path);
}

const SESSION_RESUME_INTERRUPTED_MESSAGE =
  'Error [SESSION_RESUME_INTERRUPTED]: This tool call did not finish before the previous run on this session ended, so no output was recorded. Treat it as not executed and decide whether to retry it.';

function createSynthesizedInterruptedOutput(
  functionCall: Extract<AgentResponseItem, { type: 'function_call' }>,
): AgentResponseItem {
  return {
    type: 'function_call_output',
    callId: functionCall.callId,
    toolName: functionCall.name,
    output: SESSION_RESUME_INTERRUPTED_MESSAGE,
    isError: true,
  };
}

export type AgentSessionHistoryNormalization = {
  history: AgentResponseItem[];
  synthesizedItems: AgentResponseItem[];
};

/**
 * Ensures every `function_call` has a matching `function_call_output`.
 * A crash or abort between committing a tool call and committing its output
 * leaves an orphan `function_call` in the JSONL; provider dialects require
 * every tool call to be answered, so replaying that history verbatim would
 * make the next model request invalid.
 */
export function normalizeAgentResponseItemHistory(
  items: AgentResponseItem[],
): AgentSessionHistoryNormalization {
  const outputCallIds = new Set(
    items
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.callId),
  );
  const synthesizedItems: AgentResponseItem[] = [];
  const history: AgentResponseItem[] = [];

  for (const item of items) {
    history.push(item);

    if (item.type !== 'function_call' || outputCallIds.has(item.callId)) {
      continue;
    }

    const synthesizedOutput = createSynthesizedInterruptedOutput(item);
    history.push(synthesizedOutput);
    synthesizedItems.push(synthesizedOutput);
  }

  return {
    history: history,
    synthesizedItems: synthesizedItems,
  };
}

function readAgentResponseItemsFromRecords(
  records: AgentSessionRecord[],
): AgentResponseItem[] {
  return records
    .filter((record): record is Extract<AgentSessionRecord, { type: 'response_item' }> =>
      record.type === 'response_item',
    )
    .map((record) => record.payload);
}

/**
 * Rebuilds the model-visible history by replaying persisted items in write
 * order. A `compaction_summary` row marks a point where the live run replaced
 * its history via `applyAgentHistoryCompaction`; because that transform is a
 * pure function of (history so far, summary text), replaying it here
 * reconstructs exactly the compacted history the live run continued with.
 * Without this replay, resuming a compacted session would send the full
 * uncompacted transcript back to the model.
 */
export function replayAgentResponseItemHistory(
  items: AgentResponseItem[],
): AgentResponseItem[] {
  let history: AgentResponseItem[] = [];

  for (const item of items) {
    if (item.type === 'compaction_summary') {
      history = applyAgentHistoryCompaction(history, item.content).history;
      continue;
    }

    history.push(item);
  }

  return history;
}

export type AgentSessionResumeResult =
  | {
      ok: true;
      session: AgentSession;
      history: AgentResponseItem[];
      synthesizedItems: AgentResponseItem[];
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Reopens an existing session for a new turn: reconstructs the model-visible
 * response-item history from persisted records and normalizes it, without
 * writing a new `session_meta` record. Callers append the new turn's items
 * (including any returned `synthesizedItems`) to the same file.
 */
export function resumeAgentSession(
  sessionId: string,
): AgentSessionResumeResult {
  const path = findAgentSessionPathById(sessionId);

  if (path === undefined) {
    return {
      ok: false,
      error: `Agent session not found: ${sessionId}`,
    };
  }

  const records = readAgentSessionRecords(path);
  const rawHistory = readAgentResponseItemsFromRecords(records);

  if (rawHistory.length === 0) {
    return {
      ok: false,
      error: `Agent session has no response history to resume: ${sessionId}`,
    };
  }

  const replayedHistory = replayAgentResponseItemHistory(rawHistory);
  const normalized = normalizeAgentResponseItemHistory(replayedHistory);

  return {
    ok: true,
    session: {
      id: sessionId,
      path: path,
    },
    history: normalized.history,
    synthesizedItems: normalized.synthesizedItems,
  };
}
