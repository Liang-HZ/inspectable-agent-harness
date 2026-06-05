import path from 'node:path';

import {
  AgentToolRespondToModelError,
  type AgentToolErrorCode,
} from './agent-tool-output';

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

export type AgentToolPathAccessDecision =
  | {
      type: 'allow';
      path: ResolvedAgentToolPath;
    }
  | {
      type: 'deny';
      code: AgentToolErrorCode;
      reason: string;
    };

type AgentToolPathAccessDeniedDecision = Extract<
  AgentToolPathAccessDecision,
  { type: 'deny' }
>;

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
  const decision = decideAgentToolPathAccess(inputPath, policy);

  if (decision.type === 'deny') {
    throw new AgentToolRespondToModelError(decision.code, decision.reason);
  }

  return decision.path;
}

export function decideAgentToolPathAccess(
  inputPath: string | undefined,
  policy: AgentToolPathAccessPolicy,
): AgentToolPathAccessDecision {
  const requestedPath = inputPath ?? '.';
  const basePathDecision = decidePathResolutionBase(policy);

  if (basePathDecision.type === 'deny') {
    return basePathDecision;
  }

  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(basePathDecision.basePath, requestedPath);
  const accessDecision = decideAbsolutePathAccess(absolutePath, policy);

  if (accessDecision.type === 'deny') {
    return accessDecision;
  }

  return {
    type: 'allow',
    path: {
      absolutePath: path.resolve(absolutePath),
      displayPath: displayAgentToolPath(absolutePath, policy),
    },
  };
}

export function assertAgentPathAllowedByPolicy(
  absolutePath: string,
  policy: AgentToolPathAccessPolicy,
): void {
  const decision = decideAbsolutePathAccess(absolutePath, policy);

  if (decision.type === 'allow') {
    return;
  }

  throw new AgentToolRespondToModelError(decision.code, decision.reason);
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

type PathResolutionBaseDecision =
  | {
      type: 'allow';
      basePath: string;
    }
  | {
      type: 'deny';
      code: AgentToolErrorCode;
      reason: string;
    };

function decidePathResolutionBase(
  policy: AgentToolPathAccessPolicy,
): PathResolutionBaseDecision {
  if (policy.type === 'current_project') {
    return {
      type: 'allow',
      basePath: policy.root,
    };
  }

  if (policy.type === 'allowed_roots') {
    if (policy.roots.length === 0) {
      return createPathAccessDenied(
        'No allowed roots are configured for this tool.',
      );
    }

    return {
      type: 'allow',
      basePath: policy.roots[0],
    };
  }

  return {
    type: 'allow',
    basePath: AGENT_CURRENT_PROJECT_ROOT,
  };
}

function isPathWithinRoot(absolutePath: string, root: string): boolean {
  const relativePath = path.relative(root, absolutePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function decideAbsolutePathAccess(
  absolutePath: string,
  policy: AgentToolPathAccessPolicy,
): AgentToolPathAccessDecision {
  const normalizedPath = path.resolve(absolutePath);

  if (policy.type === 'none') {
    return createPathAccessDenied(
      'This tool does not declare filesystem path access.',
    );
  }

  if (policy.type === 'danger_full_access') {
    return {
      type: 'allow',
      path: {
        absolutePath: normalizedPath,
        displayPath: displayAgentToolPath(normalizedPath, policy),
      },
    };
  }

  if (policy.type === 'current_project') {
    if (isPathWithinRoot(normalizedPath, path.resolve(policy.root))) {
      return {
        type: 'allow',
        path: {
          absolutePath: normalizedPath,
          displayPath: displayAgentToolPath(normalizedPath, policy),
        },
      };
    }

    return createPathOutsideAllowedRootDenied(normalizedPath);
  }

  if (
    policy.roots.some((root) =>
      isPathWithinRoot(normalizedPath, path.resolve(root)),
    )
  ) {
    return {
      type: 'allow',
      path: {
        absolutePath: normalizedPath,
        displayPath: displayAgentToolPath(normalizedPath, policy),
      },
    };
  }

  return createPathOutsideAllowedRootDenied(normalizedPath);
}

function createPathOutsideAllowedRootDenied(
  absolutePath: string,
): AgentToolPathAccessDeniedDecision {
  return createPathAccessDenied(
    `Path is outside the current allowed root: ${path.normalize(absolutePath)}`,
  );
}

function createPathAccessDenied(
  reason: string,
): AgentToolPathAccessDeniedDecision {
  return {
    type: 'deny',
    code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    reason: reason,
  };
}

function displayPathRelativeToRoot(absolutePath: string, root: string): string {
  const relativePath = path.relative(root, absolutePath);

  return relativePath === '' ? '.' : normalizePathSeparators(relativePath);
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}
