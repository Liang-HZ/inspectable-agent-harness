import type { AgentDebugStreamEvent } from './agent-api-types';

/**
 * Rebuilds a span tree from the debug event stream.
 *
 * Kept out of the React component on purpose: turning a flat, out-of-order
 * event stream into a tree with durations is the part that can be wrong, and
 * the part worth testing. The component below it only positions rectangles.
 *
 * The same function serves the live stream and a replayed session file, because
 * both are the same sequence of events — which is the point of the JSONL being
 * the source of truth rather than a side effect of rendering.
 */

export type AgentTraceNodeKind = 'run' | 'subagent' | 'model' | 'tool';

export type AgentTraceTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentTraceNode = {
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: AgentTraceNodeKind;
  detail: string;
  startedAtMs: number;
  /** Undefined while the span is still open. */
  endedAtMs: number | undefined;
  durationMs: number | undefined;
  isError: boolean;
  tokens: AgentTraceTokenUsage | undefined;
  /** Set on a `task` tool span once its subagent's session id is known. */
  subagentSessionId: string | undefined;
  children: AgentTraceNode[];
  depth: number;
};

export type AgentTraceTree = {
  roots: AgentTraceNode[];
  startedAtMs: number;
  /** End of the last closed span, or of the whole trace if all are closed. */
  endedAtMs: number;
  totalDurationMs: number;
  spanCount: number;
  /** True when at least one span never closed — a cancelled or crashed run. */
  hasOpenSpans: boolean;
};

const EMPTY_TREE: AgentTraceTree = {
  roots: [],
  startedAtMs: 0,
  endedAtMs: 0,
  totalDurationMs: 0,
  spanCount: 0,
  hasOpenSpans: false,
};

