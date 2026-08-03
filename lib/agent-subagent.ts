import * as z from 'zod';

import { noPathAccessPolicy } from './agent-path-policy';
import {
  AgentToolRespondToModelError,
  createSuccessToolOutput,
} from './agent-tool-output';
import type {
  AgentToolDefinition,
  AgentToolResult,
  AgentToolRuntimeContext,
} from './agent-tool-contracts';
import type { AgentSpanContext } from './agent-trace';

/**
 * How deep `task` may nest. A subagent at the limit does not *fail* when it
 * tries to spawn — it never sees the `task` tool at all, because a tool the
 * model cannot call is a boundary it cannot spend tokens arguing with.
 *
 * 2 means: the top-level run spawns a subagent, and that subagent may spawn one
 * more. Deep enough for "split this survey into parts", shallow enough that a
 * confused model cannot fork-bomb the machine.
 */
export const MAX_SUBAGENT_SPAWN_DEPTH = 2;

/**
 * A subagent runs a whole sampling loop, so the 10s default tool timeout would
 * kill it mid-thought. This bound exists to stop a wedged child from pinning
 * the parent forever, not to bound useful work.
 */
export const SUBAGENT_TIMEOUT_MS = 300_000;

export type AgentSubagentRequest = {
  agentType: string;
  description: string;
  prompt: string;
};

export type AgentSubagentSpawnInput = AgentSubagentRequest & {
  /** The parent's `task` tool call id — the join key between the two runs. */
  toolCallId: string;
  /** The `task` tool call's span; the subagent's root span hangs off it. */
  parentSpan: AgentSpanContext;
};

export type AgentSubagentSpawnResult = {
  sessionId: string;
  agentId: string;
  answer: string;
  spawnDepth: number;
};

/**
 * Implemented in `lib/agent.ts`, which is the only place that holds a model
 * gateway and a session handle. Declared here so that the run context can carry
 * it without `agent-run-context.ts` importing the agent loop.
 */
export type AgentSubagentSpawner = (
  input: AgentSubagentSpawnInput,
) => Promise<AgentSubagentSpawnResult>;

/**
 * The same capability, already bound to the tool call that is invoking it. The
 * tool never learns its own call id or span; the tool runtime closes over them
 * when it builds the runtime context.
 */
export type AgentSubagentToolSpawner = (
  request: AgentSubagentRequest,
) => Promise<AgentSubagentSpawnResult>;

const taskInputSchema = z.strictObject({
  description: z.string().min(1),
  prompt: z.string().min(1),
  agentType: z.string().min(1).optional(),
});

function parseToolInput<T>(
  toolName: string,
  argumentsJson: string,
  schema: z.ZodType<T>,
): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argumentsJson);
  } catch {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      `Tool \`${toolName}\` received invalid JSON arguments.`,
    );
  }

  const parsedInput = schema.safeParse(parsedJson);

  if (!parsedInput.success) {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      `Tool \`${toolName}\` received invalid arguments.`,
    );
  }

  return parsedInput.data;
}

const taskToolDefinition = {
  name: 'task',
  source: 'builtin',
  group: 'utility_builtins',
  category: 'utility',
  annotations: {
    readOnly: false,
    destructive: false,
    // A subagent can reach for anything its inherited policy allows, so from
    // the parent's point of view this call has an open effect surface.
    openWorld: true,
    idempotent: false,
  },
  // Sequential for now. Running siblings concurrently is the obvious next step,
  // but the batch scheduler only parallelises when *every* call in the batch is
  // parallel, and a subagent holding an approval prompt open while its siblings
  // race would need the approval queue to be per-run first.
  executionMode: 'sequential',
  timeoutMs: SUBAGENT_TIMEOUT_MS,
  abortable: true,
  pathAccess: noPathAccessPolicy,
  modelTool: {
    name: 'task',
    description:
      'Delegate a self-contained sub-task to a subagent that runs with its own fresh context window, then return only its final answer. Use this when a sub-task needs many steps whose intermediate output would otherwise flood this conversation — a broad search, an exploratory read of many files. The subagent cannot ask you questions, so the prompt must be complete on its own.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description:
            'Short label for this sub-task, 3-8 words. Shown in the trace.',
        },
        prompt: {
          type: 'string',
          description:
            'The full instruction for the subagent. It has none of this conversation history, so state every path, constraint, and definition it needs.',
        },
        agentType: {
          type: 'string',
          description:
            'Optional label for the kind of subagent, recorded in the trace. Defaults to general-purpose.',
        },
      },
      required: ['description', 'prompt'],
    },
    schemaStrict: true,
  },
  execute: async (
    argumentsJson: string,
    _signal: AbortSignal | undefined,
    runtime: AgentToolRuntimeContext,
  ): Promise<AgentToolResult> => {
    const input = parseToolInput('task', argumentsJson, taskInputSchema);

    if (runtime.spawnSubagent === undefined) {
      // Reached only if the tool is exposed by a caller that never wired a
      // spawner — a wiring bug, not something the model did wrong.
      throw new AgentToolRespondToModelError(
        'TOOL_NOT_FOUND',
        'Tool `task` is not available in this run: no subagent spawner is configured.',
      );
    }

    const spawn = await runtime.spawnSubagent({
      agentType: input.agentType ?? 'general-purpose',
      description: input.description,
      prompt: input.prompt,
    });

    return {
      input: input,
      subagentSessionId: spawn.sessionId,
      output: createSuccessToolOutput({
        contentText: spawn.answer,
        details: {
          agentId: spawn.agentId,
          sessionId: spawn.sessionId,
          spawnDepth: spawn.spawnDepth,
          description: input.description,
        },
      }),
    };
  },
} satisfies AgentToolDefinition;

export const builtinSubagentToolDefinitions: AgentToolDefinition[] = [
  taskToolDefinition,
];
