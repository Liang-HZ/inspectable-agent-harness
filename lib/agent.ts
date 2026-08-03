import { randomUUID } from 'crypto';

import type {
  AgentModelCallUsage,
  AgentDebugStreamEvent,
  AgentResult,
  AgentStep,
  AgentTokenUsage,
} from './agent-api-types';
import type {
  AgentModelAssistantMessage,
  AgentModelRequest,
  AgentModelToolCall,
  AgentModelUsageSnapshot,
} from './agent-model-types';
import {
  applyAgentEvent,
  createAgentRunState,
  type AgentEvent,
} from './agent-events';
import type { AgentInput } from './agent-input';
import {
  assertAgentRunNotAborted,
  createAgentRunContext,
  type AgentRunContext,
  type AgentRunContextInput,
} from './agent-run-context';
import {
  appendAgentResponseItem,
  appendAgentSessionEvent,
  appendAgentTurnContext,
  createAgentSession,
  createSubagentSession,
  resumeAgentSession,
  type AgentSession,
} from './agent-session-store';
import type { AgentSubagentSpawner } from './agent-subagent';
import { logAgentEvent, logAgentInfo, logAgentStep } from './agent-log';
import {
  createChildSpanContext,
  createSpanTiming,
  type AgentSpanContext,
} from './agent-trace';
import { executeAgentToolBatch } from './agent-tool-scheduler';
import { getAgentToolsForRunPolicy } from './agent-tools';
import type { AgentToolExecution, AgentToolExecutionMode } from './agent-tools';
import type { AgentToolBatchExecution } from './agent-tool-scheduler';
import type { ModelConfig } from './env';
import {
  createAgentModelGateway,
  type AgentModelGateway,
} from './model-gateway';
import { AgentToolFatalError } from './agent-tool-output';
import { createAgentModelCallUsage, createAgentUsage } from './agent-usage';
import {
  createCommittedAssistantMessageItems,
  createAssistantResponseItems,
  responseItemsToModelMessages,
  type AgentResponseItem,
} from './agent-response-items';
import {
  applyAgentHistoryCompaction,
  buildCompactionSummaryRequest,
  decideAgentHistoryCompaction,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
} from './agent-compaction';
import {
  buildAgentSystemMessage,
  gatherAgentEnvironmentContext,
} from './agent-environment-context';

type RunAgentStreamCallbacks = {
  onEvent: (event: AgentEvent) => void;
  onDebugEvent: (event: AgentDebugStreamEvent) => void;
};

type SamplingLoopResult = {
  model: string;
  answer: string;
  finalCallUsage: AgentModelCallUsage;
  usedTool: boolean;
};

type SamplingRoundResult = {
  model: string;
  streamedAssistantText: string;
  assistantMessages: AgentModelAssistantMessage[];
  toolCalls: AgentModelToolCall[];
  usage: AgentModelUsageSnapshot;
  sawToolCallDelta: boolean;
};

const AGENT_SYSTEM_MESSAGE =
  'You are an inspectable coding agent. Decide whether the task needs local project exploration. Use ls/find/grep/read for local file exploration: list directories to orient yourself, find file paths before reading, grep for text or symbols, and read exact files with pagination. Use shell for commands the file tools cannot cover, such as git status/log/diff or wc; prefer a single command or simple pipeline, because chaining and redirection require approval. When editing tools are available, read the target file before edit, use edit for precise changes to existing files, and use write only for creating files or complete overwrites. If no tool is needed, answer directly. Keep the final answer practical and use the same language as the user.';
const REPEATED_TOOL_CALL_LIMIT = 3;

type ToolLoopGuardEntry = {
  repeatedCount: number;
  lastModelOutput: string;
};

type ToolLoopGuard = {
  entries: Map<string, ToolLoopGuardEntry>;
};