type MutableNode = AgentTraceNode;

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? undefined : parsed;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function buildAgentTraceTree(
  events: AgentDebugStreamEvent[],
): AgentTraceTree {
  const nodesBySpanId = new Map<string, MutableNode>();
  const order: string[] = [];

  function upsert(
    spanId: string,
    parentSpanId: string | undefined,
    startedAtMs: number,
    seed: Pick<AgentTraceNode, 'name' | 'kind' | 'detail'>,
  ): MutableNode {
    const existing = nodesBySpanId.get(spanId);

    if (existing !== undefined) {
      return existing;
    }

    const node: MutableNode = {
      spanId: spanId,
      parentSpanId: parentSpanId,
      name: seed.name,
      kind: seed.kind,
      detail: seed.detail,
      startedAtMs: startedAtMs,
      endedAtMs: undefined,
      durationMs: undefined,
      isError: false,
      tokens: undefined,
      subagentSessionId: undefined,
      children: [],
      depth: 0,
    };

    nodesBySpanId.set(spanId, node);
    order.push(spanId);

    return node;
  }

  for (const event of events) {
    const span = 'span' in event ? event.span : undefined;

    // Events from a session recorded before tracing existed carry no span and
    // simply do not appear in the waterfall.
    if (span === undefined) {
      continue;
    }

    if (event.type === 'runStarted') {
      const isSubagent = (event.spawnDepth ?? 0) > 0;
      upsert(
        span.spanId,
        span.parentSpanId,
        parseTimestamp(event.startedAt) ?? 0,
        {
          name: isSubagent ? 'subagent' : 'agent run',
          kind: isSubagent ? 'subagent' : 'run',
          detail: isSubagent
            ? `depth ${event.spawnDepth ?? 0}`
            : event.policy.sandboxMode,
        },
      );
      continue;
    }

    if (event.type === 'modelRequested') {
      upsert(
        span.spanId,
        span.parentSpanId,
        parseTimestamp(event.startedAt) ?? 0,
        {
          name: event.model,
          kind: 'model',
          detail: `round ${event.round}`,
        },
      );
      continue;
    }

    if (event.type === 'modelCompleted') {
      const node = upsert(
        span.spanId,
        span.parentSpanId,
        parseTimestamp(event.timing?.startedAt) ?? 0,
        { name: event.model, kind: 'model', detail: `round ${event.round}` },
      );
      const endedAtMs = parseTimestamp(event.timing?.endedAt);
      node.endedAtMs = endedAtMs;
      node.durationMs = event.timing?.durationMs;

      const tokenUsage = event.usage.tokenUsage;
      if (tokenUsage !== null) {
        node.tokens = {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
        };
      }
      continue;
    }

    if (event.type === 'toolStarted') {
      upsert(
        span.spanId,
        span.parentSpanId,
        parseTimestamp(event.startedAt) ?? 0,
        {
          name: event.toolName,
          kind: 'tool',
          detail: truncate(event.argumentsJson, 80),
        },
      );
      continue;
    }

    if (event.type === 'toolFinished') {
      const node = upsert(
        span.spanId,
        span.parentSpanId,
        parseTimestamp(event.timing?.startedAt) ?? 0,
        { name: event.toolName, kind: 'tool', detail: '' },
      );
      node.endedAtMs = parseTimestamp(event.timing?.endedAt);
      node.durationMs = event.timing?.durationMs;
      node.isError = event.isError;
      node.subagentSessionId = event.subagentSessionId;
    }
  }

  if (nodesBySpanId.size === 0) {
    return EMPTY_TREE;
  }

  // Link children to parents. A span whose parent is not in this stream is
  // treated as a root: that happens while a subagent's events are arriving
  // before its parent's, and dropping them would be worse than showing them.
  const roots: MutableNode[] = [];
  for (const spanId of order) {
    const node = nodesBySpanId.get(spanId);
    if (node === undefined) {
      continue;
    }

    const parent =
      node.parentSpanId === undefined
        ? undefined
        : nodesBySpanId.get(node.parentSpanId);

    if (parent === undefined) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  function assignDepth(node: MutableNode, depth: number): void {
    node.depth = depth;
    node.children.sort((left, right) => left.startedAtMs - right.startedAtMs);

    for (const child of node.children) {
      assignDepth(child, depth + 1);
    }
  }

  /**
   * Closes container spans from their children.
   *
   * A run's completion never reaches this stream: `run_succeeded` projects to a
   * `done` stream event, not to a debug event, so a `run`/`subagent` span has no
   * closing event to pair with. Without this the root bar would render as
   * permanently unfinished on every successful run — which is exactly the
   * signal that should mean something went wrong.
   *
   * Deriving the extent from descendants is not a workaround but the honest
   * reading: a container span covers its children, and it stays open precisely
   * when one of them never returned.
   */
  function closeContainerFromChildren(node: MutableNode): number | undefined {
    let latestEnd = node.endedAtMs;
    let anyChildOpen = false;

    for (const child of node.children) {
      const childEnd = closeContainerFromChildren(child);

      if (childEnd === undefined) {
        anyChildOpen = true;
        continue;
      }

      latestEnd = latestEnd === undefined ? childEnd : Math.max(latestEnd, childEnd);
    }

    if (
      node.endedAtMs === undefined &&
      node.children.length > 0 &&
      !anyChildOpen &&
      latestEnd !== undefined
    ) {
      node.endedAtMs = latestEnd;
      node.durationMs = latestEnd - node.startedAtMs;
    }

    return node.endedAtMs;
  }

  roots.sort((left, right) => left.startedAtMs - right.startedAtMs);
  for (const root of roots) {
    assignDepth(root, 0);
    closeContainerFromChildren(root);
  }

  const allNodes = [...nodesBySpanId.values()];
  const startedAtMs = Math.min(...allNodes.map((node) => node.startedAtMs));
  const endedAtMs = Math.max(
    ...allNodes.map((node) => node.endedAtMs ?? node.startedAtMs),
  );

  return {
    roots: roots,
    startedAtMs: startedAtMs,
    endedAtMs: endedAtMs,
    // Never zero: a trace whose spans all landed in the same millisecond would
    // otherwise divide by zero when bars are positioned.
    totalDurationMs: Math.max(endedAtMs - startedAtMs, 1),
    spanCount: allNodes.length,
    hasOpenSpans: allNodes.some((node) => node.endedAtMs === undefined),
  };
}

/** Depth-first flattening, which is the order a waterfall renders rows in. */
export function flattenAgentTraceTree(
  tree: AgentTraceTree,
): AgentTraceNode[] {
  const rows: AgentTraceNode[] = [];

  function visit(node: AgentTraceNode): void {
    rows.push(node);

    for (const child of node.children) {
      visit(child);
    }
  }

  for (const root of tree.roots) {
    visit(root);
  }

  return rows;
}
