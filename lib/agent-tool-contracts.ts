import type { AgentModelToolDefinition } from './agent-model-types';
import type { AgentToolAnnotations } from './agent-permissions';
import type { AgentToolOutput } from './agent-tool-output';
import type { AgentToolPathAccessPolicy } from './agent-path-policy';

export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 10_000;

export type AgentToolSource = 'builtin' | 'dynamic' | 'mcp' | 'hosted';

export type AgentToolCategory =
  | 'utility'
  | 'read'
  | 'search'
  | 'write'
  | 'shell';

export type AgentToolGroupName =
  | 'utility_builtins'
  | 'read_only_builtins'
  | 'editing_builtins'
  | 'shell_builtins';

export type AgentToolExecutionMode = 'sequential' | 'parallel';

export type AgentToolResult = {
  input: unknown;
  output: AgentToolOutput;
};

export type AgentToolDefinition = {
  name: string;
  source: AgentToolSource;
  group: AgentToolGroupName;
  category: AgentToolCategory;
  annotations: AgentToolAnnotations;
  executionMode: AgentToolExecutionMode;
  timeoutMs: number;
  abortable: boolean;
  pathAccess: AgentToolPathAccessPolicy;
  modelTool: AgentModelToolDefinition;
  execute: (
    argumentsJson: string,
    signal: AbortSignal | undefined,
  ) => AgentToolResult | Promise<AgentToolResult>;
};

export type AgentToolDefinitionGroup = {
  name: AgentToolGroupName;
  source: AgentToolSource;
  tools: AgentToolDefinition[];
};

export type AgentToolExecution = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: AgentToolOutput;
  modelOutput: string;
  isError: boolean;
  durationMs: number;
};

export function toolDefinitionsToModelTools(
  toolDefinitions: AgentToolDefinition[],
): AgentModelToolDefinition[] {
  return toolDefinitions.map((toolDefinition) => toolDefinition.modelTool);
}