function buildAgentPrompt(input: AgentInput): string {
  const sections = [
    `Task:\n${input.task}`,
    input.goal === undefined ? undefined : `Goal:\n${input.goal}`,
    input.context === undefined ? undefined : `Context:\n${input.context}`,
  ];

  return sections
    .filter((section): section is string => section !== undefined)
    .join('\n\n');
}

function createAgentRunContextForInput(
  input: AgentInput,
  contextInput: AgentRunContextInput,
): AgentRunContext {
  return createAgentRunContext({
    ...contextInput,
    policy: contextInput.policy ?? {
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
    },
  });
}

function readAssistantAnswer(text: string): string {
  if (text.trim() === '') {
    throw new Error('Model returned an empty agent answer.');
  }

  return text;
}

function createPromptStep(
  input: AgentInput,
  prompt: string,
  order: number,
): AgentStep {
  return {
    order: order,
    title: 'Build prompt',
    detail: 'The agent converted the validated request into a model prompt.',
    output: {
      task: input.task,
      goal: input.goal,
      context: input.context,
      modelOverride: input.model,
      temperature: input.temperature,
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
      prompt: prompt,
    },
  };
}

function createToolStep(
  functionToolCalls: AgentModelToolCall[],
  toolExecutions: AgentToolExecution[],
  executionMode: AgentToolExecutionMode,
  round: number,
  order: number,
): AgentStep {
  const detail =
    functionToolCalls.length === 1
      ? 'The model requested a local tool, so the agent executed it.'
      : executionMode === 'parallel'
        ? 'The model requested independent local tools, so the agent executed the batch in parallel.'
        : 'The model requested local tools, so the agent executed the batch sequentially.';

  return {
    order: order,
    title:
      functionToolCalls.length === 1 ? 'Run local tool' : 'Run local tools',
    detail: detail,
    output: {
      round: round,
      executionMode: executionMode,
      modelToolRequests: functionToolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsJson: toolCall.argumentsJson,
      })),
      toolExecutions: toolExecutions,
    },
  };
}

function createFinalAnswerStep(
  model: string,
  answer: string,
  usage: AgentModelCallUsage,
  order: number,
  usedTool: boolean,
): AgentStep {
  return {
    order: order,
    title: usedTool ? 'Return final answer' : 'Answer directly',
    detail: usedTool
      ? 'The agent used the tool result to produce the final answer.'
      : 'The model decided no local tool was needed.',
    output: {
      model: model,
      answer: answer,
      usage: usage,
    },
  };
}

function createInitialResponseItems(
  prompt: string,
  systemMessage: string = AGENT_SYSTEM_MESSAGE,
): AgentResponseItem[] {
  return [
    {
      type: 'message',
      role: 'system',
      content: systemMessage,
    },
    {
      type: 'message',
      role: 'user',
      content: prompt,
    },
  ];
}

export type AgentSessionInitResult = {
  session: AgentSession;
  history: AgentResponseItem[];
  sessionId: string;
  resumed: boolean;
  newItemsToPersist: AgentResponseItem[];
};

export function initializeAgentSessionForStream(
  input: AgentInput,
  context: AgentRunContext,
  config: ModelConfig,
  prompt: string,
  systemMessage?: string,
): AgentSessionInitResult {
  if (input.sessionId === undefined) {
    const session = createAgentSession({
      id: context.runId,
      cwd: process.cwd(),
      source: 'api_agent_stream',
      modelProvider: 'openai-compatible',
      model: config.model,
      baseURL: config.baseURL,
      wireApi: config.wireApi,
      policy: context.policy,
    });
    const history = createInitialResponseItems(prompt, systemMessage);

    return {
      session: session,
      history: history,
      sessionId: session.id,
      resumed: false,
      newItemsToPersist: history,
    };
  }

  const resumeResult = resumeAgentSession(input.sessionId);

  if (!resumeResult.ok) {
    throw new Error(resumeResult.error);
  }

  const newUserItem: AgentResponseItem = {
    type: 'message',
    role: 'user',
    content: prompt,
  };

  return {
    session: resumeResult.session,
    history: [...resumeResult.history, newUserItem],
    sessionId: resumeResult.session.id,
    resumed: true,
    newItemsToPersist: [...resumeResult.synthesizedItems, newUserItem],
  };
}

