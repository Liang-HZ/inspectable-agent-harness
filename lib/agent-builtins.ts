import { spawn } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import * as z from 'zod';

import {
  AgentToolRespondToModelError,
  createSuccessToolOutput,
} from './agent-tool-output';
import {
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  type AgentToolCategory,
  type AgentToolDefinition,
  type AgentToolResult,
} from './agent-tool-contracts';
import {
  assertAgentPathAllowedByPolicy,
  currentProjectPathAccessPolicy,
  displayAgentToolPath,
  resolveAgentToolPath,
  type ResolvedAgentToolPath,
} from './agent-path-policy';

const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.next', 'node_modules']);
const DEFAULT_READ_LINE_LIMIT = 200;
const MAX_READ_LINE_LIMIT = 2000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;
const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

type DirectoryEntryType = 'directory' | 'file' | 'symlink' | 'other';

type ListEntry = {
  name: string;
  path: string;
  type: DirectoryEntryType;
};

type ReadFileResult = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  notice: string | null;
};

type ListFilesResult = {
  path: string;
  entries: ListEntry[];
  truncated: boolean;
  notice: string | null;
};

type FindFilesResult = {
  path: string;
  pattern: string;
  paths: string[];
  truncated: boolean;
  notice: string | null;
};

type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
};

type GrepResult = {
  path: string;
  pattern: string;
  matches: GrepMatch[];
  truncated: boolean;
  notice: string | null;
};

const pathSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? 'Field `path` is required.'
        : 'Field `path` must be a string.',
  })
  .trim()
  .min(1, { error: 'Field `path` is required.' });

const optionalPathSchema = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalGlobSchema = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

function optionalIntegerSchema(max: number) {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z.number().int().min(1).max(max).optional(),
  );
}

const optionalBooleanSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.boolean().optional(),
);

const readInputSchema = z.strictObject({
  path: pathSchema,
  offset: optionalIntegerSchema(Number.MAX_SAFE_INTEGER),
  limit: optionalIntegerSchema(MAX_READ_LINE_LIMIT),
});

const listInputSchema = z.strictObject({
  path: optionalPathSchema,
  limit: optionalIntegerSchema(MAX_LIST_LIMIT),
});

const findInputSchema = z.strictObject({
  pattern: z.string().trim().min(1),
  path: optionalPathSchema,
  limit: optionalIntegerSchema(MAX_LIST_LIMIT),
});

const grepInputSchema = z.strictObject({
  pattern: z.string().trim().min(1),
  path: optionalPathSchema,
  glob: optionalGlobSchema,
  ignoreCase: optionalBooleanSchema,
  literal: optionalBooleanSchema,
  limit: optionalIntegerSchema(MAX_GREP_LIMIT),
});

type ReadInput = z.infer<typeof readInputSchema>;
type ListInput = z.infer<typeof listInputSchema>;
type FindInput = z.infer<typeof findInputSchema>;
type GrepInput = z.infer<typeof grepInputSchema>;

function createBuiltinReadOnlyToolBase(category: AgentToolCategory) {
  return {
    source: 'builtin',
    group: 'read_only_builtins',
    category: category,
    annotations: {
      readOnly: true,
      destructive: false,
      openWorld: false,
      idempotent: true,
    },
    executionMode: 'parallel',
    timeoutMs: DEFAULT_AGENT_TOOL_TIMEOUT_MS,
    abortable: true,
    pathAccess: currentProjectPathAccessPolicy,
  } satisfies Pick<
    AgentToolDefinition,
    | 'source'
    | 'group'
    | 'category'
    | 'annotations'
    | 'executionMode'
    | 'timeoutMs'
    | 'abortable'
    | 'pathAccess'
  >;
}

