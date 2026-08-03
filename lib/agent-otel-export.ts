import type { AgentEvent } from './agent-events';
import {
  listSubagentSessionSummaries,
  readAgentSessionRecords,
  type AgentSessionRecord,
} from './agent-session-store';
import type { AgentSpanContext, AgentSpanTiming } from './agent-trace';
import {
  encodeOtlpTraceRequest,
  type OtlpAttributeInput,
} from './agent-otlp-protobuf';

/**
 * Exports a persisted agent run to any OTLP/HTTP backend.
 *
 * Two decisions are load-bearing here.
 *
 * *This module reads the session files; it is not a second writer.* The JSONL
 * under `data/agent-sessions/**` is the source of truth, and the exporter is a
 * pure function of it. That means an export can be re-run, re-pointed at a
 * different backend, or skipped entirely without the run behaving differently —
 * and it means turning tracing off cannot lose data that was only ever in
 * flight to a vendor.
 *
 * *No OpenTelemetry SDK.* OTLP/HTTP with a JSON body is an HTTP POST with a
 * documented schema, and `fetch` is in the runtime already. Pulling in
 * `@opentelemetry/{api,sdk-trace-node,exporter-trace-otlp-http}` would add a
 * dependency tree and a global tracer-provider singleton to a codebase whose
 * whole claim is that you can read it. The ids are already OTel-shaped
 * (`lib/agent-trace.ts`), so the mapping below is the entire integration.
 */

/**
 * Which OTLP encoding to send.
 *
 * Defaults to protobuf because it is the only one every backend accepts:
 * Langfuse takes either, Phoenix rejects JSON outright with a 415. JSON stays
 * available because it is far easier to eyeball when an export goes wrong.
 */
export type OtlpEncoding = 'protobuf' | 'json';

export type OtlpExportTarget = {
  /** e.g. `http://localhost:6006/v1/traces` (Phoenix) */
  endpoint: string;
  /** Extra headers, e.g. Basic auth for Langfuse Cloud. */
  headers?: Record<string, string>;
  serviceName?: string;
  encoding?: OtlpEncoding;
};

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: number;
  startedAt: string;
  endedAt: string;
  attributes: OtlpAttributeInput[];
  statusCode: number;
};

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

function stringAttribute(key: string, value: string): OtlpAttributeInput {
  return { key: key, stringValue: value };
}

function intAttribute(key: string, value: number): OtlpAttributeInput {
  return { key: key, intValue: Math.trunc(value) };
}

const NANOS_PER_MILLISECOND = BigInt(1_000_000);

function toUnixNano(isoTimestamp: string): bigint {
  return BigInt(new Date(isoTimestamp).getTime()) * NANOS_PER_MILLISECOND;
}

/**
 * Truncates a value before it leaves the machine. Prompts and tool output can
 * be megabytes; a trace backend is for shapes and timings, not for archival —
 * the untruncated copy stays in the session file.
 */
const MAX_ATTRIBUTE_CHARS = 8_000;

function truncatedAttribute(key: string, value: string): OtlpAttributeInput {
  return stringAttribute(
    key,
    value.length > MAX_ATTRIBUTE_CHARS
      ? `${value.slice(0, MAX_ATTRIBUTE_CHARS)}… [truncated ${value.length - MAX_ATTRIBUTE_CHARS} chars]`
      : value,
  );
}

type PendingSpan = {
  span: AgentSpanContext;
  name: string;
  startedAt: string;
  attributes: OtlpAttributeInput[];
};

/**
 * Attribute sets from two vocabularies are emitted side by side on purpose:
 * OpenTelemetry's `gen_ai.*` semantic conventions, which Langfuse reads, and
 * OpenInference's `openinference.*` / `llm.*`, which Phoenix renders natively.
 * They do not collide, and emitting both is what lets the same run be pointed
 * at either backend without a code change.
 */
function llmAttributes(model: string): OtlpAttributeInput[] {
  return [
    stringAttribute('gen_ai.system', 'openai'),
    stringAttribute('gen_ai.operation.name', 'chat'),
    stringAttribute('gen_ai.request.model', model),
    stringAttribute('openinference.span.kind', 'LLM'),
    stringAttribute('llm.model_name', model),
  ];
}

function eventSpanContext(event: AgentEvent): AgentSpanContext | undefined {
  return 'span' in event ? event.span : undefined;
}

function eventTiming(event: AgentEvent): AgentSpanTiming | undefined {
  return 'timing' in event ? event.timing : undefined;
}