function createToolOutputItem(
  execution: AgentToolExecution,
): AgentResponseItem {
  return {
    type: 'function_call_output',
    callId: execution.toolCallId,
    toolName: execution.toolName,
    output: execution.modelOutput,
    isError: execution.isError,
  };
}

function createToolLoopGuard(): ToolLoopGuard {
  return {
    entries: new Map<string, ToolLoopGuardEntry>(),
  };
}

function stableStringifyJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyJsonValue(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedEntries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringifyJsonValue(record[key])}`,
      );

    return `{${sortedEntries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeToolArgumentsForLoopGuard(argumentsJson: string): string {
  const trimmedArguments = argumentsJson.trim();

  try {
    return stableStringifyJsonValue(JSON.parse(trimmedArguments));
  } catch {
    return trimmedArguments;
  }
}

function createToolLoopGuardSignature(toolCall: AgentModelToolCall): string {
  return `${toolCall.name}\n${normalizeToolArgumentsForLoopGuard(
    toolCall.argumentsJson,
  )}`;
}

function detectRepeatedToolCallLoop(
  toolCalls: AgentModelToolCall[],
  toolBatch: AgentToolBatchExecution,
  loopGuard: ToolLoopGuard,
): AgentToolFatalError | undefined {
  const executionsByCallId = new Map<string, AgentToolExecution>(
    toolBatch.toolExecutions.map((execution) => [
      execution.toolCallId,
      execution,
    ]),
  );

  for (const toolCall of toolCalls) {
    const execution = executionsByCallId.get(toolCall.id);

    if (execution === undefined) {
      throw new Error(
        `Tool execution missing for committed tool call: ${toolCall.id}.`,
      );
    }

    const signature = createToolLoopGuardSignature(toolCall);
    const previousEntry = loopGuard.entries.get(signature);
    const repeatedCount =
      previousEntry !== undefined &&
      previousEntry.lastModelOutput === execution.modelOutput
        ? previousEntry.repeatedCount + 1
        : 1;

    loopGuard.entries.set(signature, {
      repeatedCount: repeatedCount,
      lastModelOutput: execution.modelOutput,
    });

    if (repeatedCount > REPEATED_TOOL_CALL_LIMIT) {
      return new AgentToolFatalError(
        'REPEATED_TOOL_CALL',
        `The model requested the same \`${toolCall.name}\` tool call with the same result more than ${REPEATED_TOOL_CALL_LIMIT} times. This looks like a tool-use loop; stop the run and ask the user or change the tool arguments.`,
        {
          toolName: toolCall.name,
          argumentsJson: toolCall.argumentsJson,
          repeatedCount: repeatedCount,
        },
      );
    }
  }

  return undefined;
}

function appendResponseItems(
  history: AgentResponseItem[],
  items: AgentResponseItem[],
  session: AgentSession | undefined,
  onCommitted: ((items: AgentResponseItem[]) => void) | undefined,
): void {
  for (const item of items) {
    history.push(item);

    if (session !== undefined) {
      appendAgentResponseItem(session, item);
    }
  }

  if (items.length > 0) {
    onCommitted?.(items);
  }
}

function appendExistingResponseItemsToSession(
  items: AgentResponseItem[],
  session: AgentSession,
): void {
  for (const item of items) {
    appendAgentResponseItem(session, item);
  }
}

function readCommittedAssistantText(
  messages: AgentModelAssistantMessage[],
): string {
  return messages.map((message) => message.text).join('');
}

function assertNoIncompleteToolCall(roundResult: SamplingRoundResult): void {
  if (roundResult.sawToolCallDelta && roundResult.toolCalls.length === 0) {
    throw new Error(
      'Model streamed tool-call arguments but did not complete a tool call.',
    );
  }
}

function assertCommittedAssistantMessage(
  roundResult: SamplingRoundResult,
): void {
  if (
    roundResult.streamedAssistantText !== '' &&
    roundResult.assistantMessages.length === 0
  ) {
    throw new Error(
      'Model streamed assistant text but did not commit an assistant message.',
    );
  }
}

async function runSamplingRound(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  context: AgentRunContext,
  history: AgentResponseItem[],
  round: number,
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
  modelSpan: AgentSpanContext,
  startedAtMs: number,
): Promise<SamplingRoundResult> {
  const request: AgentModelRequest = {
    messages: responseItemsToModelMessages(history),
    tools: getAgentToolsForRunPolicy({
      policy: context.policy,
      spawnDepth: context.spawnDepth,
      canSpawnSubagents: context.spawnSubagent !== undefined,
    }),
    toolChoice: 'auto',
    temperature: input.temperature,
  };

  emitAgentEvent?.({
    type: 'model_requested',
    round: round,
    model: modelGateway.model,
    wireApi: modelGateway.wireApi,
    request: request,
    span: modelSpan,
    startedAt: new Date(startedAtMs).toISOString(),
  });

  const stream = await modelGateway.streamResponse(request);

  let streamedAssistantText = '';
  let model = modelGateway.model;
  let usage: AgentModelUsageSnapshot = {
    tokenUsage: null,
    rawUsage: null,
  };
  let sawToolCallDelta = false;
  const assistantMessages: AgentModelAssistantMessage[] = [];
  const toolCalls: AgentModelToolCall[] = [];

  for await (const event of stream) {
    assertAgentRunNotAborted(context);

    switch (event.type) {
      case 'completed':
        model = event.model;
        usage = event.usage;
        break;

      case 'assistant_message_done':
        assistantMessages.push(event.message);
        break;

      case 'tool_call_committed':
        toolCalls.push(event.toolCall);
        break;

      case 'tool_call_delta':
        sawToolCallDelta = true;
        break;

      case 'text_delta':
        if (event.delta === '') {
          break;
        }

        streamedAssistantText += event.delta;
        emitAgentEvent?.({
          type: 'assistant_delta',
          delta: event.delta,
        });
        break;
    }
  }

  return {
    model: model,
    streamedAssistantText: streamedAssistantText,
    assistantMessages: assistantMessages,
    toolCalls: toolCalls,
    usage: usage,
    sawToolCallDelta: sawToolCallDelta,
  };
}

async function compactAgentHistoryIfNeeded(
  modelGateway: AgentModelGateway,
  context: AgentRunContext,
  history: AgentResponseItem[],
  tokenUsage: AgentTokenUsage | null,
  session: AgentSession | undefined,
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<void> {
  const decision = decideAgentHistoryCompaction(
    tokenUsage,
    history,
    DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  );

  if (!decision.shouldCompact) {
    return;
  }

  assertAgentRunNotAborted(context);
  const summaryRequest = buildCompactionSummaryRequest(history);
  const summaryResponse = await modelGateway.createResponse(summaryRequest);
  const compaction = applyAgentHistoryCompaction(history, summaryResponse.text);

  history.length = 0;
  history.push(...compaction.history);

  if (session !== undefined) {
    appendAgentResponseItem(session, compaction.summaryItem);
  }

  emitAgentEvent?.({
    type: 'history_compacted',
    reason: decision.reason,
    tokenUsageBeforeCompaction: decision.tokenUsage,
    removedItemCount: compaction.removedItemCount,
    keptItemCount: compaction.keptItemCount,
    summary: summaryResponse.text,
  });
}

export async function runSamplingLoop(
  modelGateway: AgentModelGateway,
  input: AgentInput,
  context: AgentRunContext,
  history: AgentResponseItem[],
  steps: AgentStep[],
  modelCallUsages: AgentModelCallUsage[],
  session: AgentSession | undefined,
  emitAgentEvent: ((event: AgentEvent) => void) | undefined,
  emitDebugEvent: ((event: AgentDebugStreamEvent) => void) | undefined,
): Promise<SamplingLoopResult> {
  let usedTool = false;
  const loopGuard = createToolLoopGuard();
  const emitHistoryCommittedDebugEvent = (items: AgentResponseItem[]) => {
    emitDebugEvent?.({
      type: 'historyCommitted',
      items: items,
    });
  };

  for (let round = 1; ; round += 1) {
    assertAgentRunNotAborted(context);
    emitAgentEvent?.({
      type: 'model_started',
      stage: 'tool_or_answer_selection',
    });

    // One span per sampling round, opened here rather than inside
    // `runSamplingRound` so that the request and the completion — emitted from
    // two different functions — carry the same span id.
    const modelSpan = createChildSpanContext(context.span);
    const modelStartedAt = Date.now();

    const roundResult = await runSamplingRound(
      modelGateway,
      input,
      context,
      history,
      round,
      emitAgentEvent,
      modelSpan,
      modelStartedAt,
    );
    emitAgentEvent?.({
      type: 'model_completed',
      round: round,
      model: roundResult.model,
      streamedAssistantText: roundResult.streamedAssistantText,
      assistantMessages: roundResult.assistantMessages,
      toolCalls: roundResult.toolCalls,
      usage: roundResult.usage,
      span: modelSpan,
      timing: createSpanTiming(modelStartedAt, Date.now()),
    });
    assertNoIncompleteToolCall(roundResult);
    assertCommittedAssistantMessage(roundResult);

    const modelCallUsage = createAgentModelCallUsage(
      'tool_or_answer_selection',
      roundResult.usage.tokenUsage,
      roundResult.usage.rawUsage,
    );
    modelCallUsages.push(modelCallUsage);

    if (roundResult.toolCalls.length === 0) {
      const answer = readAssistantAnswer(
        readCommittedAssistantText(roundResult.assistantMessages),
      );
      appendResponseItems(
        history,
        createCommittedAssistantMessageItems(
          roundResult.assistantMessages,
          'final_response',
        ),
        session,
        emitHistoryCommittedDebugEvent,
      );

      return {
        model: roundResult.model,
        answer: answer,
        finalCallUsage: modelCallUsage,
        usedTool: usedTool,
      };
    }

    usedTool = true;
    appendResponseItems(
      history,
      [
        ...createCommittedAssistantMessageItems(
          roundResult.assistantMessages,
          'working_message',
        ),
        ...createAssistantResponseItems({
          model: roundResult.model,
          text: '',
          toolCalls: roundResult.toolCalls,
          usage: roundResult.usage,
        }),
      ],
      session,
      emitHistoryCommittedDebugEvent,
    );

    const toolBatch = await executeAgentToolBatch(
      roundResult.toolCalls,
      context,
      {
        onEvent: emitAgentEvent,
      },
    );
    const repeatedToolCallLoopError = detectRepeatedToolCallLoop(
      roundResult.toolCalls,
      toolBatch,
      loopGuard,
    );
    const toolStep = createToolStep(
      roundResult.toolCalls,
      toolBatch.toolExecutions,
      toolBatch.executionMode,
      round,
      steps.length + 1,
    );
    steps.push(toolStep);
    emitAgentEvent?.({
      type: 'step_created',
      step: toolStep,
    });
    logAgentStep(context.runId, toolStep);

    appendResponseItems(
      history,
      toolBatch.toolExecutions.map((execution) =>
        createToolOutputItem(execution),
      ),
      session,
      emitHistoryCommittedDebugEvent,
    );

    if (repeatedToolCallLoopError !== undefined) {
      throw repeatedToolCallLoopError;
    }

    await compactAgentHistoryIfNeeded(
      modelGateway,
      context,
      history,
      roundResult.usage.tokenUsage,
      session,
      emitAgentEvent,
    );
  }
}

type SubagentSpawnerInput = {
  parentContext: AgentRunContext;
  parentSession: AgentSession;
  parentSessionId: string;
  config: ModelConfig;
  input: AgentInput;
  systemMessage: string;
  /** The parent's usage accumulator; a child's model calls are rolled up here. */
  parentModelCallUsages: AgentModelCallUsage[];
  /** The live browser stream, or undefined for a non-streaming run. */
  forwardEvent: ((event: AgentEvent) => void) | undefined;
};

/**
 * Builds the capability that turns a `task` tool call into a real derived run.
 *
 * Three things make a subagent a subagent rather than a nested function call:
 *
 * 1. *Its own session file.* A derived run has an independent context window,
 *    so folding its transcript into the parent's would corrupt the parent's
 *    replay. Its events persist to `subagents/agent-<id>.jsonl`.
 * 2. *The parent's live stream, all the same.* Persistence and presentation are
 *    different questions: the browser still wants to watch the child work, so
 *    events are forwarded to the parent's stream even though they are stored
 *    elsewhere. Their span parentage is what keeps them in the right place in
 *    the waterfall.
 * 3. *The parent's abort signal.* A cancelled parent must not leave a child
 *    running; inheriting the signal is what makes cancellation transitive.
 */
function createSubagentSpawner(
  spawnerInput: SubagentSpawnerInput,
): AgentSubagentSpawner {
  return async (request) => {
    const agentId = randomUUID();
    const spawnDepth = spawnerInput.parentContext.spawnDepth + 1;
    const session = createSubagentSession({
      parentSession: spawnerInput.parentSession,
      parentSessionId: spawnerInput.parentSessionId,
      agentId: agentId,
      agentType: request.agentType,
      description: request.description,
      toolCallId: request.toolCallId,
      spawnDepth: spawnDepth,
      cwd: process.cwd(),
      source: 'api_agent_stream',
      modelProvider: 'openai_compatible',
      model: spawnerInput.config.model,
      baseURL: spawnerInput.config.baseURL,
      wireApi: spawnerInput.config.wireApi,
      policy: spawnerInput.parentContext.policy,
    });

    const context = createAgentRunContext({
      runId: agentId,
      // Inheriting the parent's signal is what makes cancellation transitive.
      signal: spawnerInput.parentContext.signal,
      policy: spawnerInput.parentContext.policy,
      approvalMode: spawnerInput.parentContext.approvalMode,
      // The subagent's root span hangs off the `task` tool call's span, which
      // is how a run in a different file lands inside the parent's waterfall.
      span: createChildSpanContext(request.parentSpan),
      spawnDepth: spawnDepth,
    });
    // Wired after construction so the child can spawn in turn; the depth limit
    // is enforced by tool visibility, not by withholding the capability.
    context.spawnSubagent = createSubagentSpawner({
      ...spawnerInput,
      parentContext: context,
      parentSession: session,
      parentSessionId: agentId,
    });

    function emitSubagentEvent(event: AgentEvent): void {
      appendAgentSessionEvent(session, event);
      spawnerInput.forwardEvent?.(event);
      logAgentEvent(context.runId, event);
    }

    emitSubagentEvent({
      type: 'run_started',
      runId: context.runId,
      sessionId: agentId,
      resumed: false,
      policy: context.policy,
      span: context.span,
      spawnDepth: spawnDepth,
      startedAt: new Date().toISOString(),
    });

    const modelGateway = createAgentModelGateway(spawnerInput.config, context);
    const history = createInitialResponseItems(
      request.prompt,
      spawnerInput.systemMessage,
    );
    const steps: AgentStep[] = [];
    const modelCallUsages: AgentModelCallUsage[] = [];

    appendExistingResponseItemsToSession(history, session);

    try {
      const samplingResult = await runSamplingLoop(
        modelGateway,
        spawnerInput.input,
        context,
        history,
        steps,
        modelCallUsages,
        session,
        emitSubagentEvent,
        undefined,
      );

      emitSubagentEvent({
        type: 'run_succeeded',
        result: {
          model: samplingResult.model,
          answer: samplingResult.answer,
          steps: steps,
          usage: createAgentUsage(modelCallUsages),
        },
      });

      return {
        sessionId: agentId,
        agentId: agentId,
        answer: samplingResult.answer,
        spawnDepth: spawnDepth,
      };
    } catch (error) {
      emitSubagentEvent({
        type: 'run_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // Roll the child's model calls into the parent's total. Without this a
      // run that delegates most of its work would report a token bill far
      // smaller than the one that actually arrives.
      spawnerInput.parentModelCallUsages.push(...modelCallUsages);
    }
  };
}

export async function runAgent(
  input: AgentInput,
  config: ModelConfig,
  contextInput: AgentRunContextInput,
): Promise<AgentResult> {
  const context = createAgentRunContextForInput(input, contextInput);
  const modelGateway = createAgentModelGateway(config, context);
  const prompt = buildAgentPrompt(input);
  const systemMessage = buildAgentSystemMessage(
    AGENT_SYSTEM_MESSAGE,
    await gatherAgentEnvironmentContext(),
  );
  const steps: AgentStep[] = [];
  const history = createInitialResponseItems(prompt, systemMessage);
  const modelCallUsages: AgentModelCallUsage[] = [];

  assertAgentRunNotAborted(context);
  const promptStep = createPromptStep(input, prompt, steps.length + 1);
  steps.push(promptStep);
  logAgentStep(context.runId, promptStep);
  logAgentInfo(context.runId, 'prompt_built', {
    prompt: prompt,
    promptLength: prompt.length,
  });

  const samplingResult = await runSamplingLoop(
    modelGateway,
    input,
    context,
    history,
    steps,
    modelCallUsages,
    undefined,
    undefined,
    undefined,
  );
  const finalStep = createFinalAnswerStep(
    samplingResult.model,
    samplingResult.answer,
    samplingResult.finalCallUsage,
    steps.length + 1,
    samplingResult.usedTool,
  );
  steps.push(finalStep);
  logAgentStep(context.runId, finalStep);
  logAgentInfo(context.runId, 'model_answer_received', {
    answer: samplingResult.answer,
    answerLength: samplingResult.answer.length,
    model: samplingResult.model,
    hasUsage: samplingResult.finalCallUsage.tokenUsage !== null,
  });

  return {
    model: samplingResult.model,
    answer: samplingResult.answer,
    steps: steps,
    usage: createAgentUsage(modelCallUsages),
  };
}

export async function runAgentStream(
  input: AgentInput,
  config: ModelConfig,
  contextInput: AgentRunContextInput,
  callbacks: RunAgentStreamCallbacks,
): Promise<AgentResult> {
  const context = createAgentRunContextForInput(input, contextInput);
  const modelGateway = createAgentModelGateway(config, context);
  const prompt = buildAgentPrompt(input);
  // Environment context is captured once, at session start, and baked into the
  // system message. A resumed session already carries its original system
  // message in history, so this only applies to fresh sessions.
  const systemMessage =
    input.sessionId === undefined
      ? buildAgentSystemMessage(
          AGENT_SYSTEM_MESSAGE,
          await gatherAgentEnvironmentContext(),
        )
      : undefined;
  const sessionInit = initializeAgentSessionForStream(
    input,
    context,
    config,
    prompt,
    systemMessage,
  );
  const { session, history, sessionId, resumed } = sessionInit;
  appendAgentTurnContext(session, {
    turnId: context.runId,
    model: config.model,
    wireApi: config.wireApi,
    approvalPolicy: context.policy.approvalPolicy,
    sandboxMode: context.policy.sandboxMode,
    temperature: input.temperature,
  });
  let runState = createAgentRunState(context.runId);
  const steps: AgentStep[] = [];
  const modelCallUsages: AgentModelCallUsage[] = [];

  // Attached only now, because a spawner needs the session handle that
  // `initializeAgentSessionForStream` just produced. Until this line the run
  // has no way to derive subagents, and `task` is correspondingly invisible.
  context.spawnSubagent = createSubagentSpawner({
    parentContext: context,
    parentSession: session,
    parentSessionId: sessionId,
    config: config,
    input: input,
    systemMessage: systemMessage ?? AGENT_SYSTEM_MESSAGE,
    parentModelCallUsages: modelCallUsages,
    // Subagent events persist to the child's own file, but still reach the
    // browser through the parent's stream so the waterfall fills in live.
    forwardEvent: callbacks.onEvent,
  });

  function emitAgentEvent(event: AgentEvent): void {
    appendAgentSessionEvent(session, event);
    runState = applyAgentEvent(runState, event);
    callbacks.onEvent(event);
    logAgentEvent(context.runId, event);
  }

  logAgentInfo(context.runId, resumed ? 'session_resumed' : 'session_created', {
    path: session.path,
    sessionId: sessionId,
  });

  emitAgentEvent({
    type: 'run_started',
    runId: context.runId,
    sessionId: sessionId,
    resumed: resumed,
    policy: context.policy,
    span: context.span,
    spawnDepth: context.spawnDepth,
    startedAt: new Date().toISOString(),
  });

  try {
    assertAgentRunNotAborted(context);
    const promptStep = createPromptStep(input, prompt, steps.length + 1);
    steps.push(promptStep);
    emitAgentEvent({
      type: 'step_created',
      step: promptStep,
    });
    logAgentStep(context.runId, promptStep);
    logAgentInfo(context.runId, 'prompt_built', {
      prompt: prompt,
      promptLength: prompt.length,
    });

    appendExistingResponseItemsToSession(sessionInit.newItemsToPersist, session);
    const samplingResult = await runSamplingLoop(
      modelGateway,
      input,
      context,
      history,
      steps,
      modelCallUsages,
      session,
      emitAgentEvent,
      callbacks.onDebugEvent,
    );
    const finalStep = createFinalAnswerStep(
      samplingResult.model,
      samplingResult.answer,
      samplingResult.finalCallUsage,
      steps.length + 1,
      samplingResult.usedTool,
    );
    steps.push(finalStep);
    emitAgentEvent({
      type: 'step_created',
      step: finalStep,
    });
    logAgentStep(context.runId, finalStep);
    logAgentInfo(context.runId, 'model_answer_received', {
      answer: samplingResult.answer,
      answerLength: samplingResult.answer.length,
      model: samplingResult.model,
      hasUsage: samplingResult.finalCallUsage.tokenUsage !== null,
    });

    const usage = createAgentUsage(modelCallUsages);
    const result = {
      model: samplingResult.model,
      answer: samplingResult.answer,
      steps: steps,
      usage: usage,
    };
    emitAgentEvent({
      type: 'run_succeeded',
      result: result,
    });
    logAgentInfo(context.runId, 'runtime_state_finished', {
      status: runState.status,
      eventCount: runState.events.length,
    });

    return result;
  } catch (error) {
    // A run must leave a terminal event behind: without it the session JSONL
    // ends mid-run and the derived run state never reaches a terminal status.
    // Emitting is best-effort -- if the JSONL append or the SSE enqueue is
    // itself what failed, the original error still propagates.
    try {
      if (context.signal?.aborted) {
        emitAgentEvent({
          type: 'run_cancelled',
          reason: 'Run aborted by the client.',
        });
      } else {
        emitAgentEvent({
          type: 'run_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch {
      // Keep the original error.
    }

    throw error;
  }
}