const readToolDefinition = {
  name: 'read',
  ...createBuiltinReadOnlyToolBase('read'),
  modelTool: {
    name: 'read',
    description:
      'Read a UTF-8 text file. Relative paths resolve from the current project root. Supports line pagination with offset and limit. Use this instead of shell cat or sed when examining files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description:
            'File path to read. Relative paths resolve from the current project root.',
        },
        offset: {
          type: 'number',
          description:
            '1-based line number to start reading from. Defaults to 1.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LINE_LIMIT}, maximum ${MAX_READ_LINE_LIMIT}.`,
        },
      },
      required: ['path'],
    },
    schemaStrict: true,
  },
  execute: async (argumentsJson: string): Promise<AgentToolResult> => {
    const input = parseToolInput('read', argumentsJson, readInputSchema);
    const result = await readLocalFile(input);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatReadFileResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

const listToolDefinition = {
  name: 'ls',
  ...createBuiltinReadOnlyToolBase('read'),
  modelTool: {
    name: 'ls',
    description:
      'List local directory entries. Relative paths resolve from the current project root. Use this for quick directory exploration before reading files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path to list. Relative paths resolve from the current project root. Defaults to the current project root.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of entries to return. Defaults to ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT}.`,
        },
      },
      required: [],
    },
    schemaStrict: true,
  },
  execute: async (argumentsJson: string): Promise<AgentToolResult> => {
    const input = parseToolInput('ls', argumentsJson, listInputSchema);
    const result = await listLocalDirectory(input);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatListFilesResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

const findToolDefinition = {
  name: 'find',
  ...createBuiltinReadOnlyToolBase('search'),
  modelTool: {
    name: 'find',
    description:
      'Find local files by glob-style path pattern. Relative paths resolve from the current project root. Use this for file-name discovery.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description:
            'Glob-style file-name or path pattern, for example "*.ts" or "src/**/*.ts".',
        },
        path: {
          type: 'string',
          description:
            'Directory path to search. Relative paths resolve from the current project root. Defaults to the current project root.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of paths to return. Defaults to ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT}.`,
        },
      },
      required: ['pattern'],
    },
    schemaStrict: true,
  },
  execute: async (argumentsJson: string): Promise<AgentToolResult> => {
    const input = parseToolInput('find', argumentsJson, findInputSchema);
    const result = await findLocalFiles(input);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatFindFilesResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

const grepToolDefinition = {
  name: 'grep',
  ...createBuiltinReadOnlyToolBase('search'),
  modelTool: {
    name: 'grep',
    description:
      'Search local file contents using ripgrep. Relative paths resolve from the current project root. Use this before reading full files when looking for text or symbols.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern. Treated as regex unless literal=true.',
        },
        path: {
          type: 'string',
          description:
            'File or directory path to search. Relative paths resolve from the current project root. Defaults to the current project root.',
        },
        glob: {
          type: 'string',
          description: 'Optional ripgrep glob filter, for example "*.ts".',
        },
        ignoreCase: {
          type: 'boolean',
          description: 'Use case-insensitive search.',
        },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as a literal string instead of regex.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of matches to return. Defaults to ${DEFAULT_GREP_LIMIT}, maximum ${MAX_GREP_LIMIT}.`,
        },
      },
      required: ['pattern'],
    },
    schemaStrict: true,
  },
  execute: async (argumentsJson: string): Promise<AgentToolResult> => {
    const input = parseToolInput('grep', argumentsJson, grepInputSchema);
    const result = await grepLocalFiles(input);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatGrepResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

export const builtinReadOnlyToolDefinitions: AgentToolDefinition[] = [
  readToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  listToolDefinition,
];

function parseToolInput<T>(
  toolName: string,
  argumentsJson: string,
  schema: z.ZodType<T>,
): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argumentsJson);
  } catch {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      `Tool \`${toolName}\` received invalid JSON arguments.`,
    );
  }

  const parsedInput = schema.safeParse(parsedJson);

  if (!parsedInput.success) {
    throw new AgentToolRespondToModelError(
      'VALIDATION_ERROR',
      `Tool \`${toolName}\` received invalid arguments.`,
    );
  }

  return parsedInput.data;
}

