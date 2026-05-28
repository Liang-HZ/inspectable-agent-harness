export type AgentToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'EXECUTION_ERROR';

export type AgentToolError = {
  code: AgentToolErrorCode;
  message: string;
};

export type AgentToolOutput =
  | {
      type: 'success';
      contentText: string;
      details?: unknown;
      notice?: string;
      truncated?: boolean;
    }
  | {
      type: 'respond_to_model';
      error: AgentToolError;
      details?: unknown;
    }
  | {
      type: 'fatal';
      error: AgentToolError;
      details?: unknown;
    };

export class AgentToolRespondToModelError extends Error {
  readonly code: AgentToolErrorCode;
  readonly details: unknown;

  constructor(code: AgentToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentToolRespondToModelError';
    this.code = code;
    this.details = details;
  }
}

export class AgentToolFatalError extends Error {
  readonly code: AgentToolErrorCode;
  readonly details: unknown;

  constructor(code: AgentToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentToolFatalError';
    this.code = code;
    this.details = details;
  }
}

export function createSuccessToolOutput(input: {
  contentText: string;
  details?: unknown;
  notice?: string | null;
  truncated?: boolean;
}): AgentToolOutput {
  return {
    type: 'success',
    contentText: input.contentText,
    details: input.details,
    notice:
      input.notice === undefined || input.notice === null
        ? undefined
        : input.notice,
    truncated: input.truncated,
  };
}

export function createRespondToModelToolOutput(
  code: AgentToolErrorCode,
  message: string,
  details?: unknown,
): AgentToolOutput {
  return {
    type: 'respond_to_model',
    error: {
      code: code,
      message: message,
    },
    details: details,
  };
}

export function serializeAgentToolOutputForModel(
  output: AgentToolOutput,
): string {
  if (output.type === 'success') {
    if (output.notice === undefined || output.notice === '') {
      return output.contentText;
    }

    return `${output.contentText}\n\n[${output.notice}]`;
  }

  return `Error [${output.error.code}]: ${output.error.message}`;
}

export function createToolOutputFromThrownError(
  error: unknown,
): AgentToolOutput {
  if (error instanceof AgentToolRespondToModelError) {
    return createRespondToModelToolOutput(
      error.code,
      error.message,
      error.details,
    );
  }

  if (error instanceof AgentToolFatalError) {
    return {
      type: 'fatal',
      error: {
        code: error.code,
        message: error.message,
      },
      details: error.details,
    };
  }

  return createRespondToModelToolOutput(
    'EXECUTION_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}
