import { builtinReadOnlyToolDefinitions } from './agent-builtins';
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

export const builtinUtilityToolDefinitions: AgentToolDefinition[] = [];

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

function isToolVisibleForRunPolicy(
  toolDefinition: AgentToolDefinition,
  policy: AgentRunPolicy,
): boolean {
  if (toolDefinition.group === 'editing_builtins') {
    return policy.sandboxMode !== 'read_only';
  }

  if (toolDefinition.group === 'shell_builtins') {
    // Shell stays visible in read-only runs: the shell permission override
    // limits execution to known read-only command patterns there.
    return true;
  }

  return true;
}

export function getAgentToolDefinitionsForRunPolicy(
  policy: AgentRunPolicy,
): AgentToolDefinition[] {
  return agentToolDefinitions.filter((toolDefinition) =>
    isToolVisibleForRunPolicy(toolDefinition, policy),
  );
}

export function getAgentToolsForRunPolicy(
  policy: AgentRunPolicy,
): AgentModelToolDefinition[] {
  return toolDefinitionsToModelTools(
    getAgentToolDefinitionsForRunPolicy(policy),
  );
}

export const agentTools = getAgentToolsForRunPolicy({
  approvalPolicy: 'on_request',
  sandboxMode: 'read_only',
});
