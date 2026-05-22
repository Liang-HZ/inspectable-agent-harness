import {
  chatApiResponseSchema,
  type ChatApiResponse,
  type ChatRequestBody,
} from './chat-api-types';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

function parseChatApiResponse(data: unknown): ChatApiResponse {
  const parsedResponse = chatApiResponseSchema.safeParse(data);
  if (!parsedResponse.success) {
    return {
      ok: false,
      error: 'API returned an unexpected response shape.',
    };
  }

  return parsedResponse.data;
}

export async function requestChatCompletion(
  body: ChatRequestBody,
): Promise<ChatApiResponse> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: body.message,
        model: body.model,
        temperature: body.temperature,
      }),
    });

    return parseChatApiResponse(await response.json());
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}
