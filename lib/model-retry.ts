// Model calls fail transiently: rate limits (429), provider 5xx, and dropped
// connections are all expected in production and are almost always fixed by
// waiting and retrying. This module owns that policy so the gateway stays a
// thin boundary. It deliberately does NOT retry client errors (400/401/403):
// a malformed request or a bad key will fail identically no matter how many
// times it runs, so retrying only delays a clear failure.

export type ModelRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

export function isRetryableModelError(error: unknown): boolean {
  // Never retry an aborted run: the caller cancelled on purpose.
  if (isAbortError(error)) {
    return false;
  }

  const status = readErrorStatus(error);

  if (status !== undefined) {
    return RETRYABLE_STATUS_CODES.has(status);
  }

  // No HTTP status usually means a transport-level failure (connection reset,
  // DNS blip, socket hang up) rather than a rejected request.
  return isLikelyNetworkError(error);
}

export function computeRetryDelayMs(
  attempt: number,
  policy: ModelRetryPolicy,
): number {
  // Exponential backoff with full jitter: attempt 1 waits ~baseDelay,
  // attempt 2 ~2x, and so on, each randomized in [0, cap] to avoid a
  // thundering herd of synchronized retries.
  const exponentialCap = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );

  return Math.round(Math.random() * exponentialCap);
}

export async function runWithModelRetry<T>(
  operation: () => Promise<T>,
  policy: ModelRetryPolicy,
  hooks: {
    signal?: AbortSignal;
    onRetry?: (info: {
      attempt: number;
      delayMs: number;
      error: unknown;
    }) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === policy.maxAttempts;

      if (isLastAttempt || !isRetryableModelError(error)) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt, policy);
      hooks.onRetry?.({ attempt: attempt, delayMs: delayMs, error: error });
      await sleep(delayMs, hooks.signal);
    }
  }

  throw lastError;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return true;
    }

    if (error.message === 'Agent run aborted.') {
      return true;
    }
  }

  return false;
}

function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  // The OpenAI SDK surfaces the HTTP status on `.status`; some transports use
  // `.statusCode`.
  const record = error as Record<string, unknown>;

  if (typeof record.status === 'number') {
    return record.status;
  }

  if (typeof record.statusCode === 'number') {
    return record.statusCode;
  }

  return undefined;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;

  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  // The OpenAI SDK wraps transport failures as APIConnectionError.
  return record.name === 'APIConnectionError';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Agent run aborted.'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Agent run aborted.'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