async function resolveBuiltinToolPath(inputPath: string | undefined) {
  const unresolvedPath = resolveAgentToolPath(
    inputPath,
    currentProjectPathAccessPolicy,
  );

  let realAbsolutePath: string;
  try {
    realAbsolutePath = await realpath(
      /* turbopackIgnore: true */ unresolvedPath.absolutePath,
    );
  } catch {
    throw new AgentToolRespondToModelError(
      'PATH_NOT_FOUND',
      `Path not found: ${unresolvedPath.displayPath}`,
    );
  }

  assertAgentPathAllowedByPolicy(
    realAbsolutePath,
    currentProjectPathAccessPolicy,
  );

  return {
    absolutePath: realAbsolutePath,
    displayPath: displayAgentToolPath(
      realAbsolutePath,
      currentProjectPathAccessPolicy,
    ),
  } satisfies ResolvedAgentToolPath;
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}

async function assertFile(pathInfo: ResolvedAgentToolPath): Promise<void> {
  const pathStat = await stat(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
  );

  if (!pathStat.isFile()) {
    throw new AgentToolRespondToModelError(
      'NOT_A_FILE',
      `Path is not a file: ${pathInfo.displayPath}`,
    );
  }
}

async function assertDirectory(
  pathInfo: ResolvedAgentToolPath,
): Promise<void> {
  const pathStat = await stat(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
  );

  if (!pathStat.isDirectory()) {
    throw new AgentToolRespondToModelError(
      'NOT_A_DIRECTORY',
      `Path is not a directory: ${pathInfo.displayPath}`,
    );
  }
}

function splitTextLines(text: string): string[] {
  if (text === '') {
    return [];
  }

  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function truncateToUtf8Bytes(text: string, maxBytes: number) {
  let bytes = 0;
  let output = '';

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      return {
        text: output,
        truncated: true,
      };
    }

    bytes += characterBytes;
    output += character;
  }

  return {
    text: output,
    truncated: false,
  };
}

async function readLocalFile(input: ReadInput): Promise<ReadFileResult> {
  const pathInfo = await resolveBuiltinToolPath(input.path);
  await assertFile(pathInfo);

  const fileContent = await readFile(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
    'utf8',
  );
  const lines = splitTextLines(fileContent);
  const startLine = input.offset ?? 1;
  const lineLimit = input.limit ?? DEFAULT_READ_LINE_LIMIT;
  const startIndex = Math.min(startLine - 1, lines.length);
  const selectedLines = lines.slice(startIndex, startIndex + lineLimit);
  const joinedLines = selectedLines.join('\n');
  const byteTruncation = truncateToUtf8Bytes(joinedLines, MAX_OUTPUT_BYTES);
  const endLine =
    selectedLines.length === 0
      ? startLine - 1
      : startLine + selectedLines.length - 1;
  const hasMoreLines = startIndex + selectedLines.length < lines.length;
  const notices: string[] = [];

  if (hasMoreLines) {
    notices.push(
      `Showing lines ${startLine}-${endLine} of ${lines.length}. Use offset=${
        endLine + 1
      } to continue.`,
    );
  }

  if (byteTruncation.truncated) {
    notices.push(
      `${formatBytes(MAX_OUTPUT_BYTES)} output limit reached. Use a smaller limit or later offset.`,
    );
  }

  return {
    path: pathInfo.displayPath,
    startLine: startLine,
    endLine: endLine,
    totalLines: lines.length,
    content: byteTruncation.text,
    truncated: hasMoreLines || byteTruncation.truncated,
    notice: notices.length === 0 ? null : notices.join(' '),
  };
}

