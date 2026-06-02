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
} from '../lib/agent-tools';

test('tool groups expose current builtin surface and empty future groups', () => {
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

  assert.deepEqual(toolsByGroup.utility_builtins, []);
  assert.deepEqual(toolsByGroup.read_only_builtins, [
    'read',
    'grep',
    'find',
    'ls',
  ]);
  assert.deepEqual(toolsByGroup.editing_builtins, []);
  assert.deepEqual(toolsByGroup.shell_builtins, []);
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
});

test('provider-visible tools do not include runtime metadata', () => {
  assert.deepEqual(
    agentTools.map((tool) => tool.name),
    ['read', 'grep', 'find', 'ls'],
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
    () => assertAgentPathAllowedByPolicy(projectPackagePath, allowedRootsPolicy),
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

  assert.equal(resolved.absolutePath, path.join(process.cwd(), 'tests/fixtures'));
  assert.equal(resolved.displayPath, 'fixtures');
});
