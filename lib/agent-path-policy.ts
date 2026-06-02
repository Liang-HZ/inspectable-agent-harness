import path from 'node:path';

import { AgentToolRespondToModelError } from './agent-tool-output';

export type AgentToolPathAccessPolicy =
  | {
      type: 'none';
    }
  | {
      type: 'current_project';
      root: string;
    }
  | {
      type: 'allowed_roots';
      roots: string[];
    }
  | {
      type: 'danger_full_access';
    };

export type ResolvedAgentToolPath = {
  absolutePath: string;
  displayPath: string;
};

export const AGENT_CURRENT_PROJECT_ROOT = path.join(
  /* turbopackIgnore: true*/ process.cwd(),
  '.',
);

export const noPathAccessPolicy = {
  type: 'none',
} satisfies AgentToolPathAccessPolicy;

export const currentProjectPathAccessPolicy = {
  type: 'current_project',
  root: AGENT_CURRENT_PROJECT_ROOT,
} satisfies AgentToolPathAccessPolicy;

export const dangerFullAccessPathAccessPolicy = {
  type: 'danger_full_access',
} satisfies AgentToolPathAccessPolicy;

export function allowedRootsPathAccessPolicy(
  roots: string[],
): AgentToolPathAccessPolicy {
  return {
    type: 'allowed_roots',
    roots: roots.map((root) => path.resolve(root)),
  };
}

export function resolveAgentToolPath(
  inputPath: string | undefined,
  policy: AgentToolPathAccessPolicy,
): ResolvedAgentToolPath {
  const requestedPath = inputPath ?? '.';
  const basePath = readPathResolutionBase(policy);
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(basePath, requestedPath);

  assertAgentPathAllowedByPolicy(absolutePath, policy);

  return {
    absolutePath: absolutePath,
    displayPath: displayAgentToolPath(absolutePath, policy),
  };
}

export function assertAgentPathAllowedByPolicy(
  absolutePath: string,
  policy: AgentToolPathAccessPolicy,
): void {
  const normalizedPath = path.resolve(absolutePath);

  if (policy.type === 'none') {
    throw new AgentToolRespondToModelError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'This tool does not declare filesystem path access.',
    );
  }

  if (policy.type === 'danger_full_access') {
    return;
  }

  if (policy.type === 'current_project') {
    assertPathWithinRoot(normalizedPath, path.resolve(policy.root));
    return;
  }

  if (
    policy.roots.some((root) =>
      isPathWithinRoot(normalizedPath, path.resolve(root)),
    )
  ) {
    return;
  }

  throwPathOutsideAllowedRoot(normalizedPath);
}

export function displayAgentToolPath(
  absolutePath: string,
  policy: AgentToolPathAccessPolicy,
): string {
  const normalizedPath = path.resolve(absolutePath);

  if (policy.type === 'current_project') {
    return displayPathRelativeToRoot(normalizedPath, path.resolve(policy.root));
  }

  if (policy.type === 'allowed_roots') {
    const containingRoot = policy.roots
      .map((root) => path.resolve(root))
      .find((root) => isPathWithinRoot(normalizedPath, root));

    return containingRoot === undefined
      ? normalizePathSeparators(normalizedPath)
      : displayPathRelativeToRoot(normalizedPath, containingRoot);
  }

  return normalizePathSeparators(normalizedPath);
}

function readPathResolutionBase(policy: AgentToolPathAccessPolicy): string {
  if (policy.type === 'current_project') {
    return policy.root;
  }

  if (policy.type === 'allowed_roots') {
    if (policy.roots.length === 0) {
      throw new AgentToolRespondToModelError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        'No allowed roots are configured for this tool.',
      );
    }

    return policy.roots[0];
  }

  return AGENT_CURRENT_PROJECT_ROOT;
}

function assertPathWithinRoot(absolutePath: string, root: string): void {
  if (isPathWithinRoot(absolutePath, root)) {
    return;
  }

  throwPathOutsideAllowedRoot(absolutePath);
}

function isPathWithinRoot(absolutePath: string, root: string): boolean {
  const relativePath = path.relative(root, absolutePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function throwPathOutsideAllowedRoot(absolutePath: string): never {
  throw new AgentToolRespondToModelError(
    'PATH_OUTSIDE_ALLOWED_ROOT',
    `Path is outside the current allowed root: ${path.normalize(absolutePath)}`,
  );
}

function displayPathRelativeToRoot(absolutePath: string, root: string): string {
  const relativePath = path.relative(root, absolutePath);

  return relativePath === '' ? '.' : normalizePathSeparators(relativePath);
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}
