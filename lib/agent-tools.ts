import { builtinReadOnlyToolDefinitions } from './agent-builtins';
import {
  builtinSubagentToolDefinitions,
  MAX_SUBAGENT_SPAWN_DEPTH,
} from './agent-subagent';
import { builtinEditingToolDefinitions as editingBuiltinDefinitions } from './agent-editing-builtins';
import { builtinShellToolDefinitions as shellBuiltinDefinitions } from './agent-shell-builtins';
import type { AgentModelToolDefinition } from './agent-model-types';
import type { AgentRunPolicy } from './agent-permissions';
import {
  toolDefinitionsToModelTools,
  type AgentToolDefinition,
  type AgentToolDefinitionGroup,
  type AgentToolExecution,
  type AgentToolExecutionMode,
  type AgentToolResult,
} from './agent-tool-contracts';

export type {
  AgentToolDefinition,
  AgentToolDefinitionGroup,
  AgentToolExecution,
  AgentToolExecutionMode,
  AgentToolResult,
} from './agent-tool-contracts';

export const builtinUtilityToolDefinitions: AgentToolDefinition[] =
  builtinSubagentToolDefinitions;

export const builtinEditingToolDefinitions: AgentToolDefinition[] =
  editingBuiltinDefinitions;

export const builtinShellToolDefinitions: AgentToolDefinition[] =
  shellBuiltinDefinitions;

export const agentToolGroups: AgentToolDefinitionGroup[] = [
  {
    name: 'utility_builtins',
    source: 'builtin',
    tools: builtinUtilityToolDefinitions,
  },
  {
    name: 'read_only_builtins',
    source: 'builtin',
    tools: builtinReadOnlyToolDefinitions,
  },
  {
    name: 'editing_builtins',
    source: 'builtin',
    tools: builtinEditingToolDefinitions,
  },
  {
    name: 'shell_builtins',
    source: 'builtin',
    tools: builtinShellToolDefinitions,
  },
];

export const agentToolDefinitions: AgentToolDefinition[] =
  agentToolGroups.flatMap((group) => group.tools);

export const agentToolRegistry = new Map<string, AgentToolDefinition>(
  agentToolDefinitions.map((toolDefinition) => [
    toolDefinition.name,
    toolDefinition,
  ]),
);

export type AgentToolVisibility = {
  policy: AgentRunPolicy;
  /** 0 for a top-level run; a subagent passes its own depth. */
  spawnDepth?: number;
  /** False when the run has no way to derive subagents. */
  canSpawnSubagents?: boolean;
};

function isToolVisibleForRun(
  toolDefinition: AgentToolDefinition,
  visibility: AgentToolVisibility,
): boolean {
  if (toolDefinition.group === 'editing_builtins') {
    return visibility.policy.sandboxMode !== 'read_only';
  }

  if (toolDefinition.group === 'shell_builtins') {
    // Shell stays visible in read-only runs: the shell permission override
    // limits execution to known read-only command patterns there.
    return true;
  }

  if (toolDefinition.name === 'task') {
    // Hidden rather than exposed-and-failing. A tool the model cannot see is a
    // boundary it cannot spend a round arguing with, and at the depth limit the
    // answer would always be no.
    return (
      (visibility.canSpawnSubagents ?? false) &&
      (visibility.spawnDepth ?? 0) < MAX_SUBAGENT_SPAWN_DEPTH
    );
  }

  return true;
}

export function getAgentToolDefinitionsForRunPolicy(
  visibility: AgentRunPolicy | AgentToolVisibility,
): AgentToolDefinition[] {
  const resolved: AgentToolVisibility =
    'policy' in visibility ? visibility : { policy: visibility };

  return agentToolDefinitions.filter((toolDefinition) =>
    isToolVisibleForRun(toolDefinition, resolved),
  );
}

export function getAgentToolsForRunPolicy(
  visibility: AgentRunPolicy | AgentToolVisibility,
): AgentModelToolDefinition[] {
  return toolDefinitionsToModelTools(
    getAgentToolDefinitionsForRunPolicy(visibility),
  );
}

export const agentTools = getAgentToolsForRunPolicy({
  approvalPolicy: 'on_request',
  sandboxMode: 'read_only',
});
