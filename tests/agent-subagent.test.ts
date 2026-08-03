import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import type { AgentEvent } from '../lib/agent-events';
import type { AgentModelToolCall } from '../lib/agent-model-types';
import { createAgentRunContext } from '../lib/agent-run-context';
import {
  createAgentSession,
  createSubagentSession,
  listAgentSessionSummaries,
  listSubagentSessionSummaries,
  readAgentSessionRecords,
  subagentsDirectory,
  type AgentSession,
} from '../lib/agent-session-store';
import {
  MAX_SUBAGENT_SPAWN_DEPTH,
  type AgentSubagentSpawnInput,
  type AgentSubagentSpawnResult,
} from '../lib/agent-subagent';
import { executeAgentToolCall } from '../lib/agent-tool-runtime';
import { getAgentToolDefinitionsForRunPolicy } from '../lib/agent-tools';
import { createRootSpanContext } from '../lib/agent-trace';

const createdSessionPaths: string[] = [];

afterEach(async () => {
  while (createdSessionPaths.length > 0) {
    const path = createdSessionPaths.pop();
    if (path !== undefined) {
      await rm(path, { force: true });
      // The sidecar directory shares the session file's name without `.jsonl`.
      await rm(path.replace(/\.jsonl$/, ''), {
        force: true,
        recursive: true,
      });
    }
  }
});

function createTestSession(): AgentSession {
  const session = createAgentSession({
    id: `test-session-${randomUUID()}`,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: 'fake-model',
    baseURL: 'https://example.invalid/v1',
    wireApi: 'openai-chat-completions',
    policy: {
      approvalPolicy: 'never',
      sandboxMode: 'workspace_write',
    },
  });
  createdSessionPaths.push(session.path);

  return session;
}

const openPolicy = {
  approvalPolicy: 'never',
  sandboxMode: 'workspace_write',
} as const;

function toolNames(visibility: Parameters<
  typeof getAgentToolDefinitionsForRunPolicy
>[0]): string[] {
  return getAgentToolDefinitionsForRunPolicy(visibility).map(
    (toolDefinition) => toolDefinition.name,
  );
}

test('task is hidden when the run cannot spawn subagents', () => {
  // A run wired without a spawner must not advertise `task` at all: exposing a
  // tool that can only fail wastes a round and teaches the model nothing.
  assert.equal(
    toolNames({ policy: openPolicy, canSpawnSubagents: false }).includes(
      'task',
    ),
    false,
  );
  assert.equal(toolNames(openPolicy).includes('task'), false);
});

test('task is visible to a run that can spawn subagents', () => {
  assert.equal(
    toolNames({
      policy: openPolicy,
      spawnDepth: 0,
      canSpawnSubagents: true,
    }).includes('task'),
    true,
  );
});

test('task disappears at the spawn depth limit', () => {
  const atLimit = toolNames({
    policy: openPolicy,
    spawnDepth: MAX_SUBAGENT_SPAWN_DEPTH,
    canSpawnSubagents: true,
  });
  const belowLimit = toolNames({
    policy: openPolicy,
    spawnDepth: MAX_SUBAGENT_SPAWN_DEPTH - 1,
    canSpawnSubagents: true,
  });

  assert.equal(atLimit.includes('task'), false);
  assert.equal(belowLimit.includes('task'), true);
  // Only `task` is affected by depth; the rest of the surface is untouched.
  assert.deepEqual(
    belowLimit.filter((name) => name !== 'task'),
    atLimit,
  );
});

test('the runtime binds the tool call id and span into the spawner', async () => {
  const spawnInputs: AgentSubagentSpawnInput[] = [];
  const context = createAgentRunContext({
    runId: 'run-bind-spawner',
    policy: openPolicy,
    spawnSubagent: async (
      input: AgentSubagentSpawnInput,
    ): Promise<AgentSubagentSpawnResult> => {
      spawnInputs.push(input);

      return {
        sessionId: 'child-session-1',
        agentId: 'child-agent-1',
        answer: 'child answer',
        spawnDepth: 1,
      };
    },
  });
  const toolCall: AgentModelToolCall = {
    id: 'call-task-1',
    name: 'task',
    argumentsJson: JSON.stringify({
      description: 'survey the tests',
      prompt: 'List every test file.',
    }),
  };

  const events: AgentEvent[] = [];
  const execution = await executeAgentToolCall(toolCall, context, {
    onEvent: (event) => events.push(event),
  });

  assert.equal(execution.isError, false);
  assert.equal(execution.modelOutput.includes('child answer'), true);
  assert.equal(execution.subagentSessionId, 'child-session-1');

  // The tool never sees its own call id or span — the runtime supplies both.
  assert.equal(spawnInputs.length, 1);
  assert.equal(spawnInputs[0]?.toolCallId, 'call-task-1');
  assert.equal(spawnInputs[0]?.agentType, 'general-purpose');
  assert.equal(spawnInputs[0]?.description, 'survey the tests');

  const toolStarted = events.find((event) => event.type === 'tool_started');
  assert.equal(
    spawnInputs[0]?.parentSpan.spanId,
    toolStarted?.type === 'tool_started' ? toolStarted.span?.spanId : undefined,
  );

  // The subagent's root span must hang off the tool call's span, in the run's
  // trace — that is the whole parent/child link.
  assert.equal(spawnInputs[0]?.parentSpan.traceId, context.span.traceId);
  assert.equal(spawnInputs[0]?.parentSpan.parentSpanId, context.span.spanId);
});

