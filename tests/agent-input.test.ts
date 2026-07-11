import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAgentInput } from '../lib/agent-input';

test('parses run policy fields from agent request input', () => {
  const result = parseAgentInput({
    task: 'inspect the project',
    approvalPolicy: 'never',
    sandboxMode: 'workspace_write',
  });

  if (!result.ok) {
    assert.fail(result.error);
  }

  assert.equal(result.ok, true);
  assert.equal(result.input.approvalPolicy, 'never');
  assert.equal(result.input.sandboxMode, 'workspace_write');
});

test('defaults agent request policy to safe read-only mode', () => {
  const result = parseAgentInput({
    task: 'inspect the project',
  });

  if (!result.ok) {
    assert.fail(result.error);
  }

  assert.equal(result.ok, true);
  assert.equal(result.input.approvalPolicy, 'on_request');
  assert.equal(result.input.sandboxMode, 'read_only');
});

test('reports field errors for invalid agent run policy fields', () => {
  const result = parseAgentInput({
    task: 'inspect the project',
    approvalPolicy: 'sometimes',
    sandboxMode: 'outside_everything',
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('Invalid policy input unexpectedly parsed.');
  }

  assert.deepEqual(Object.keys(result.validationErrors.fieldErrors).sort(), [
    'approvalPolicy',
    'sandboxMode',
  ]);
});
