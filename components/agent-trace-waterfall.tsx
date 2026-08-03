import type { AgentDebugStreamEvent } from '../lib/agent-api-types';
import {
  buildAgentTraceTree,
  flattenAgentTraceTree,
} from '../lib/agent-trace-tree';

function formatSpanDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return '…';
  }

  return durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(2)}s`;
}

/**
 * The run's full call chain as a waterfall: every model round and tool call as
 * a bar on a shared time axis, with subagents nested under the `task` call that
 * spawned them.
 *
 * Rendered from the same event stream the browser already receives, so this
 * works live — and because a replayed session file produces the same events, it
 * works offline for a past run too, with no observability backend running.
 */
export function AgentTraceWaterfall({
  events,
}: {
  events: AgentDebugStreamEvent[];
}) {
  const tree = buildAgentTraceTree(events);
  const rows = flattenAgentTraceTree(tree);

  if (rows.length === 0) {
    return (
      <div className="emptyState">
        No spans recorded for this run. Sessions captured before tracing existed
        have no span data.
      </div>
    );
  }

  return (
    <div className="waterfall">
      <div className="waterfallHeader">
        <span>
          <strong>{tree.spanCount}</strong> spans
        </span>
        <span>{formatSpanDuration(tree.totalDurationMs)} total</span>
        {tree.hasOpenSpans ? (
          <span className="waterfallWarning">unfinished spans</span>
        ) : null}
      </div>
      {rows.map((row) => {
        const offsetPercent =
          ((row.startedAtMs - tree.startedAtMs) / tree.totalDurationMs) * 100;
        // An open span runs to the right edge rather than rendering as a
        // zero-width sliver: "still running" has to be visibly different from
        // "finished instantly".
        const widthPercent =
          row.durationMs === undefined
            ? Math.max(100 - offsetPercent, 1)
            : Math.max((row.durationMs / tree.totalDurationMs) * 100, 0.6);

        return (
          <div className="waterfallRow" key={row.spanId}>
            <div
              className="waterfallLabel"
              style={{ paddingLeft: `${row.depth * 14}px` }}
              title={row.detail}
            >
              <span className={`waterfallKind waterfallKind-${row.kind}`}>
                {row.kind}
              </span>
              <span className="waterfallName">{row.name}</span>
            </div>
            <div className="waterfallTrack">
              <div
                className={[
                  'waterfallBar',
                  `waterfallBar-${row.kind}`,
                  row.isError ? 'waterfallBar-error' : '',
                  row.durationMs === undefined ? 'waterfallBar-open' : '',
                ]
                  .filter((name) => name !== '')
                  .join(' ')}
                style={{
                  marginLeft: `${offsetPercent}%`,
                  width: `${widthPercent}%`,
                }}
              />
            </div>
            <div className="waterfallMeta">
              {row.tokens === undefined ? null : (
                <span className="waterfallTokens">
                  {row.tokens.totalTokens} tok
                </span>
              )}
              <span>{formatSpanDuration(row.durationMs)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

