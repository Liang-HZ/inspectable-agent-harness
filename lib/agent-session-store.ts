import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, relative } from 'path';

import { applyAgentHistoryCompaction } from './agent-compaction';
import type { AgentEvent } from './agent-events';
import type { AgentModelWireApi } from './agent-model-types';
import type { AgentRunPolicy } from './agent-permissions';
import type { AgentResponseItem } from './agent-response-items';
import { readAgentSessionRootDirectory } from './env';

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
  /**
   * Present only on a subagent session. Named after Claude Code's own session
   * files, which mark derived runs with `isSidechain: true` and join them back
   * to the parent through the id of the tool call that spawned them.
   */
  sidechain?: AgentSidechainMeta;
};

export type AgentSidechainMeta = {
  isSidechain: true;
  agentId: string;
  agentType: string;
  description: string;
  /** The parent's `task` tool call id — the join key back to the parent run. */
  toolCallId: string;
  parentSessionId: string;
  spawnDepth: number;
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

/**
 * Sidecar directory names, kept next to a session file under a directory named
 * after it (the file name minus `.jsonl`). Same layout Claude Code uses:
 *
 *   rollout-<ts>-<id>.jsonl
 *   rollout-<ts>-<id>/subagents/agent-<agentId>.jsonl
 *   rollout-<ts>-<id>/subagents/agent-<agentId>.meta.json
 *
 * A subagent gets its own file rather than interleaved records in the parent's,
 * because it runs on an independent context window — folding its history into
 * the parent would corrupt the parent's replay.
 *
 * This is a name, not a root: subagent paths are derived from the parent
 * session's own path, so they follow `readAgentSessionRootDirectory()` wherever
 * it points — including a test's temp directory.
 */
const SUBAGENTS_DIRECTORY = 'subagents';

function safeTimestampForFilename(timestamp: string): string {
  return timestamp.replace(/:/g, '-').replace(/\./g, '-');
}

// The root comes from `readAgentSessionRootDirectory()` (default
// `<cwd>/data/agent-sessions`, overridable with AGENT_SESSION_ROOT) rather than
// from a constant here, so a test process can point the whole store at a temp
// directory instead of reading and writing the real transcripts.
function sessionDirectory(timestamp: Date): string {
  const year = String(timestamp.getUTCFullYear()).padStart(4, '0');
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');

  return join(readAgentSessionRootDirectory(), year, month, day);
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

/** The sidecar directory for a session: its own path with `.jsonl` removed. */
function sessionSidecarDirectory(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, '');
}

export function subagentsDirectory(sessionPath: string): string {
  return join(sessionSidecarDirectory(sessionPath), SUBAGENTS_DIRECTORY);
}

export type CreateSubagentSessionInput = {
  parentSession: AgentSession;
  parentSessionId: string;
  agentId: string;
  agentType: string;
  description: string;
  toolCallId: string;
  spawnDepth: number;
  cwd: string;
  source: AgentSessionSource;
  modelProvider: string;
  model: string;
  baseURL: string;
  wireApi: AgentModelWireApi;
  policy: AgentRunPolicy;
};

/**
 * Opens a session file for a derived subagent run, next to its parent.
 *
 * The `.meta.json` sidecar duplicates what is already in the first JSONL record
 * on purpose: it lets a reader enumerate a run's children by listing a
 * directory and parsing tiny files, without opening (possibly very large)
 * transcripts.
 */
export function createSubagentSession(
  input: CreateSubagentSessionInput,
): AgentSession {
  const timestampText = new Date().toISOString();
  const directory = subagentsDirectory(input.parentSession.path);
  const path = join(directory, `agent-${input.agentId}.jsonl`);

  mkdirSync(directory, { recursive: true });

  const session = {
    id: input.agentId,
    path: path,
  } satisfies AgentSession;

  appendAgentSessionRecord(session, {
    timestamp: timestampText,
    type: 'session_meta',
    payload: {
      id: input.agentId,
      timestamp: timestampText,
      cwd: input.cwd,
      source: input.source,
      modelProvider: input.modelProvider,
      model: input.model,
      baseURL: input.baseURL,
      wireApi: input.wireApi,
      policy: input.policy,
      sidechain: {
        isSidechain: true,
        agentId: input.agentId,
        agentType: input.agentType,
        description: input.description,
        toolCallId: input.toolCallId,
        parentSessionId: input.parentSessionId,
        spawnDepth: input.spawnDepth,
      },
    },
  });

  writeFileSync(
    join(directory, `agent-${input.agentId}.meta.json`),
    `${JSON.stringify({
      agentId: input.agentId,
      agentType: input.agentType,
      description: input.description,
      toolCallId: input.toolCallId,
      parentSessionId: input.parentSessionId,
      spawnDepth: input.spawnDepth,
      timestamp: timestampText,
    })}\n`,
    { encoding: 'utf8' },
  );

  return session;
}

export type AgentSubagentSessionSummary = {
  agentId: string;
  agentType: string;
  description: string;
  toolCallId: string;
  spawnDepth: number;
  path: string;
  relativePath: string;
};

/**
 * Lists the subagent runs spawned directly by `sessionPath`, read from the
 * `.meta.json` sidecars rather than from the transcripts themselves.
 */
export function listSubagentSessionSummaries(
  sessionPath: string,
): AgentSubagentSessionSummary[] {
  const directory = subagentsDirectory(sessionPath);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
    .map((entry) => {
      const metaPath = join(directory, entry.name);
      const meta = JSON.parse(
        readFileSync(metaPath, { encoding: 'utf8' }),
      ) as Omit<AgentSubagentSessionSummary, 'path' | 'relativePath'>;
      const path = metaPath.replace(/\.meta\.json$/, '.jsonl');

      return {
        agentId: meta.agentId,
        agentType: meta.agentType,
        description: meta.description,
        toolCallId: meta.toolCallId,
        spawnDepth: meta.spawnDepth,
        path: path,
        relativePath: relative(process.cwd(), path),
      };
    })
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
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
      // Never descend into a `subagents/` sidecar. Those transcripts are real
      // session files, so without this they would be listed as if they were
      // top-level runs — and a subagent would show up in the session list as a
      // sibling of the run that spawned it. Children are reached deliberately,
      // through `listSubagentSessionSummaries`.
      if (entry.name === SUBAGENTS_DIRECTORY) {
        continue;
      }

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
  return listAgentSessionPathsFromDirectory(readAgentSessionRootDirectory())
    .map((path) => createAgentSessionSummary(path))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findAgentSessionPathById(id: string): string | undefined {
  const paths = listAgentSessionPathsFromDirectory(
    readAgentSessionRootDirectory(),
  );

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
