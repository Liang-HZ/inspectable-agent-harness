import { exec } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(exec);

const MAX_DIRECTORY_ENTRIES = 40;
const MAX_PROJECT_INSTRUCTIONS_CHARS = 4_000;
const GIT_STATUS_TIMEOUT_MS = 3_000;

// A harness assembles context, not just tool loops. The model answers better
// when the system prompt tells it where it is (cwd), when it is (date), what
// the repository looks like (branch, dirty state, top-level layout), and what
// the project itself asked for (AGENTS.md). Everything here is best-effort:
// any failure degrades to a null field rather than failing the run, because a
// missing directory listing must never stop an agent from starting.
export type AgentEnvironmentContext = {
  cwd: string;
  currentDate: string;
  gitBranch: string | null;
  gitStatusSummary: string | null;
  directoryEntries: string[];
  projectInstructions: string | null;
};

export type GatherAgentEnvironmentContextOptions = {
  cwd?: string;
  now?: Date;
};

export async function gatherAgentEnvironmentContext(
  options: GatherAgentEnvironmentContextOptions = {},
): Promise<AgentEnvironmentContext> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();

  const [git, directoryEntries, projectInstructions] = await Promise.all([
    readGitContext(cwd),
    readDirectoryEntries(cwd),
    readProjectInstructions(cwd),
  ]);

  return {
    cwd: cwd,
    currentDate: now.toISOString().slice(0, 10),
    gitBranch: git.branch,
    gitStatusSummary: git.statusSummary,
    directoryEntries: directoryEntries,
    projectInstructions: projectInstructions,
  };
}

async function readGitContext(
  cwd: string,
): Promise<{ branch: string | null; statusSummary: string | null }> {
  try {
    const { stdout: branchStdout } = await execFileAsync(
      'git rev-parse --abbrev-ref HEAD',
      { cwd: cwd, timeout: GIT_STATUS_TIMEOUT_MS },
    );
    const { stdout: statusStdout } = await execFileAsync(
      'git status --porcelain',
      { cwd: cwd, timeout: GIT_STATUS_TIMEOUT_MS },
    );

    const changedCount = statusStdout
      .split('\n')
      .filter((line) => line.trim() !== '').length;

    return {
      branch: branchStdout.trim() || null,
      statusSummary:
        changedCount === 0
          ? 'clean'
          : `${changedCount} changed file${changedCount === 1 ? '' : 's'}`,
    };
  } catch {
    // Not a git repository, or git is unavailable.
    return { branch: null, statusSummary: null };
  }
}

async function readDirectoryEntries(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });

    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => entry.name !== 'node_modules')
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  } catch {
    return [];
  }
}

// AGENTS.md is the convention this repo already follows (see the root file);
// CLAUDE.md is the equivalent other harnesses read. Either one, if present,
// carries project-specific instructions the agent should honor.
async function readProjectInstructions(cwd: string): Promise<string | null> {
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const content = await readFile(
        path.join(cwd, fileName),
        'utf8',
      );
      const trimmed = content.trim();

      if (trimmed === '') {
        continue;
      }

      return trimmed.length > MAX_PROJECT_INSTRUCTIONS_CHARS
        ? `${trimmed.slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS)}\n[...truncated]`
        : trimmed;
    } catch {
      // File not present; try the next candidate.
    }
  }

  return null;
}

// Pure: turns a gathered context into the text block appended to the base
// system message. Kept separate from gathering so it can be unit-tested
// without touching the filesystem.
export function formatAgentEnvironmentContext(
  context: AgentEnvironmentContext,
): string {
  const lines = [
    '<environment_context>',
    `Current working directory: ${context.cwd}`,
    `Today's date: ${context.currentDate}`,
  ];

  if (context.gitBranch !== null) {
    lines.push(`Git branch: ${context.gitBranch}`);
  }

  if (context.gitStatusSummary !== null) {
    lines.push(`Git status: ${context.gitStatusSummary}`);
  }

  if (context.directoryEntries.length > 0) {
    lines.push(
      `Top-level entries: ${context.directoryEntries.join(', ')}`,
    );
  }

  lines.push('</environment_context>');

  if (context.projectInstructions !== null) {
    lines.push(
      '',
      '<project_instructions>',
      context.projectInstructions,
      '</project_instructions>',
    );
  }

  return lines.join('\n');
}

export function buildAgentSystemMessage(
  baseSystemMessage: string,
  context: AgentEnvironmentContext,
): string {
  return `${baseSystemMessage}\n\n${formatAgentEnvironmentContext(context)}`;
}
