import { builtinReadOnlyToolDefinitions } from './agent-builtins';
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

export const builtinEditingToolDefinitions: AgentToolDefinition[] = [];

export const builtinShellToolDefinitions: AgentToolDefinition[] = [];

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

export const agentTools = toolDefinitionsToModelTools(agentToolDefinitions);