function buildSpansFromRecords(
  records: AgentSessionRecord[],
  spans: OtlpSpan[],
): void {
  const pending = new Map<string, PendingSpan>();
  /** The run's root span, remembered so its terminal events can close it. */
  let runSpan: AgentSpanContext | undefined;

  function openSpan(
    span: AgentSpanContext,
    name: string,
    startedAt: string,
    attributes: OtlpAttributeInput[],
  ): void {
    pending.set(span.spanId, {
      span: span,
      name: name,
      startedAt: startedAt,
      attributes: attributes,
    });
  }

  function closeSpan(
    span: AgentSpanContext,
    timing: AgentSpanTiming,
    extraAttributes: OtlpAttributeInput[],
    isError: boolean,
    fallbackName: string,
  ): void {
    const open = pending.get(span.spanId);
    pending.delete(span.spanId);

    spans.push({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: open?.name ?? fallbackName,
      kind: SPAN_KIND_INTERNAL,
      startedAt: open?.startedAt ?? timing.startedAt,
      endedAt: timing.endedAt,
      attributes: [...(open?.attributes ?? []), ...extraAttributes],
      statusCode: isError ? STATUS_ERROR : STATUS_UNSET,
    });
  }

  for (const record of records) {
    if (record.type !== 'agent_event') {
      continue;
    }

    const event = record.payload;

    // A run's terminal events carry no span of their own — `run_succeeded`,
    // `run_failed` and `run_cancelled` describe the run, not a new unit of
    // work. Resolving them against the root span remembered from `run_started`
    // is what lets them close it. Reading `event.span` here instead would
    // silently skip all three, and every run — including successful ones —
    // would reach the leftover sweep below and be exported as an unterminated
    // error.
    const isRunTerminalEvent =
      event.type === 'run_succeeded' ||
      event.type === 'run_failed' ||
      event.type === 'run_cancelled';
    const span = isRunTerminalEvent ? runSpan : eventSpanContext(event);

    // Sessions recorded before tracing existed carry no spans; there is nothing
    // to export for them, and that is not an error.
    if (span === undefined) {
      continue;
    }

    if (event.type === 'run_started') {
      runSpan = span;
      const isSubagent = (event.spawnDepth ?? 0) > 0;
      openSpan(
        span,
        isSubagent ? 'subagent' : 'agent run',
        event.startedAt ?? record.timestamp,
        [
          stringAttribute(
            'openinference.span.kind',
            isSubagent ? 'AGENT' : 'CHAIN',
          ),
          stringAttribute('agent.run_id', event.runId),
          stringAttribute('agent.session_id', event.sessionId),
          intAttribute('agent.spawn_depth', event.spawnDepth ?? 0),
        ],
      );
      continue;
    }

    if (event.type === 'model_requested') {
      openSpan(
        span,
        `chat ${event.model}`,
        event.startedAt ?? record.timestamp,
        [
          ...llmAttributes(event.model),
          intAttribute('agent.round', event.round),
          truncatedAttribute(
            'input.value',
            JSON.stringify(event.request.messages),
          ),
        ],
      );
      continue;
    }

    if (event.type === 'model_completed') {
      const timing = eventTiming(event);
      if (timing === undefined) {
        continue;
      }

      const tokenUsage = event.usage.tokenUsage;
      closeSpan(
        span,
        timing,
        [
          truncatedAttribute('output.value', event.streamedAssistantText),
          ...(tokenUsage === null
            ? []
            : [
                intAttribute(
                  'gen_ai.usage.input_tokens',
                  tokenUsage.inputTokens,
                ),
                intAttribute(
                  'gen_ai.usage.output_tokens',
                  tokenUsage.outputTokens,
                ),
                intAttribute(
                  'llm.token_count.prompt',
                  tokenUsage.inputTokens,
                ),
                intAttribute(
                  'llm.token_count.completion',
                  tokenUsage.outputTokens,
                ),
                intAttribute('llm.token_count.total', tokenUsage.totalTokens),
              ]),
        ],
        false,
        `chat ${event.model}`,
      );
      continue;
    }

    if (event.type === 'tool_started') {
      openSpan(span, event.toolName, event.startedAt ?? record.timestamp, [
        stringAttribute('openinference.span.kind', 'TOOL'),
        stringAttribute('tool.name', event.toolName),
        stringAttribute('gen_ai.tool.name', event.toolName),
        truncatedAttribute('input.value', event.argumentsJson),
      ]);
      continue;
    }

    if (event.type === 'tool_finished') {
      const timing = eventTiming(event);
      if (timing === undefined) {
        continue;
      }

      closeSpan(
        span,
        timing,
        [
          stringAttribute('openinference.span.kind', 'TOOL'),
          stringAttribute('tool.name', event.toolName),
          truncatedAttribute('output.value', event.modelOutput),
          ...(event.subagentSessionId === undefined
            ? []
            : [
                stringAttribute(
                  'agent.subagent_session_id',
                  event.subagentSessionId,
                ),
              ]),
        ],
        event.isError,
        event.toolName,
      );
      continue;
    }

    if (
      event.type === 'run_succeeded' ||
      event.type === 'run_failed' ||
      event.type === 'run_cancelled'
    ) {
      const open = pending.get(span.spanId);
      if (open === undefined) {
        continue;
      }

      // `run_cancelled` has to be handled here with the other two. It is a
      // terminal event like they are, and letting it fall through to the
      // leftover-spans sweep below would label a deliberate cancellation
      // `agent.span_unterminated` — which is supposed to mean "we never found
      // out what happened to this". "Stopped on purpose" and "vanished" are
      // different facts, and telling them apart is most of why a trace is worth
      // reading.
      const closingAttributes =
        event.type === 'run_failed'
          ? [truncatedAttribute('error.message', event.error)]
          : event.type === 'run_cancelled'
            ? [
                truncatedAttribute('agent.cancel_reason', event.reason),
                stringAttribute('agent.run_cancelled', 'true'),
              ]
            : [truncatedAttribute('output.value', event.result.answer)];

      closeSpan(
        span,
        {
          startedAt: open.startedAt,
          endedAt: record.timestamp,
          durationMs:
            new Date(record.timestamp).getTime() -
            new Date(open.startedAt).getTime(),
        },
        closingAttributes,
        event.type !== 'run_succeeded',
        'agent run',
      );
    }
  }

  // A run that was cancelled or crashed leaves spans open. Emitting them with
  // the last timestamp we saw is strictly better than dropping them: "this tool
  // call never returned" is exactly what someone reading a trace is looking for.
  const lastTimestamp = records[records.length - 1]?.timestamp;
  for (const open of pending.values()) {
    spans.push({
      traceId: open.span.traceId,
      spanId: open.span.spanId,
      parentSpanId: open.span.parentSpanId,
      name: open.name,
      kind: SPAN_KIND_INTERNAL,
      startedAt: open.startedAt,
      endedAt: lastTimestamp ?? open.startedAt,
      attributes: [
        ...open.attributes,
        stringAttribute('agent.span_unterminated', 'true'),
      ],
      statusCode: STATUS_ERROR,
    });
  }
}

