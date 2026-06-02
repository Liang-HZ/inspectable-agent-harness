import assert from 'node:assert/strict';
import { test } from 'node:test';

import nextConfig from '../next.config';

test('agent routes exclude next config from output file tracing', () => {
  assert.deepEqual(nextConfig.outputFileTracingExcludes?.['/api/agent'], [
    './next.config.ts',
  ]);
  assert.deepEqual(
    nextConfig.outputFileTracingExcludes?.['/api/agent/stream'],
    ['./next.config.ts'],
  );
});
