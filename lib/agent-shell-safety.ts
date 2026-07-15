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

// A command name alone does not make a command read-only: `sort -o` writes a
// file, `rg --pre` executes a program, and `cat /etc/passwd` reads outside the
// project. Safe classification therefore also screens arguments. Flags that
// can write or execute are denied per command by prefix, which also covers
// attached forms such as `-ofile` and GNU long-option abbreviations such as
// `--out=`.
const SAFE_COMMAND_DENIED_FLAG_PREFIXES: Record<string, string[]> = {
  sort: ['-o', '--o'],
  tree: ['-o', '--o'],
  rg: ['--pre', '--hostname-bin'],
};

// `uniq [flags] [input [output]]`: a second positional argument is an output
// file, so more than one positional argument falls back to review.
const SAFE_COMMAND_MAX_POSITIONAL_ARGUMENTS: Record<string, number> = {
  uniq: 1,
};

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
    const argumentDecision = classifySafeCommandArguments(commandName, tokens);

    if (argumentDecision !== undefined) {
      return argumentDecision;
    }

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

function classifySafeCommandArguments(
  commandName: string,
  tokens: string[],
): ShellCommandSafetyDecision | undefined {
  const pathEscapeDecision = classifyPathEscapeArguments(commandName, tokens);

  if (pathEscapeDecision !== undefined) {
    return pathEscapeDecision;
  }

  const deniedFlagPrefixes = SAFE_COMMAND_DENIED_FLAG_PREFIXES[commandName];

  if (deniedFlagPrefixes !== undefined) {
    const deniedFlag = tokens
      .slice(1)
      .find(
        (token) =>
          token.startsWith('-') &&
          deniedFlagPrefixes.some((prefix) => token.startsWith(prefix)),
      );

    if (deniedFlag !== undefined) {
      return {
        type: 'needs_review',
        reason: `\`${commandName} ${deniedFlag}\` can write files or execute programs, so it is not a read-only pattern.`,
      };
    }
  }

  const maxPositionalArguments =
    SAFE_COMMAND_MAX_POSITIONAL_ARGUMENTS[commandName];

  if (maxPositionalArguments !== undefined) {
    const positionalArguments = tokens
      .slice(1)
      .filter((token) => !token.startsWith('-'));

    if (positionalArguments.length > maxPositionalArguments) {
      return {
        type: 'needs_review',
        reason: `\`${commandName}\` with multiple positional arguments can write to the last one, so it is not a read-only pattern.`,
      };
    }
  }

  return undefined;
}

// Safe commands run without approval, so their file arguments must stay
// inside the project. Absolute paths, `~` expansion, and `..` segments all
// fall back to review. This is a lexical screen: it cannot follow symlinks,
// which is one reason a classifier is not a sandbox.
function classifyPathEscapeArguments(
  commandName: string,
  tokens: string[],
): ShellCommandSafetyDecision | undefined {
  for (const token of tokens.slice(1)) {
    const candidate = readPathCandidate(token);

    if (candidate !== undefined && isPathEscape(candidate)) {
      return {
        type: 'needs_review',
        reason: `\`${commandName} ${token}\` points outside the project, so it is not classified as read-only.`,
      };
    }
  }

  return undefined;
}

function readPathCandidate(token: string): string | undefined {
  if (!token.startsWith('-')) {
    return token;
  }

  const equalsIndex = token.indexOf('=');

  return equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
}

function isPathEscape(candidate: string): boolean {
  if (candidate.startsWith('/') || candidate.startsWith('~')) {
    return true;
  }

  return (
    candidate === '..' ||
    candidate.startsWith('../') ||
    candidate.endsWith('/..') ||
    candidate.includes('/../')
  );
}

function classifyFindCommand(tokens: string[]): ShellCommandSafetyDecision {
  const unsafeFlag = tokens.find((token) => UNSAFE_FIND_FLAGS.has(token));

  if (unsafeFlag !== undefined) {
    return {
      type: 'needs_review',
      reason: `\`find ${unsafeFlag}\` can execute or delete, so it is not a read-only pattern.`,
    };
  }

  const pathEscapeDecision = classifyPathEscapeArguments('find', tokens);

  if (pathEscapeDecision !== undefined) {
    return pathEscapeDecision;
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

  // Global git flags before the subcommand (`-C`, `-c`, `--git-dir`,
  // `--exec-path`, ...) can retarget the repository or change which programs
  // git runs, so a safe git command must start directly with its subcommand.
  const subcommandIndex = tokens.indexOf(subcommand);
  const globalFlag = tokens
    .slice(1, subcommandIndex)
    .find((token) => token.startsWith('-'));

  if (globalFlag !== undefined) {
    return {
      type: 'needs_review',
      reason: `\`git ${globalFlag}\` before the subcommand can retarget the repository or executed programs, so it is not classified.`,
    };
  }

  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      type: 'needs_review',
      reason: `\`git ${subcommand}\` is not in the known read-only git subcommand list.`,
    };
  }

  // `git log/diff/show --output=<file>` writes the result to a file.
  const outputFlag = tokens.find((token) => token.startsWith('--output'));

  if (outputFlag !== undefined) {
    return {
      type: 'needs_review',
      reason: `\`git ${subcommand} ${outputFlag}\` writes to a file, so it is not a read-only pattern.`,
    };
  }

  const pathEscapeDecision = classifyPathEscapeArguments('git', tokens);

  if (pathEscapeDecision !== undefined) {
    return pathEscapeDecision;
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
