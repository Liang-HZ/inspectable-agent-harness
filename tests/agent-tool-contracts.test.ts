import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { AgentToolRespondToModelError } from '../lib/agent-tool-output';
import {
  assertAgentPathAllowedByPolicy,
  allowedRootsPathAccessPolicy,
  currentProjectPathAccessPolicy,
  dangerFullAccessPathAccessPolicy,
  resolveAgentToolPath,
} from '../lib/agent-path-policy';
import {
  agentToolDefinitions,
  agentToolGroups,
  agentTools,
  getAgentToolsForRunPolicy,
} from '../lib/agent-tools';

test('tool groups expose current builtin surface', () => {
  assert.deepEqual(
    agentToolGroups.map((group) => group.name),
    [
      'utility_builtins',
      'read_only_builtins',
      'editing_builtins',
      'shell_builtins',
    ],
  );
  assert.deepEqual(
    agentToolGroups.map((group) => group.source),
    ['builtin', 'builtin', 'builtin', 'builtin'],
  );

  const toolsByGroup = Object.fromEntries(
    agentToolGroups.map((group) => [
      group.name,
      group.tools.map((toolDefinition) => toolDefinition.name),
    ]),
  );

  assert.deepEqual(toolsByGroup.utility_builtins, ['task']);
  assert.deepEqual(toolsByGroup.read_only_builtins, [
    'read',
    'grep',
    'find',
    'ls',
  ]);
  assert.deepEqual(toolsByGroup.editing_builtins, ['write', 'edit']);
  assert.deepEqual(toolsByGroup.shell_builtins, ['shell']);
});

test('current tool definitions declare runtime metadata explicitly', () => {
  const toolsByName = new Map(
    agentToolDefinitions.map((toolDefinition) => [
      toolDefinition.name,
      toolDefinition,
    ]),
  );
  const readOnlyToolNames = ['read', 'grep', 'find', 'ls'];

  for (const toolName of readOnlyToolNames) {
    const toolDefinition = toolsByName.get(toolName);
    assert.notEqual(toolDefinition, undefined);
    assert.equal(toolDefinition?.source, 'builtin');
    assert.equal(toolDefinition?.group, 'read_only_builtins');
    assert.equal(toolDefinition?.executionMode, 'parallel');
    assert.equal(toolDefinition?.timeoutMs, 10_000);
    assert.equal(toolDefinition?.abortable, true);
    assert.equal(toolDefinition?.pathAccess.type, 'current_project');
    assert.equal(toolDefinition?.annotations.readOnly, true);
    assert.equal(toolDefinition?.annotations.destructive, false);
  }

  for (const toolName of ['write', 'edit']) {
    const toolDefinition = toolsByName.get(toolName);
    assert.notEqual(toolDefinition, undefined);
    assert.equal(toolDefinition?.source, 'builtin');
    assert.equal(toolDefinition?.group, 'editing_builtins');
    assert.equal(toolDefinition?.category, 'write');
    assert.equal(toolDefinition?.executionMode, 'sequential');
    assert.equal(toolDefinition?.timeoutMs, 10_000);
    assert.equal(toolDefinition?.abortable, true);
    assert.equal(toolDefinition?.pathAccess.type, 'current_project');
    assert.equal(toolDefinition?.annotations.readOnly, false);
    assert.equal(toolDefinition?.annotations.destructive, true);
  }

  const shellToolDefinition = toolsByName.get('shell');
  assert.notEqual(shellToolDefinition, undefined);
  assert.equal(shellToolDefinition?.source, 'builtin');
  assert.equal(shellToolDefinition?.group, 'shell_builtins');
  assert.equal(shellToolDefinition?.category, 'shell');
  assert.equal(shellToolDefinition?.executionMode, 'sequential');
  assert.equal(shellToolDefinition?.timeoutMs, 60_000);
  assert.equal(shellToolDefinition?.abortable, true);
  assert.equal(shellToolDefinition?.pathAccess.type, 'current_project');
  assert.equal(shellToolDefinition?.annotations.readOnly, false);
  assert.equal(shellToolDefinition?.annotations.destructive, true);
  assert.equal(shellToolDefinition?.annotations.openWorld, true);
  assert.notEqual(shellToolDefinition?.decidePermission, undefined);
});

test('provider-visible tools do not include runtime metadata', () => {
  assert.deepEqual(
    agentTools.map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls', 'shell'],
  );

  for (const modelTool of agentTools) {
    assert.deepEqual(Object.keys(modelTool).sort(), [
      'description',
      'inputSchema',
      'name',
      'schemaStrict',
    ]);
  }
});

test('provider-visible editing tools depend on run sandbox mode', () => {
  assert.deepEqual(
    getAgentToolsForRunPolicy({
      approvalPolicy: 'on_request',
      sandboxMode: 'read_only',
    }).map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls', 'shell'],
  );

  assert.deepEqual(
    getAgentToolsForRunPolicy({
      approvalPolicy: 'on_request',
      sandboxMode: 'workspace_write',
    }).map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls', 'write', 'edit', 'shell'],
  );
});

test('path access policies enforce current project and allowed roots', () => {
  const projectPackagePath = path.join(process.cwd(), 'package.json');
  const parentPackagePath = path.join(process.cwd(), '..', 'package.json');

  assertAgentPathAllowedByPolicy(
    projectPackagePath,
    currentProjectPathAccessPolicy,
  );
  assert.throws(
    () =>
      assertAgentPathAllowedByPolicy(
        parentPackagePath,
        currentProjectPathAccessPolicy,
      ),
    AgentToolRespondToModelError,
  );

  const allowedRootsPolicy = allowedRootsPathAccessPolicy([
    path.join(process.cwd(), 'tests'),
  ]);
  assertAgentPathAllowedByPolicy(
    path.join(process.cwd(), 'tests', 'agent-builtins.test.ts'),
    allowedRootsPolicy,
  );
  assert.throws(
    () =>
      assertAgentPathAllowedByPolicy(projectPackagePath, allowedRootsPolicy),
    AgentToolRespondToModelError,
  );

  assertAgentPathAllowedByPolicy(
    parentPackagePath,
    dangerFullAccessPathAccessPolicy,
  );
});

test('relative path resolution follows the active path policy base', () => {
  const allowedRootsPolicy = allowedRootsPathAccessPolicy([
    path.join(process.cwd(), 'tests'),
  ]);
  const resolved = resolveAgentToolPath('fixtures', allowedRootsPolicy);

  assert.equal(
    resolved.absolutePath,
    path.join(process.cwd(), 'tests/fixtures'),
  );
  assert.equal(resolved.displayPath, 'fixtures');
});