async function listLocalDirectory(input: ListInput): Promise<ListFilesResult> {
  const pathInfo = await resolveBuiltinToolPath(input.path);
  await assertDirectory(pathInfo);

  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const entries = (
    await readdir(/* turbopackIgnore: true */ pathInfo.absolutePath, {
      withFileTypes: true,
    })
  )
    .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleEntries = entries.slice(0, limit).map((entry) => {
    return {
      name: entry.name,
      path: normalizePathSeparators(
        path.join(pathInfo.displayPath, entry.name),
      ),
      type: readDirectoryEntryType(entry),
    } satisfies ListEntry;
  });
  const truncated = entries.length > visibleEntries.length;

  return {
    path: pathInfo.displayPath,
    entries: visibleEntries,
    truncated: truncated,
    notice: truncated
      ? `${limit} entry limit reached. Use a narrower path.`
      : null,
  };
}

function readDirectoryEntryType(entry: {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): DirectoryEntryType {
  if (entry.isDirectory()) {
    return 'directory';
  }

  if (entry.isFile()) {
    return 'file';
  }

  if (entry.isSymbolicLink()) {
    return 'symlink';
  }

  return 'other';
}

async function findLocalFiles(input: FindInput): Promise<FindFilesResult> {
  const pathInfo = await resolveBuiltinToolPath(input.path);
  await assertDirectory(pathInfo);

  const matcher = createGlobMatcher(input.pattern);
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const paths: string[] = [];
  const hasMore = await collectMatchingFiles(
    pathInfo.absolutePath,
    matcher,
    paths,
    limit,
  );

  return {
    path: pathInfo.displayPath,
    pattern: input.pattern,
    paths: paths,
    truncated: hasMore,
    notice: hasMore
      ? `${limit} path limit reached. Use a narrower path or pattern.`
      : null,
  };
}

async function collectMatchingFiles(
  directoryPath: string,
  matcher: (relativePath: string) => boolean,
  paths: string[],
  limit: number,
): Promise<boolean> {
  const entries = (
    await readdir(/* turbopackIgnore: true */ directoryPath, {
      withFileTypes: true,
    })
  ).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const absoluteEntryPath = path.join(directoryPath, entry.name);
    const relativeEntryPath = displayAgentToolPath(
      absoluteEntryPath,
      currentProjectPathAccessPolicy,
    );

    if (entry.isDirectory()) {
      const childHasMore = await collectMatchingFiles(
        absoluteEntryPath,
        matcher,
        paths,
        limit,
      );
      if (childHasMore) {
        return true;
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (matcher(relativeEntryPath)) {
      if (paths.length >= limit) {
        return true;
      }

      paths.push(relativeEntryPath);
    }
  }

  return false;
}

function createGlobMatcher(pattern: string): (relativePath: string) => boolean {
  const regex = globToRegExp(pattern);
  const patternChecksFullPath = pattern.includes('/');

  return (relativePath: string) => {
    const value = patternChecksFullPath
      ? relativePath
      : path.posix.basename(relativePath);

    return regex.test(value);
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const nextCharacter = pattern[index + 1];

    if (character === '*' && nextCharacter === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (character === '*') {
      source += '[^/]*';
      continue;
    }

    if (character === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(character);
  }

  source += '$';

  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

async function grepLocalFiles(input: GrepInput): Promise<GrepResult> {
  const pathInfo = await resolveBuiltinToolPath(input.path);
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const matches = await runRipgrep(input, pathInfo, limit);
  const visibleMatches = matches.slice(0, limit);
  const lineTruncated = visibleMatches.some(
    (match) => match.line.length > GREP_MAX_LINE_LENGTH,
  );
  const normalizedMatches = visibleMatches.map((match) => {
    return {
      ...match,
      line:
        match.line.length > GREP_MAX_LINE_LENGTH
          ? `${match.line.slice(0, GREP_MAX_LINE_LENGTH)}...`
          : match.line,
    };
  });
  const outputPreview = JSON.stringify(normalizedMatches);
  const byteTruncated =
    Buffer.byteLength(outputPreview, 'utf8') > MAX_OUTPUT_BYTES;
  const notices: string[] = [];

  if (matches.length > limit) {
    notices.push(
      `${limit} match limit reached. Use limit=${Math.min(
        limit * 2,
        MAX_GREP_LIMIT,
      )} for more, or refine pattern.`,
    );
  }

  if (lineTruncated) {
    notices.push(
      `Some lines were truncated to ${GREP_MAX_LINE_LENGTH} characters. Use read to see full lines.`,
    );
  }

  if (byteTruncated) {
    notices.push(
      `${formatBytes(MAX_OUTPUT_BYTES)} output limit reached. Refine the pattern or path.`,
    );
  }

  return {
    path: pathInfo.displayPath,
    pattern: input.pattern,
    matches: byteTruncated ? [] : normalizedMatches,
    truncated: matches.length > limit || lineTruncated || byteTruncated,
    notice: notices.length === 0 ? null : notices.join(' '),
  };
}

async function runRipgrep(
  input: GrepInput,
  pathInfo: ResolvedAgentToolPath,
  limit: number,
): Promise<GrepMatch[]> {
  const args = [
    '--json',
    '--line-number',
    '--color=never',
    '--hidden',
    '--glob',
    '!**/.git/**',
    '--glob',
    '!**/.next/**',
    '--glob',
    '!**/node_modules/**',
  ];

  if (input.ignoreCase === true) {
    args.push('--ignore-case');
  }

  if (input.literal === true) {
    args.push('--fixed-strings');
  }

  if (input.glob !== undefined) {
    args.push('--glob', input.glob);
  }

  args.push('--', input.pattern, pathInfo.absolutePath);

  const output = await collectProcessOutput('rg', args);
  const matches: GrepMatch[] = [];

  for (const line of output.stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
    };

    if (event.type !== 'match') {
      continue;
    }

    const absoluteMatchPath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;

    if (
      absoluteMatchPath === undefined ||
      lineNumber === undefined ||
      lineText === undefined
    ) {
      continue;
    }

    matches.push({
      path: displayAgentToolPath(
        absoluteMatchPath,
        currentProjectPathAccessPolicy,
      ),
      lineNumber: lineNumber,
      line: lineText.replace(/\r?\n$/, ''),
    });

    if (matches.length > limit) {
      break;
    }
  }

  return matches;
}

function collectProcessOutput(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: currentProjectPathAccessPolicy.root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      reject(
        new Error(
          `ripgrep (rg) is required for grep but was not found: ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code !== 0 && code !== 1) {
        reject(new Error(stderr || `rg exited with code ${code}.`));
        return;
      }

      resolve({
        stdout: stdout,
        stderr: stderr,
      });
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes % 1024 === 0) {
    return `${bytes / 1024}KB`;
  }

  return `${bytes} bytes`;
}

function formatReadFileResult(result: ReadFileResult): string {
  return [
    `File: ${result.path}`,
    `Lines: ${result.startLine}-${result.endLine} of ${result.totalLines}`,
    '',
    result.content,
  ].join('\n');
}

function formatListFilesResult(result: ListFilesResult): string {
  if (result.entries.length === 0) {
    return `Directory: ${result.path}\n\nNo entries.`;
  }

  return [
    `Directory: ${result.path}`,
    '',
    ...result.entries.map(
      (entry) => `${entry.type.padEnd(9, ' ')} ${entry.path}`,
    ),
  ].join('\n');
}

function formatFindFilesResult(result: FindFilesResult): string {
  if (result.paths.length === 0) {
    return `Find: ${result.pattern}\nPath: ${result.path}\n\nNo matching files.`;
  }

  return [
    `Find: ${result.pattern}`,
    `Path: ${result.path}`,
    '',
    ...result.paths,
  ].join('\n');
}

function formatGrepResult(result: GrepResult): string {
  if (result.matches.length === 0) {
    return `Grep: ${result.pattern}\nPath: ${result.path}\n\nNo matches.`;
  }

  return [
    `Grep: ${result.pattern}`,
    `Path: ${result.path}`,
    '',
    ...result.matches.map(
      (match) => `${match.path}:${match.lineNumber}: ${match.line}`,
    ),
  ].join('\n');
}
