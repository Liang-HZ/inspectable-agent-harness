import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as z from 'zod';

import {
  AgentToolRespondToModelError,
  createSuccessToolOutput,
} from './agent-tool-output';
import {
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  type AgentToolDefinition,
  type AgentToolResult,
  type AgentToolRuntimeContext,
} from './agent-tool-contracts';
import {
  assertAgentPathAllowedByPolicy,
  currentProjectPathAccessPolicy,
  displayAgentToolPath,
  resolveAgentToolPath,
  type ResolvedAgentToolPath,
} from './agent-path-policy';

const MAX_DIFF_CHARS = 20 * 1024;

type WriteFileResult = {
  path: string;
  operation: 'create' | 'overwrite';
  bytesWritten: number;
  diff: string;
  truncated: boolean;
  notice: string | null;
};

type EditFileResult = {
  path: string;
  editCount: number;
  firstChangedLine: number | null;
  bytesWritten: number;
  diff: string;
  truncated: boolean;
  notice: string | null;
};

type TextReplacement = {
  oldText: string;
  newText: string;
};

type LocatedReplacement = TextReplacement & {
  start: number;
  end: number;
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

const writeInputSchema = z.strictObject({
  path: pathSchema,
  content: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Field `content` is required.'
        : 'Field `content` must be a string.',
  }),
});

const editReplacementSchema = z.strictObject({
  oldText: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'Field `oldText` is required.'
          : 'Field `oldText` must be a string.',
    })
    .min(1, { error: 'Field `oldText` is required.' }),
  newText: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Field `newText` is required.'
        : 'Field `newText` must be a string.',
  }),
});

const editInputSchema = z.strictObject({
  path: pathSchema,
  edits: z
    .array(editReplacementSchema, {
      error: (issue) =>
        issue.input === undefined
          ? 'Field `edits` is required.'
          : 'Field `edits` must be an array.',
    })
    .min(1, { error: 'Field `edits` must contain at least one edit.' }),
});

type WriteInput = z.infer<typeof writeInputSchema>;
type EditInput = z.infer<typeof editInputSchema>;

function createBuiltinEditingToolBase() {
  return {
    source: 'builtin',
    group: 'editing_builtins',
    category: 'write',
    annotations: {
      readOnly: false,
      destructive: true,
      openWorld: false,
      idempotent: false,
    },
    executionMode: 'sequential',
    timeoutMs: DEFAULT_AGENT_TOOL_TIMEOUT_MS,
    abortable: true,
    pathAccess: currentProjectPathAccessPolicy,
    permissionInput: {
      pathArgumentName: 'path',
    },
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
    | 'permissionInput'
  >;
}

const writeToolDefinition = {
  name: 'write',
  ...createBuiltinEditingToolBase(),
  modelTool: {
    name: 'write',
    description:
      'Create or overwrite a UTF-8 text file. Relative paths resolve from the current project root. Creates parent directories when needed and returns a diff.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description:
            'File path to create or overwrite. Relative paths resolve from the current project root.',
        },
        content: {
          type: 'string',
          description: 'Complete UTF-8 file content to write.',
        },
      },
      required: ['path', 'content'],
    },
    schemaStrict: true,
  },
  execute: async (
    argumentsJson: string,
    _signal: AbortSignal | undefined,
    runtime: AgentToolRuntimeContext,
  ): Promise<AgentToolResult> => {
    const input = parseToolInput('write', argumentsJson, writeInputSchema);
    const result = await writeLocalFile(input, runtime.pathAccess);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatWriteFileResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

const editToolDefinition = {
  name: 'edit',
  ...createBuiltinEditingToolBase(),
  permissionInput: {
    pathArgumentName: 'path',
    requiresPriorRead: true,
  },
  modelTool: {
    name: 'edit',
    description:
      'Edit an existing UTF-8 text file with exact replacements. You must read the target file first in the same run before using edit. All replacements are validated against the original file before anything is written.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description:
            'Existing file path to edit. Relative paths resolve from the current project root.',
        },
        edits: {
          type: 'array',
          description:
            'Exact text replacements to apply atomically to the original file.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: {
                type: 'string',
                description:
                  'Exact text from the current file. It must appear exactly once.',
              },
              newText: {
                type: 'string',
                description: 'Replacement text.',
              },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    schemaStrict: true,
  },
  execute: async (
    argumentsJson: string,
    _signal: AbortSignal | undefined,
    runtime: AgentToolRuntimeContext,
  ): Promise<AgentToolResult> => {
    const input = parseToolInput('edit', argumentsJson, editInputSchema);
    const result = await editLocalFile(input, runtime.pathAccess);

    return {
      input: input,
      output: createSuccessToolOutput({
        contentText: formatEditFileResult(result),
        details: result,
        notice: result.notice,
        truncated: result.truncated,
      }),
    };
  },
} satisfies AgentToolDefinition;

