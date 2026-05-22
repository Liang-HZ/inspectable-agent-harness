import {
  agentApiResponseSchema,
  type AgentApiResponse,
  type AgentRequestBody,
} from './agent-api-types';

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
