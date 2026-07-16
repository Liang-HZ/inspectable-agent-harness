import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAgentSystemMessage,
  formatAgentEnvironmentContext,
  gatherAgentEnvironmentContext,
  type AgentEnvironmentContext,
} from '../lib/agent-environment-context';

const fullContext: AgentEnvironmentContext = {
  cwd: '/repo/project',
  currentDate: '2026-07-16',
  gitBranch: 'fix/course-release-prep',
  gitStatusSummary: '3 changed files',
  directoryEntries: ['app/', 'lib/', 'package.json'],
  projectInstructions: 'Prefer explicit code over clever code.',
};

test('formatAgentEnvironmentContext renders a labeled block', () => {
  const text = formatAgentEnvironmentContext(fullContext);

  assert.match(text, /<environment_context>/);
  assert.match(text, /Current working directory: \/repo\/project/);
  assert.match(text, /Today's date: 2026-07-16/);
  assert.match(text, /Git branch: fix\/course-release-prep/);
  assert.match(text, /Git status: 3 changed files/);
  assert.match(text, /Top-level entries: app\/, lib\/, package\.json/);
  assert.match(text, /<project_instructions>/);
  assert.match(text, /Prefer explicit code/);
});

test('formatAgentEnvironmentContext omits absent fields cleanly', () => {
  const text = formatAgentEnvironmentContext({
    cwd: '/tmp/x',
    currentDate: '2026-07-16',
    gitBranch: null,
    gitStatusSummary: null,
    directoryEntries: [],
    projectInstructions: null,
  });

  assert.doesNotMatch(text, /Git branch/);
  assert.doesNotMatch(text, /Git status/);
  assert.doesNotMatch(text, /Top-level entries/);
  assert.doesNotMatch(text, /project_instructions/);
  assert.match(text, /Current working directory: \/tmp\/x/);
});

test('buildAgentSystemMessage appends the block to the base message', () => {
  const message = buildAgentSystemMessage('BASE INSTRUCTIONS', fullContext);

  assert.ok(message.startsWith('BASE INSTRUCTIONS'));
  assert.match(message, /<environment_context>/);
});

test('gatherAgentEnvironmentContext reads the real repo without throwing', async () => {
  const context = await gatherAgentEnvironmentContext({
    now: new Date('2026-07-16T00:00:00Z'),
  });

  assert.equal(context.currentDate, '2026-07-16');
  assert.equal(typeof context.cwd, 'string');
  // This test runs inside the git repo, so these should be populated.
  assert.ok(context.directoryEntries.length > 0);
  assert.ok(context.directoryEntries.includes('lib/'));
  // AGENTS.md exists at the repo root.
  assert.notEqual(context.projectInstructions, null);
});

test('gatherAgentEnvironmentContext degrades to nulls outside a git repo', async () => {
  const context = await gatherAgentEnvironmentContext({ cwd: '/' });

  // `/` is not a git repo and has no AGENTS.md; nothing should throw.
  assert.equal(context.gitBranch, null);
  assert.equal(context.gitStatusSummary, null);
  assert.equal(context.projectInstructions, null);
});
