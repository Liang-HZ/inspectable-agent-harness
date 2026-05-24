import {
  agentApiResponseSchema,
  type AgentApiResponse,
  type AgentRequestBody,
  type AgentStreamEvent,
} from './agent-api-types';

type AgentStreamCallbacks = {
  onStep: (event: Extract<AgentStreamEvent, { type: 'step' }>) => void;
  onAnswerDelta: (
    event: Extract<AgentStreamEvent, { type: 'answerDelta' }>,
  ) => void;
  onDone: (event: Extract<AgentStreamEvent, { type: 'done' }>) => void;
  onError: (event: Extract<AgentStreamEvent, { type: 'error' }>) => void;
};

type AgentStreamRequestOptions = {
  signal?: AbortSignal;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

function parseAgentApiResponse(data: unknown): AgentApiResponse {
  const parsedResponse = agentApiResponseSchema.safeParse(data);
  if (!parsedResponse.success) {
    return {
      ok: false,
      error: 'API returned an unexpected response shape.',
    };
  }

  return parsedResponse.data;
}

export async function requestAgentRun(
  body: AgentRequestBody,
): Promise<AgentApiResponse> {
  try {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        task: body.task,
        goal: body.goal,
        context: body.context,
        model: body.model,
        temperature: body.temperature,
      }),
    });

    return parseAgentApiResponse(await response.json());
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

function readAgentStreamEvent(data: unknown): AgentStreamEvent | undefined {
  if (typeof data !== 'object' || data === null || !('type' in data)) {
    return undefined;
  }

  const event = data as AgentStreamEvent;
  if (
    event.type === 'step' ||
    event.type === 'answerDelta' ||
    event.type === 'done' ||
    event.type === 'error'
  ) {
    return event;
  }

  return undefined;
}

function dispatchAgentStreamEvent(
  event: AgentStreamEvent,
  callbacks: AgentStreamCallbacks,
): void {
  switch (event.type) {
    case 'step':
      callbacks.onStep(event);
      return;

    case 'answerDelta':
      callbacks.onAnswerDelta(event);
      return;

    case 'done':
      callbacks.onDone(event);
      return;

    case 'error':
      callbacks.onError(event);
      return;
  }
}

function parseSseMessage(message: string): unknown {
  const dataLines = message
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));

  if (dataLines.length === 0) {
    return undefined;
  }

  return JSON.parse(dataLines.join('\n'));
}

export async function requestAgentRunStream(
  body: AgentRequestBody,
  callbacks: AgentStreamCallbacks,
  options: AgentStreamRequestOptions = {},
): Promise<void> {
  const response = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: options.signal,
    body: JSON.stringify({
      task: body.task,
      goal: body.goal,
      context: body.context,
      model: body.model,
      temperature: body.temperature,
    }),
  });

  if (!response.ok || response.body === null) {
    if (options.signal?.aborted) {
      return;
    }

    callbacks.onError({
      type: 'error',
      error: 'Streaming request failed.',
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const readResult = await reader.read();
    if (options.signal?.aborted) {
      return;
    }

    if (readResult.done) {
      break;
    }

    buffer += decoder.decode(readResult.value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';

    for (const message of messages) {
      const parsedMessage = parseSseMessage(message);
      const event = readAgentStreamEvent(parsedMessage);
      if (event !== undefined) {
        dispatchAgentStreamEvent(event, callbacks);
      }
    }
  }

  if (buffer.trim() !== '') {
    const parsedMessage = parseSseMessage(buffer);
    const event = readAgentStreamEvent(parsedMessage);
    if (event !== undefined) {
      dispatchAgentStreamEvent(event, callbacks);
    }
  }
}