export const builtinEditingToolDefinitions: AgentToolDefinition[] = [
  writeToolDefinition,
  editToolDefinition,
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

async function writeLocalFile(
  input: WriteInput,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<WriteFileResult> {
  const pathInfo = await resolveWritableFilePath(input.path, pathAccess);
  const existingContent = await readExistingFileContent(pathInfo);

  await mkdir(/* turbopackIgnore: true */ path.dirname(pathInfo.absolutePath), {
    recursive: true,
  });
  await writeFile(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
    input.content,
    'utf8',
  );

  const diff = createTruncatedDiff(
    existingContent ?? '',
    input.content,
    pathInfo.displayPath,
  );

  return {
    path: pathInfo.displayPath,
    operation: existingContent === null ? 'create' : 'overwrite',
    bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    diff: diff.text,
    truncated: diff.truncated,
    notice: diff.truncated
      ? `${formatBytes(MAX_DIFF_CHARS)} diff limit reached.`
      : null,
  };
}

async function editLocalFile(
  input: EditInput,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<EditFileResult> {
  const pathInfo = await resolveEditableFilePath(input.path, pathAccess);
  const originalContent = await readFile(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
    'utf8',
  );
  const updatedContent = applyTextReplacements(originalContent, input.edits);
  const diff = createTruncatedDiff(
    originalContent,
    updatedContent,
    pathInfo.displayPath,
  );

  await writeFile(
    /* turbopackIgnore: true */ pathInfo.absolutePath,
    updatedContent,
    'utf8',
  );

  return {
    path: pathInfo.displayPath,
    editCount: input.edits.length,
    firstChangedLine: findFirstChangedLine(originalContent, updatedContent),
    bytesWritten: Buffer.byteLength(updatedContent, 'utf8'),
    diff: diff.text,
    truncated: diff.truncated,
    notice: diff.truncated
      ? `${formatBytes(MAX_DIFF_CHARS)} diff limit reached.`
      : null,
  };
}

async function resolveWritableFilePath(
  inputPath: string,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<ResolvedAgentToolPath> {
  const unresolvedPath = resolveAgentToolPath(inputPath, pathAccess);
  const existingFilePath = await maybeResolveExistingFilePath(
    unresolvedPath,
    pathAccess,
  );

  if (existingFilePath !== null) {
    return existingFilePath;
  }

  await assertWritableParentAllowed(unresolvedPath.absolutePath, pathAccess);

  return unresolvedPath;
}

async function resolveEditableFilePath(
  inputPath: string,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<ResolvedAgentToolPath> {
  const unresolvedPath = resolveAgentToolPath(inputPath, pathAccess);
  const existingFilePath = await maybeResolveExistingFilePath(
    unresolvedPath,
    pathAccess,
  );

  if (existingFilePath === null) {
    throw new AgentToolRespondToModelError(
      'PATH_NOT_FOUND',
      `Path not found: ${unresolvedPath.displayPath}`,
    );
  }

  return existingFilePath;
}

async function maybeResolveExistingFilePath(
  unresolvedPath: ResolvedAgentToolPath,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<ResolvedAgentToolPath | null> {
  let realAbsolutePath: string;
  try {
    realAbsolutePath = await realpath(
      /* turbopackIgnore: true */ unresolvedPath.absolutePath,
    );
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }

  assertAgentPathAllowedByPolicy(realAbsolutePath, pathAccess);

  const pathStat = await stat(/* turbopackIgnore: true */ realAbsolutePath);

  if (!pathStat.isFile()) {
    throw new AgentToolRespondToModelError(
      'NOT_A_FILE',
      `Path is not a file: ${displayAgentToolPath(realAbsolutePath, pathAccess)}`,
    );
  }

  return {
    absolutePath: realAbsolutePath,
    displayPath: displayAgentToolPath(realAbsolutePath, pathAccess),
  };
}

async function assertWritableParentAllowed(
  targetAbsolutePath: string,
  pathAccess: AgentToolRuntimeContext['pathAccess'],
): Promise<void> {
  let ancestorPath = path.dirname(targetAbsolutePath);

  for (;;) {
    let realAncestorPath: string;
    try {
      realAncestorPath = await realpath(
        /* turbopackIgnore: true */ ancestorPath,
      );
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }

      const parentPath = path.dirname(ancestorPath);
      if (parentPath === ancestorPath) {
        throw new AgentToolRespondToModelError(
          'PATH_NOT_FOUND',
          `No existing parent directory found for: ${targetAbsolutePath}`,
        );
      }

      ancestorPath = parentPath;
      continue;
    }

    assertAgentPathAllowedByPolicy(realAncestorPath, pathAccess);

    const ancestorStat = await stat(
      /* turbopackIgnore: true */ realAncestorPath,
    );

    if (!ancestorStat.isDirectory()) {
      throw new AgentToolRespondToModelError(
        'NOT_A_DIRECTORY',
        `Path parent is not a directory: ${displayAgentToolPath(
          realAncestorPath,
          pathAccess,
        )}`,
      );
    }

    return;
  }
}

async function readExistingFileContent(
  pathInfo: ResolvedAgentToolPath,
): Promise<string | null> {
  try {
    return await readFile(
      /* turbopackIgnore: true */ pathInfo.absolutePath,
      'utf8',
    );
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
}

function applyTextReplacements(
  originalContent: string,
  replacements: TextReplacement[],
): string {
  const locatedReplacements = locateTextReplacements(
    originalContent,
    replacements,
  );
  let updatedContent = originalContent;

  for (const replacement of [...locatedReplacements].reverse()) {
    updatedContent =
      updatedContent.slice(0, replacement.start) +
      replacement.newText +
      updatedContent.slice(replacement.end);
  }

  return updatedContent;
}

function locateTextReplacements(
  originalContent: string,
  replacements: TextReplacement[],
): LocatedReplacement[] {
  const locatedReplacements = replacements
    .map((replacement) => locateTextReplacement(originalContent, replacement))
    .sort((left, right) => left.start - right.start);

  for (let index = 1; index < locatedReplacements.length; index += 1) {
    const previous = locatedReplacements[index - 1];
    const current = locatedReplacements[index];

    if (current.start < previous.end) {
      throw new AgentToolRespondToModelError(
        'EDIT_OVERLAP',
        'Edit replacements overlap in the original file. Use non-overlapping oldText values.',
      );
    }
  }

  return locatedReplacements;
}

function locateTextReplacement(
  originalContent: string,
  replacement: TextReplacement,
): LocatedReplacement {
  const occurrences = findTextOccurrences(originalContent, replacement.oldText);

  if (occurrences.length === 0) {
    throw new AgentToolRespondToModelError(
      'EDIT_TARGET_NOT_FOUND',
      'Edit target text was not found in the original file. Read the file again and use exact oldText.',
      {
        oldText: replacement.oldText,
      },
    );
  }

  if (occurrences.length > 1) {
    throw new AgentToolRespondToModelError(
      'EDIT_TARGET_NOT_UNIQUE',
      'Edit target text appears more than once in the original file. Use a larger exact oldText block.',
      {
        oldText: replacement.oldText,
        occurrences: occurrences.length,
      },
    );
  }

  return {
    oldText: replacement.oldText,
    newText: replacement.newText,
    start: occurrences[0],
    end: occurrences[0] + replacement.oldText.length,
  };
}

function findTextOccurrences(content: string, needle: string): number[] {
  const occurrences: number[] = [];
  let startIndex = 0;

  for (;;) {
    const foundIndex = content.indexOf(needle, startIndex);

    if (foundIndex === -1) {
      return occurrences;
    }

    occurrences.push(foundIndex);
    startIndex = foundIndex + 1;
  }
}

function createTruncatedDiff(
  before: string,
  after: string,
  displayPath: string,
): { text: string; truncated: boolean } {
  const diff = createFocusedDiff(before, after, displayPath);

  if (diff.length <= MAX_DIFF_CHARS) {
    return {
      text: diff,
      truncated: false,
    };
  }

  return {
    text: `${diff.slice(0, MAX_DIFF_CHARS)}\n...diff truncated...`,
    truncated: true,
  };
}

function createFocusedDiff(
  before: string,
  after: string,
  displayPath: string,
): string {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  let start = 0;

  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;

  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const removedLines = beforeLines.slice(start, beforeEnd + 1);
  const addedLines = afterLines.slice(start, afterEnd + 1);
  const diffLines = [
    `--- ${displayPath}`,
    `+++ ${displayPath}`,
    `@@ line ${start + 1} @@`,
    ...removedLines.map((line) => `-${line}`),
    ...addedLines.map((line) => `+${line}`),
  ];

  if (removedLines.length === 0 && addedLines.length === 0) {
    diffLines.push('(no textual changes)');
  }

  return diffLines.join('\n');
}

function splitDiffLines(text: string): string[] {
  if (text === '') {
    return [];
  }

  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function findFirstChangedLine(before: string, after: string): number | null {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      return index + 1;
    }
  }

  return null;
}

function formatWriteFileResult(result: WriteFileResult): string {
  return [
    `Successfully wrote ${result.bytesWritten} bytes to ${result.path}.`,
    `Operation: ${result.operation}`,
    '',
    'Diff:',
    result.diff,
  ].join('\n');
}

function formatEditFileResult(result: EditFileResult): string {
  return [
    `Successfully edited ${result.path} with ${result.editCount} replacement(s).`,
    result.firstChangedLine === null
      ? 'First changed line: none'
      : `First changed line: ${result.firstChangedLine}`,
    '',
    'Diff:',
    result.diff,
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes % 1024 === 0) {
    return `${bytes / 1024}KB`;
  }

  return `${bytes} bytes`;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
