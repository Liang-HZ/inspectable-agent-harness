import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentToolDefinitions } from '../lib/agent-tools';
import { toOpenAIStrictToolInputSchema } from '../lib/openai-tool-schema';

function readProperties(schema: Record<string, unknown>) {
  assert.equal(typeof schema.properties, 'object');
  assert.notEqual(schema.properties, null);
  assert.equal(Array.isArray(schema.properties), false);

  return schema.properties as Record<string, Record<string, unknown>>;
}

function readRequired(schema: Record<string, unknown>) {
  assert.equal(Array.isArray(schema.required), true);

  return schema.required as string[];
}

test('OpenAI strict tool schema marks every property as required', () => {
  for (const toolDefinition of agentToolDefinitions) {
    const strictSchema = toOpenAIStrictToolInputSchema(
      toolDefinition.modelTool.inputSchema,
    );
    const properties = readProperties(strictSchema);
    const required = readRequired(strictSchema);

    assert.equal(strictSchema.additionalProperties, false);
    assert.deepEqual(new Set(required), new Set(Object.keys(properties)));
  }
});

test('OpenAI strict tool schema represents optional properties with null type', () => {
  const readTool = agentToolDefinitions.find(
    (toolDefinition) => toolDefinition.name === 'read',
  );
  if (readTool === undefined) {
    throw new Error('Expected read tool definition to exist.');
  }

  const strictSchema = toOpenAIStrictToolInputSchema(
    readTool.modelTool.inputSchema,
  );
  const properties = readProperties(strictSchema);

  assert.deepEqual(properties.path.type, 'string');
  assert.deepEqual(properties.offset.type, ['number', 'null']);
  assert.deepEqual(properties.limit.type, ['number', 'null']);
  assert.deepEqual(readRequired(strictSchema), ['path', 'offset', 'limit']);
});
