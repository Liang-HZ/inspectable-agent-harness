import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeRetryDelayMs,
  DEFAULT_MODEL_RETRY_POLICY,
  isRetryableModelError,
  runWithModelRetry,
} from '../lib/model-retry';

const noSleep = async () => {};

test('classifies retryable vs terminal errors', () => {
  assert.equal(isRetryableModelError({ status: 429 }), true);
  assert.equal(isRetryableModelError({ status: 503 }), true);
  assert.equal(isRetryableModelError({ statusCode: 502 }), true);
  assert.equal(isRetryableModelError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableModelError({ name: 'APIConnectionError' }), true);

  // Client errors and success-adjacent codes are terminal.
  assert.equal(isRetryableModelError({ status: 400 }), false);
  assert.equal(isRetryableModelError({ status: 401 }), false);
  assert.equal(isRetryableModelError({ status: 404 }), false);

  // A deliberate abort must never be retried.
  const abortError = new Error('Agent run aborted.');
  assert.equal(isRetryableModelError(abortError), false);
  const namedAbort = new Error('stop');
  namedAbort.name = 'AbortError';
  assert.equal(isRetryableModelError(namedAbort), false);
});

test('backoff grows exponentially and stays within the cap', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8_000 };
  const originalRandom = Math.random;
  Math.random = () => 1; // full jitter → returns the cap itself

  try {
    assert.equal(computeRetryDelayMs(1, policy), 500);
    assert.equal(computeRetryDelayMs(2, policy), 1_000);
    assert.equal(computeRetryDelayMs(3, policy), 2_000);
    assert.equal(computeRetryDelayMs(4, policy), 4_000);
    assert.equal(computeRetryDelayMs(5, policy), 8_000);
    assert.equal(computeRetryDelayMs(6, policy), 8_000); // clamped
  } finally {
    Math.random = originalRandom;
  }
});

test('retries a transient failure then succeeds', async () => {
  let attempts = 0;
  const retries: number[] = [];

  const result = await runWithModelRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw { status: 503 };
      }
      return 'ok';
    },
    DEFAULT_MODEL_RETRY_POLICY,
    { sleep: noSleep, onRetry: ({ attempt }) => retries.push(attempt) },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [1, 2]);
});

test('does not retry a terminal error', async () => {
  let attempts = 0;

  await assert.rejects(
    runWithModelRetry(
      async () => {
        attempts += 1;
        throw { status: 400, message: 'bad request' };
      },
      DEFAULT_MODEL_RETRY_POLICY,
      { sleep: noSleep },
    ),
  );

  assert.equal(attempts, 1);
});

test('gives up after maxAttempts and throws the last error', async () => {
  let attempts = 0;

  await assert.rejects(
    runWithModelRetry(
      async () => {
        attempts += 1;
        throw { status: 500, message: `fail-${attempts}` };
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      { sleep: noSleep },
    ),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { message?: string }).message === 'fail-3',
  );

  assert.equal(attempts, 3);
});
