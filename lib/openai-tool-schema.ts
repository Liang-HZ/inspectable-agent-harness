type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRequiredPropertyNames(schema: JsonObject): Set<string> {
  if (!Array.isArray(schema.required)) {
    return new Set();
  }

  return new Set(
    schema.required.filter((propertyName) => typeof propertyName === 'string'),
  );
}

function addNullType(schema: unknown): unknown {
  if (!isJsonObject(schema)) {
    return schema;
  }

  const type = schema.type;

  if (Array.isArray(type)) {
    if (type.includes('null')) {
      return schema;
    }

    return {
      ...schema,
      type: [...type, 'null'],
    };
  }

  if (typeof type === 'string') {
    if (type === 'null') {
      return schema;
    }

    return {
      ...schema,
      type: [type, 'null'],
    };
  }

  return {
    anyOf: [schema, { type: 'null' }],
  };
}

function normalizeSchemaValueForOpenAIStrictMode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaValueForOpenAIStrictMode(item));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const properties = isJsonObject(value.properties)
    ? value.properties
    : undefined;

  const normalizedSchema: JsonObject = {
    ...value,
  };

  if (isJsonObject(value.items)) {
    normalizedSchema.items = normalizeSchemaValueForOpenAIStrictMode(
      value.items,
    );
  }

  if (Array.isArray(value.anyOf)) {
    normalizedSchema.anyOf = value.anyOf.map((item) =>
      normalizeSchemaValueForOpenAIStrictMode(item),
    );
  }

  if (Array.isArray(value.oneOf)) {
    normalizedSchema.oneOf = value.oneOf.map((item) =>
      normalizeSchemaValueForOpenAIStrictMode(item),
    );
  }

  if (properties === undefined) {
    return normalizedSchema;
  }

  const originallyRequired = getRequiredPropertyNames(value);
  const normalizedProperties: JsonObject = {};

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const normalizedProperty =
      normalizeSchemaValueForOpenAIStrictMode(propertySchema);
    normalizedProperties[propertyName] = originallyRequired.has(propertyName)
      ? normalizedProperty
      : addNullType(normalizedProperty);
  }

  return {
    ...normalizedSchema,
    additionalProperties: false,
    properties: normalizedProperties,
    required: Object.keys(normalizedProperties),
  };
}

export function toOpenAIStrictToolInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeSchemaValueForOpenAIStrictMode(schema);

  if (!isJsonObject(normalized)) {
    throw new Error('OpenAI tool input schema must be a JSON object.');
  }

  return normalized;
}
