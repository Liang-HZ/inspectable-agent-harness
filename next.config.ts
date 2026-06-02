import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    '/api/agent': ['./next.config.ts'],
    '/api/agent/stream': ['./next.config.ts'],
  },
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