test('tool_finished records which session the subagent wrote to', async () => {
  const context = createAgentRunContext({
    runId: 'run-finished-link',
    policy: openPolicy,
    spawnSubagent: async (): Promise<AgentSubagentSpawnResult> => ({
      sessionId: 'child-session-2',
      agentId: 'child-agent-2',
      answer: 'done',
      spawnDepth: 1,
    }),
  });
  const events: AgentEvent[] = [];

  await executeAgentToolCall(
    {
      id: 'call-task-2',
      name: 'task',
      argumentsJson: JSON.stringify({
        description: 'a sub-task',
        prompt: 'do the thing',
      }),
    },
    context,
    { onEvent: (event) => events.push(event) },
  );

  const finished = events.find((event) => event.type === 'tool_finished');
  assert.equal(
    finished?.type === 'tool_finished' ? finished.subagentSessionId : undefined,
    'child-session-2',
  );
  assert.equal(
    finished?.type === 'tool_finished' ? finished.timing !== undefined : false,
    true,
  );
});

test('task reports a wiring error rather than throwing when no spawner exists', async () => {
  const context = createAgentRunContext({
    runId: 'run-no-spawner',
    policy: openPolicy,
  });

  const execution = await executeAgentToolCall(
    {
      id: 'call-task-3',
      name: 'task',
      argumentsJson: JSON.stringify({
        description: 'a sub-task',
        prompt: 'do the thing',
      }),
    },
    context,
    {},
  );

  assert.equal(execution.isError, true);
  assert.equal(execution.modelOutput.includes('spawner'), true);
});

test('a subagent session is written beside its parent with a join key', () => {
  const parent = createTestSession();
  const child = createSubagentSession({
    parentSession: parent,
    parentSessionId: parent.id,
    agentId: 'agent-abc',
    agentType: 'general-purpose',
    description: 'survey the tests',
    toolCallId: 'call-task-9',
    spawnDepth: 1,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: 'fake-model',
    baseURL: 'https://example.invalid/v1',
    wireApi: 'openai-chat-completions',
    policy: openPolicy,
  });

  assert.equal(existsSync(child.path), true);
  assert.equal(
    child.path.startsWith(subagentsDirectory(parent.path)),
    true,
  );

  const records = readAgentSessionRecords(child.path);
  const meta = records[0];
  assert.equal(meta?.type, 'session_meta');
  assert.equal(
    meta?.type === 'session_meta' ? meta.payload.sidechain?.isSidechain : false,
    true,
  );
  assert.equal(
    meta?.type === 'session_meta' ? meta.payload.sidechain?.toolCallId : '',
    'call-task-9',
  );
  assert.equal(
    meta?.type === 'session_meta'
      ? meta.payload.sidechain?.parentSessionId
      : '',
    parent.id,
  );

  // The `.meta.json` sidecar exists so a reader can enumerate children without
  // opening (possibly huge) transcripts.
  const sidecar = JSON.parse(
    readFileSync(child.path.replace(/\.jsonl$/, '.meta.json'), {
      encoding: 'utf8',
    }),
  ) as { toolCallId: string; spawnDepth: number; agentType: string };
  assert.equal(sidecar.toolCallId, 'call-task-9');
  assert.equal(sidecar.spawnDepth, 1);
  assert.equal(sidecar.agentType, 'general-purpose');
});

test('subagent runs are listed as children, never as top-level sessions', () => {
  const parent = createTestSession();
  createSubagentSession({
    parentSession: parent,
    parentSessionId: parent.id,
    agentId: 'agent-child-listing',
    agentType: 'general-purpose',
    description: 'a child',
    toolCallId: 'call-task-10',
    spawnDepth: 1,
    cwd: process.cwd(),
    source: 'api_agent_stream',
    modelProvider: 'openai-compatible',
    model: 'fake-model',
    baseURL: 'https://example.invalid/v1',
    wireApi: 'openai-chat-completions',
    policy: openPolicy,
  });

  const children = listSubagentSessionSummaries(parent.path);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.agentId, 'agent-child-listing');
  assert.equal(children[0]?.toolCallId, 'call-task-10');

  // The regression this guards: `listAgentSessionPathsFromDirectory` recurses,
  // so without an explicit skip a subagent transcript would be summarised as if
  // it were a top-level run — and it has no business appearing next to the run
  // that spawned it.
  const topLevelIds = listAgentSessionSummaries().map((summary) => summary.id);
  assert.equal(topLevelIds.includes(parent.id), true);
  assert.equal(topLevelIds.includes('agent-child-listing'), false);
});
