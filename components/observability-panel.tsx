'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  ObservabilityBackendId,
  ObservabilityStackStatus,
} from '../lib/observability-stack';

/**
 * Status and controls for the local observability backends.
 *
 * Two things live here that would otherwise be commands you have to look up:
 * sending the current run to a backend, and shutting the whole stack down.
 * A teardown you have to go and find is a teardown that does not happen, and
 * six idle containers cost about 2.4 GiB.
 */

type ExportState =
  | { kind: 'idle' }
  | { kind: 'sending'; backendId: ObservabilityBackendId }
  | { kind: 'sent'; backendId: ObservabilityBackendId; spanCount: number }
  | { kind: 'failed'; backendId: ObservabilityBackendId; error: string };

export function ObservabilityPanel({ sessionId }: { sessionId: string | undefined }) {
  const [status, setStatus] = useState<ObservabilityStackStatus | undefined>(
    undefined,
  );
  const [stopping, setStopping] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/observability');
      const payload = (await response.json()) as {
        ok: boolean;
        status?: ObservabilityStackStatus;
      };

      if (payload.ok && payload.status !== undefined) {
        setStatus(payload.status);
      }
    } catch {
      // Leave the last known status on screen; a failed poll is not news.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stopStack = useCallback(async () => {
    setStopping(true);
    try {
      const response = await fetch('/api/observability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      const payload = (await response.json()) as {
        status?: ObservabilityStackStatus;
      };

      if (payload.status !== undefined) {
        setStatus(payload.status);
      }
    } finally {
      setStopping(false);
    }
  }, []);

  const exportRun = useCallback(
    async (backendId: ObservabilityBackendId) => {
      if (sessionId === undefined) {
        return;
      }

      setExportState({ kind: 'sending', backendId: backendId });
      try {
        const response = await fetch('/api/observability', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'export',
            sessionId: sessionId,
            backendId: backendId,
          }),
        });
        const payload = (await response.json()) as {
          ok: boolean;
          error?: string;
          export?: { spanCount: number; error?: string };
        };

        setExportState(
          payload.ok
            ? {
                kind: 'sent',
                backendId: backendId,
                spanCount: payload.export?.spanCount ?? 0,
              }
            : {
                kind: 'failed',
                backendId: backendId,
                error:
                  payload.export?.error ?? payload.error ?? 'Export failed.',
              },
        );
      } catch (error) {
        setExportState({
          kind: 'failed',
          backendId: backendId,
          error: error instanceof Error ? error.message : 'Export failed.',
        });
      }
    },
    [sessionId],
  );

  if (status === undefined) {
    return null;
  }

  if (!status.dockerAvailable) {
    return (
      <div className="obsPanel">
        <div className="obsPanelHeader">
          <strong>Observability backends</strong>
          <span className="obsHint">
            Docker is not available — the in-app trace above still works.
          </span>
        </div>
      </div>
    );
  }

  const anyRunning = status.backends.some(
    (backend) => backend.state === 'running',
  );

  return (
    <div className="obsPanel">
      <div className="obsPanelHeader">
        <strong>Observability backends</strong>
        <button
          type="button"
          className="obsStopButton"
          onClick={() => void stopStack()}
          disabled={!anyRunning || stopping}
        >
          {stopping ? 'Stopping…' : 'Stop all backends'}
        </button>
      </div>

      <div className="obsBackendList">
        {status.backends.map((backend) => (
          <div className="obsBackend" key={backend.id}>
            <span
              className={`obsDot obsDot-${
                backend.reachable
                  ? 'ready'
                  : backend.state === 'running'
                    ? 'starting'
                    : 'stopped'
              }`}
              aria-hidden="true"
            />
            <span className="obsBackendName">{backend.label}</span>
            <span className="obsBackendMeta">
              {backend.state === 'running'
                ? `${backend.runningContainers}/${backend.totalContainers} containers`
                : 'stopped'}
            </span>
            {backend.reachable ? (
              <a
                className="obsLink"
                href={backend.url}
                target="_blank"
                rel="noreferrer"
              >
                Open ↗
              </a>
            ) : (
              <span className="obsLink obsLinkDisabled">Open ↗</span>
            )}
            <button
              type="button"
              className="obsExportButton"
              onClick={() => void exportRun(backend.id)}
              disabled={
                !backend.reachable ||
                sessionId === undefined ||
                exportState.kind === 'sending'
              }
            >
              {exportState.kind === 'sending' &&
              exportState.backendId === backend.id
                ? 'Sending…'
                : 'Send this run'}
            </button>
          </div>
        ))}
      </div>

      {exportState.kind === 'sent' ? (
        <p className="obsResult">
          Sent {exportState.spanCount} spans to {exportState.backendId}.
        </p>
      ) : null}
      {exportState.kind === 'failed' ? (
        <p className="obsResult obsResultError">
          {exportState.backendId}: {exportState.error}
        </p>
      ) : null}
      <button type="button" className="obsRefresh" onClick={() => void refresh()}>
        Refresh status
      </button>
    </div>
  );
}
