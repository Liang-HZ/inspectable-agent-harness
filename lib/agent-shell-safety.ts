export type ShellCommandSafetyDecision =
  | {
      type: 'safe';
      reason: string;
    }
  | {
      type: 'needs_review';
      reason: string;
    };

const SHELL_CONTROL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /;/, label: 'command separator `;`' },
  { pattern: /&&/, label: 'command chaining `&&`' },
  { pattern: /\|\|/, label: 'command chaining `||`' },
  { pattern: /&/, label: 'background operator `&`' },
  { pattern: />/, label: 'output redirection `>`' },
  { pattern: /</, label: 'input redirection `<`' },
  { pattern: /`/, label: 'command substitution backtick' },
  { pattern: /\$/, label: 'variable or command substitution `$`' },
  { pattern: /\n/, label: 'multi-line command' },
];

const SAFE_SIMPLE_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'date',
  'which',
  'file',
  'du',
  'df',
  'tree',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'stat',
  'basename',
  'dirname',
  'realpath',
  'whoami',
  'uname',
  'grep',
  'rg',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'shortlog',
  'branch',
]);

const UNSAFE_FIND_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
]);

type TokenizeResult =
  | {
      ok: true;
      tokens: string[];
    }
  | {
      ok: false;
      reason: string;
    };

export function classifyShellCommandSafety(
  command: string,
): ShellCommandSafetyDecision {
  const controlPattern = SHELL_CONTROL_PATTERNS.find(({ pattern }) =>
    pattern.test(command),
  );

  if (controlPattern !== undefined) {
    return {
      type: 'needs_review',
      reason: `Command uses ${controlPattern.label}, which the safe-command classifier does not analyze.`,
    };
  }

  const pipelineSegments = command
    .split('|')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

  if (pipelineSegments.length === 0) {
    return {
      type: 'needs_review',
      reason: 'Command is empty after removing pipeline separators.',
    };
  }

  for (const segment of pipelineSegments) {
    const segmentDecision = classifySimpleCommandSegment(segment);

    if (segmentDecision.type === 'needs_review') {
      return segmentDecision;
    }
  }

  return {
    type: 'safe',
    reason:
      pipelineSegments.length === 1
        ? 'Command matches a known read-only command pattern.'
        : 'Every pipeline segment matches a known read-only command pattern.',
  };
}

function classifySimpleCommandSegment(
  segment: string,
): ShellCommandSafetyDecision {
  const tokenizeResult = tokenizeShellSegment(segment);

  if (!tokenizeResult.ok) {
    return {
      type: 'needs_review',
      reason: tokenizeResult.reason,
    };
  }

  const tokens = tokenizeResult.tokens;

  if (tokens.length === 0) {
    return {
      type: 'needs_review',
      reason: 'Command segment is empty.',
    };
  }

  const commandName = tokens[0];

  if (commandName === 'find') {
    return classifyFindCommand(tokens);
  }

  if (commandName === 'git') {
    return classifyGitCommand(tokens);
  }

  if (SAFE_SIMPLE_COMMANDS.has(commandName)) {
    return {
      type: 'safe',
      reason: `\`${commandName}\` is a known read-only command.`,
    };
  }

  return {
    type: 'needs_review',
    reason: `\`${commandName}\` is not in the known read-only command list.`,
  };
}

function classifyFindCommand(tokens: string[]): ShellCommandSafetyDecision {
  const unsafeFlag = tokens.find((token) => UNSAFE_FIND_FLAGS.has(token));

  if (unsafeFlag !== undefined) {
    return {
      type: 'needs_review',
      reason: `\`find ${unsafeFlag}\` can execute or delete, so it is not a read-only pattern.`,
    };
  }

  return {
    type: 'safe',
    reason: '`find` without action flags is a known read-only command.',
  };
}

function classifyGitCommand(tokens: string[]): ShellCommandSafetyDecision {
  const subcommand = tokens
    .slice(1)
    .find((token) => !token.startsWith('-'));

  if (subcommand === undefined) {
    return {
      type: 'needs_review',
      reason: '`git` without a recognizable subcommand is not classified.',
    };
  }

  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      type: 'needs_review',
      reason: `\`git ${subcommand}\` is not in the known read-only git subcommand list.`,
    };
  }

  if (subcommand === 'branch') {
    const branchArguments = tokens.slice(tokens.indexOf(subcommand) + 1);
    const hasNonListArgument = branchArguments.some(
      (token) => !isGitBranchListFlag(token),
    );

    if (hasNonListArgument) {
      return {
        type: 'needs_review',
        reason:
          '`git branch` with arguments can create or delete branches, so only bare listing flags are classified as read-only.',
      };
    }
  }

  return {
    type: 'safe',
    reason: `\`git ${subcommand}\` is a known read-only git subcommand.`,
  };
}

function isGitBranchListFlag(token: string): boolean {
  return (
    token === '-a' ||
    token === '--all' ||
    token === '-r' ||
    token === '--remotes' ||
    token === '--list' ||
    token === '-v' ||
    token === '-vv' ||
    token === '--verbose' ||
    token === '--show-current'
  );
}

function tokenizeShellSegment(segment: string): TokenizeResult {
  const tokens: string[] = [];
  let currentToken = '';
  let hasCurrentToken = false;
  let quoteCharacter: '"' | "'" | undefined;

  for (const character of segment) {
    if (quoteCharacter !== undefined) {
      if (character === quoteCharacter) {
        quoteCharacter = undefined;
      } else {
        currentToken += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quoteCharacter = character;
      hasCurrentToken = true;
      continue;
    }

    if (character === '\\') {
      return {
        ok: false,
        reason:
          'Command uses backslash escaping, which the safe-command classifier does not analyze.',
      };
    }

    if (character === ' ' || character === '\t') {
      if (hasCurrentToken || currentToken !== '') {
        tokens.push(currentToken);
        currentToken = '';
        hasCurrentToken = false;
      }
      continue;
    }

    currentToken += character;
  }

  if (quoteCharacter !== undefined) {
    return {
      ok: false,
      reason: 'Command has an unterminated quote.',
    };
  }

  if (hasCurrentToken || currentToken !== '') {
    tokens.push(currentToken);
  }

  return {
    ok: true,
    tokens: tokens,
  };
}
