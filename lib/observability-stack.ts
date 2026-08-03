import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * Control plane for the local observability backends.
 *
 * This module shells out to `docker`, so two rules are absolute:
 *
 * 1. **Nothing from a request ever reaches an argument.** Every container name
 *    below is a constant. The HTTP route accepts an action, not a target, and
 *    an unknown action is rejected before it gets here.
 * 2. **`execFile`, never `exec`.** No shell is spawned, so there is no string
 *    for a metacharacter to hide in.
 *
 * The reason this exists at all: tearing the stack down should be a button in
 * the app, not a command you have to go and look up.
 */

const execFileAsync = promisify(execFile);

export type ObservabilityBackendId = 'phoenix' | 'langfuse';

export type ObservabilityBackendState = 'running' | 'stopped' | 'unknown';

export type ObservabilityBackend = {
  id: ObservabilityBackendId;
  label: string;
  /** Where a human opens it. */
  url: string;
  /** Where traces are POSTed. */
  otlpEndpoint: string;
  /** Fixed container names. Never built from input. */
  containerNames: string[];
  /** Optional Basic-auth credentials, for backends that require them. */
  publicKey?: string;
  secretKey?: string;
};

function readEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();

  return value === undefined || value === '' ? fallback : value;
}

export function getObservabilityBackends(): ObservabilityBackend[] {
  return [
    {
      id: 'phoenix',
      label: 'Arize Phoenix',
      url: readEnv('PHOENIX_URL', 'http://localhost:6006'),
      otlpEndpoint: readEnv(
        'PHOENIX_OTLP_ENDPOINT',
        'http://localhost:6006/v1/traces',
      ),
      containerNames: [readEnv('PHOENIX_CONTAINER', 'phoenix-obs')],
    },
    {
      id: 'langfuse',
      label: 'Langfuse',
      url: readEnv('LANGFUSE_URL', 'http://localhost:3100'),
      otlpEndpoint: readEnv(
        'LANGFUSE_OTLP_ENDPOINT',
        'http://localhost:3100/api/public/otel/v1/traces',
      ),
      // The six containers Langfuse's own compose file brings up.
      containerNames: [
        'langfuse-langfuse-web-1',
        'langfuse-langfuse-worker-1',
        'langfuse-clickhouse-1',
        'langfuse-postgres-1',
        'langfuse-redis-1',
        'langfuse-minio-1',
      ],
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
    },
  ];
}

export type ObservabilityBackendStatus = {
  id: ObservabilityBackendId;
  label: string;
  url: string;
  state: ObservabilityBackendState;
  runningContainers: number;
  totalContainers: number;
  /** True when traces can actually be sent: running *and* answering. */
  reachable: boolean;
};

export type ObservabilityStackStatus = {
  dockerAvailable: boolean;
  backends: ObservabilityBackendStatus[];
};

async function listRunningContainerNames(): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--format', '{{.Names}}'],
      { timeout: 5_000 },
    );

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    // Docker missing or not running. Not an error condition for the app — the
    // harness works fine without any backend; the panel just says so.
    return undefined;
  }
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    });

    return response.status < 500;
  } catch {
    return false;
  }
}

export async function readObservabilityStackStatus(): Promise<ObservabilityStackStatus> {
  const runningNames = await listRunningContainerNames();

  if (runningNames === undefined) {
    return {
      dockerAvailable: false,
      backends: getObservabilityBackends().map((backend) => ({
        id: backend.id,
        label: backend.label,
        url: backend.url,
        state: 'unknown' as const,
        runningContainers: 0,
        totalContainers: backend.containerNames.length,
        reachable: false,
      })),
    };
  }

  const running = new Set(runningNames);
  const backends = await Promise.all(
    getObservabilityBackends().map(async (backend) => {
      const runningContainers = backend.containerNames.filter((name) =>
        running.has(name),
      ).length;
      const state: ObservabilityBackendState =
        runningContainers === 0 ? 'stopped' : 'running';

      return {
        id: backend.id,
        label: backend.label,
        url: backend.url,
        state: state,
        runningContainers: runningContainers,
        totalContainers: backend.containerNames.length,
        // A container can be up while the app inside is still booting, so
        // "running" and "will accept a trace" are different questions.
        reachable: state === 'running' ? await isReachable(backend.url) : false,
      };
    }),
  );

  return {
    dockerAvailable: true,
    backends: backends,
  };
}

export type ObservabilityStopResult = {
  stopped: string[];
  failed: string[];
};

/**
 * Stops every backend container. `docker stop` rather than `compose down`:
 * volumes survive, so bringing the stack back is seconds rather than another
 * image pull.
 */
export async function stopObservabilityStack(): Promise<ObservabilityStopResult> {
  const names = getObservabilityBackends().flatMap(
    (backend) => backend.containerNames,
  );
  const stopped: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    names.map(async (name) => {
      try {
        // Constant argv. `name` comes from the table above, never from a request.
        await execFileAsync('docker', ['stop', name], { timeout: 30_000 });
        stopped.push(name);
      } catch {
        // Already stopped or never existed — not worth surfacing as a failure
        // the user has to think about.
        failed.push(name);
      }
    }),
  );

  return {
    stopped: stopped.sort(),
    failed: failed.sort(),
  };
}
