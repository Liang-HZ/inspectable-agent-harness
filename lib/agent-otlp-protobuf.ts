/**
 * A protobuf encoder for exactly the slice of OTLP/Traces this harness emits.
 *
 * Why hand-rolled: OTLP over HTTP has two encodings, and backends disagree
 * about which they accept. Langfuse takes JSON or protobuf; Arize Phoenix
 * answers `415 Unsupported content type: application/json` and takes protobuf
 * only. Supporting protobuf is therefore the difference between "works with the
 * backend I happened to pick" and "works with any OTLP backend".
 *
 * The alternative was a protobuf runtime plus generated OTLP stubs — a
 * dependency tree considerably larger than this file, in a project whose whole
 * claim is that you can read it. Protobuf's wire format is small enough to
 * write out: a field is a varint tag of `(fieldNumber << 3) | wireType`
 * followed by the value, and only four wire types appear below.
 *
 * Schema reference: opentelemetry/proto/trace/v1/trace.proto and
 * opentelemetry/proto/common/v1/common.proto.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;

  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;

    if (remaining > 0) {
      byte |= 0x80;
    }

    bytes.push(byte);
  } while (remaining > 0);

  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(payload.length),
    payload,
  ]);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(value, 'utf8'));
}

function encodeBytesField(fieldNumber: number, value: Buffer): Buffer {
  return encodeLengthDelimited(fieldNumber, value);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WIRE_VARINT),
    encodeVarint(value),
  ]);
}

/** Timestamps are `fixed64` in the OTLP schema, not varint. */
function encodeFixed64Field(fieldNumber: number, value: bigint): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64LE(value);

  return Buffer.concat([encodeTag(fieldNumber, WIRE_FIXED64), payload]);
}

// Written as `BigInt(...)` rather than `0n` literals: the project targets
// ES2017, where BigInt literals are a syntax error.
const BIG_ZERO = BigInt(0);
const BIG_SEVEN = BigInt(7);
const BIG_LOW_SEVEN_BITS = BigInt(0x7f);

/** int64 in a varint field, which is how AnyValue carries integers. */
function encodeInt64Field(fieldNumber: number, value: bigint): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt.asUintN(64, value);

  do {
    let byte = Number(remaining & BIG_LOW_SEVEN_BITS);
    remaining >>= BIG_SEVEN;

    if (remaining > BIG_ZERO) {
      byte |= 0x80;
    }

    bytes.push(byte);
  } while (remaining > BIG_ZERO);

  return Buffer.concat([
    encodeTag(fieldNumber, WIRE_VARINT),
    Buffer.from(bytes),
  ]);
}

export type OtlpAttributeInput =
  | { key: string; stringValue: string }
  | { key: string; intValue: number }
  | { key: string; boolValue: boolean };

/** common.v1.AnyValue */
function encodeAnyValue(attribute: OtlpAttributeInput): Buffer {
  if ('stringValue' in attribute) {
    return encodeStringField(1, attribute.stringValue);
  }

  if ('boolValue' in attribute) {
    return encodeVarintField(2, attribute.boolValue ? 1 : 0);
  }

  return encodeInt64Field(3, BigInt(Math.trunc(attribute.intValue)));
}

/** common.v1.KeyValue */
function encodeKeyValue(attribute: OtlpAttributeInput): Buffer {
  return Buffer.concat([
    encodeStringField(1, attribute.key),
    encodeLengthDelimited(2, encodeAnyValue(attribute)),
  ]);
}

export type OtlpProtoSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: OtlpAttributeInput[];
  statusCode: number;
};

/** trace.v1.Span */
function encodeSpan(span: OtlpProtoSpan): Buffer {
  const parts: Buffer[] = [
    // trace_id and span_id are raw bytes on the wire, not the hex text used in
    // the JSON encoding — a frequent source of silently-dropped spans.
    encodeBytesField(1, Buffer.from(span.traceId, 'hex')),
    encodeBytesField(2, Buffer.from(span.spanId, 'hex')),
  ];

  if (span.parentSpanId !== undefined) {
    parts.push(encodeBytesField(4, Buffer.from(span.parentSpanId, 'hex')));
  }

  parts.push(
    encodeStringField(5, span.name),
    encodeVarintField(6, span.kind),
    encodeFixed64Field(7, span.startTimeUnixNano),
    encodeFixed64Field(8, span.endTimeUnixNano),
  );

  for (const attribute of span.attributes) {
    parts.push(encodeLengthDelimited(9, encodeKeyValue(attribute)));
  }

  // trace.v1.Status, field 15; status code is field 3 inside it.
  parts.push(encodeLengthDelimited(15, encodeVarintField(3, span.statusCode)));

  return Buffer.concat(parts);
}

/**
 * Encodes a full `ExportTraceServiceRequest`: one ResourceSpans holding one
 * ScopeSpans holding every span of the run.
 */
export function encodeOtlpTraceRequest(
  spans: OtlpProtoSpan[],
  resourceAttributes: OtlpAttributeInput[],
  scopeName: string,
): Buffer {
  const scopeSpans = Buffer.concat([
    // common.v1.InstrumentationScope
    encodeLengthDelimited(1, encodeStringField(1, scopeName)),
    ...spans.map((span) => encodeLengthDelimited(2, encodeSpan(span))),
  ]);

  const resourceSpans = Buffer.concat([
    // resource.v1.Resource
    encodeLengthDelimited(
      1,
      Buffer.concat(
        resourceAttributes.map((attribute) =>
          encodeLengthDelimited(1, encodeKeyValue(attribute)),
        ),
      ),
    ),
    encodeLengthDelimited(2, scopeSpans),
  ]);

  return encodeLengthDelimited(1, resourceSpans);
}
