import { randomBytes } from 'crypto';

/**
 * Span identity for the agent runtime.
 *
 * The harness owns its own trace data — `data/agent-sessions/**` is the single
 * source of truth, and nothing here talks to an observability vendor. But the
 * *shape* of an id is a cheap decision with an expensive lock-in if you get it
 * wrong, so these ids are OpenTelemetry-shaped from the start: a trace id is 16
 * random bytes, a span id is 8, both lowercase hex. That is exactly what OTLP
 * expects on the wire, so exporting a run to any OTLP backend later is a field
 * rename, not an id-space migration.
 *
 * Timestamps stay ISO-8601 strings rather than OTel's Unix nanoseconds: the
 * JSONL is meant to be read by a human with `less`, and the conversion at export
 * time is one multiplication.
 */

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

/**
 * What a span represents. `run` is the root of one agent run; `model` is one
 * sampling round; `tool` is one tool call; `subagent` is the root of a derived
 * run, which lives in its own session file but hangs off the parent's `task`
 * tool span.
 */
export type AgentSpanKind = 'run' | 'model' | 'tool' | 'subagent';

export type AgentSpanContext = {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
};

export type AgentSpanTiming = {
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export function createTraceId(): string {
  return randomBytes(TRACE_ID_BYTES).toString('hex');
}

export function createSpanId(): string {
  return randomBytes(SPAN_ID_BYTES).toString('hex');
}

/**
 * Starts a new trace. Used once per agent run that is not derived from another
 * run; a subagent joins its parent's trace instead via `createChildSpanContext`.
 */
export function createRootSpanContext(): AgentSpanContext {
  return {
    traceId: createTraceId(),
    spanId: createSpanId(),
    parentSpanId: undefined,
  };
}

/**
 * Creates a span inside `parent`. The trace id is inherited, which is what keeps
 * a subagent's spans in the same waterfall as the run that spawned it even
 * though they are persisted to a different file.
 */
export function createChildSpanContext(
  parent: AgentSpanContext,
): AgentSpanContext {
  return {
    traceId: parent.traceId,
    spanId: createSpanId(),
    parentSpanId: parent.spanId,
  };
}

export function createSpanTiming(
  startedAtMs: number,
  endedAtMs: number,
): AgentSpanTiming {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
  };
}