/**
 * Collects every span of a run, including the runs its `task` calls derived.
 * Subagents live in their own files but share the parent's trace id, so they
 * reassemble into one waterfall on the backend without any stitching there.
 */
export function buildSpansForSession(sessionPath: string): OtlpSpan[] {
  const spans: OtlpSpan[] = [];

  buildSpansFromRecords(readAgentSessionRecords(sessionPath), spans);

  for (const child of listSubagentSessionSummaries(sessionPath)) {
    buildSpansFromRecords(readAgentSessionRecords(child.path), spans);
  }

  return spans;
}

const SCOPE_NAME = 'inspectable-agent-harness';

function attributeToJson(attribute: OtlpAttributeInput): unknown {
  if ('stringValue' in attribute) {
    return { key: attribute.key, value: { stringValue: attribute.stringValue } };
  }

  if ('boolValue' in attribute) {
    return { key: attribute.key, value: { boolValue: attribute.boolValue } };
  }

  // OTLP/JSON carries 64-bit integers as strings; a bare number is silently
  // truncated by some collectors.
  return {
    key: attribute.key,
    value: { intValue: String(attribute.intValue) },
  };
}

export function buildOtlpJsonPayload(
  spans: OtlpSpan[],
  serviceName: string,
): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attributeToJson(stringAttribute('service.name', serviceName)),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId === undefined
                ? {}
                : { parentSpanId: span.parentSpanId }),
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: String(toUnixNano(span.startedAt)),
              endTimeUnixNano: String(toUnixNano(span.endedAt)),
              attributes: span.attributes.map(attributeToJson),
              status: { code: span.statusCode },
            })),
          },
        ],
      },
    ],
  };
}

export function buildOtlpProtobufPayload(
  spans: OtlpSpan[],
  serviceName: string,
): Uint8Array<ArrayBuffer> {
  // Copied into a freshly allocated ArrayBuffer rather than returned as-is:
  // `fetch`'s BodyInit wants `ArrayBufferView<ArrayBuffer>`, and both Buffer
  // and `new Uint8Array(buffer)` are typed over the wider `ArrayBufferLike`.
  const encoded = encodeOtlpTraceRequest(
    spans.map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: toUnixNano(span.startedAt),
      endTimeUnixNano: toUnixNano(span.endedAt),
      attributes: span.attributes,
      statusCode: span.statusCode,
    })),
    [stringAttribute('service.name', serviceName)],
    SCOPE_NAME,
  );
  const payload = new Uint8Array(new ArrayBuffer(encoded.length));
  payload.set(encoded);

  return payload;
}

export type OtlpExportResult = {
  ok: boolean;
  spanCount: number;
  status: number | undefined;
  error: string | undefined;
};

export async function exportAgentSessionToOtlp(
  sessionPath: string,
  target: OtlpExportTarget,
): Promise<OtlpExportResult> {
  const spans = buildSpansForSession(sessionPath);

  if (spans.length === 0) {
    return {
      ok: true,
      spanCount: 0,
      status: undefined,
      error: undefined,
    };
  }

  const serviceName = target.serviceName ?? SCOPE_NAME;
  const encoding = target.encoding ?? 'protobuf';
  const body =
    encoding === 'json'
      ? JSON.stringify(buildOtlpJsonPayload(spans, serviceName))
      : buildOtlpProtobufPayload(spans, serviceName);

  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        'content-type':
          encoding === 'json' ? 'application/json' : 'application/x-protobuf',
        ...target.headers,
      },
      body: body,
    });

    return {
      ok: response.ok,
      spanCount: spans.length,
      status: response.status,
      error: response.ok ? undefined : await response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      spanCount: spans.length,
      status: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
