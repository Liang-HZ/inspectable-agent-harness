'use client';

import {
  FormEvent,
  ReactNode,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { AgentTraceWaterfall } from './agent-trace-waterfall';
import { ObservabilityPanel } from './observability-panel';
import { buildAgentTraceTree } from '../lib/agent-trace-tree';

import {
  requestAgentRunStream,
  submitAgentApprovalDecision,
} from '../lib/agent-api-client';
import type {
  AgentApiResponse,
  AgentApprovalStreamRequest,
  AgentDebugStreamEvent,
  AgentStep,
  AgentUsage,
} from '../lib/agent-api-types';
import type {
  AgentApprovalPolicy,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunPolicy,
  AgentSandboxMode,
} from '../lib/agent-permissions';
import type {
  AgentSessionRecord,
  AgentSessionSummary,
} from '../lib/agent-session-store';
import { requestChatCompletion } from '../lib/chat-api-client';
import type { ChatApiResponse } from '../lib/chat-api-types';

type WorkbenchMode = 'chat' | 'agent';
type AgentPageMode = 'debug' | 'audit' | 'session';

type ChatFormState = {
  message: string;
  model: string;
  temperature: string;
};

type AgentFormState = {
  task: string;
  goal: string;
  context: string;
  model: string;
  temperature: string;
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  sessionId: string;
};

type ChatViewState =
  | {
      status: 'idle';
      response: null;
    }
  | {
      status: 'submitting';
      response: null;
    }
  | {
      status: 'success';
      response: Extract<ChatApiResponse, { ok: true }>;
    }
  | {
      status: 'error';
      response: Extract<ChatApiResponse, { ok: false }>;
    };

type AgentViewState =
  | {
      status: 'idle';
      response: null;
    }
  | {
      status: 'streaming';
      answer: string;
      steps: AgentStep[];
      debugEvents: AgentDebugStreamEvent[];
      model: string | null;
      pendingApprovals: AgentApprovalStreamRequest[];
    }
  | {
      status: 'aborted';
      answer: string;
      steps: AgentStep[];
      debugEvents: AgentDebugStreamEvent[];
    }
  | {
      status: 'success';
      response: Extract<AgentApiResponse, { ok: true }>;
      debugEvents: AgentDebugStreamEvent[];
    }
  | {
      status: 'error';
      response: Extract<AgentApiResponse, { ok: false }>;
      debugEvents: AgentDebugStreamEvent[];
    };

type WorkbenchState = {
  mode: WorkbenchMode;
  agentPage: AgentPageMode;
  chatForm: ChatFormState;
  chatView: ChatViewState;
  agentForm: AgentFormState;
  agentView: AgentViewState;
};

type WorkbenchAction =
  | {
      type: 'modeChanged';
      mode: WorkbenchMode;
    }
  | {
      type: 'agentPageChanged';
      page: AgentPageMode;
    }
  | {
      type: 'chatMessageChanged';
      value: string;
    }
  | {
      type: 'chatModelChanged';
      value: string;
    }
  | {
      type: 'chatTemperatureChanged';
      value: string;
    }
  | {
      type: 'chatSubmitStarted';
    }
  | {
      type: 'chatSubmitFinished';
      response: ChatApiResponse;
    }
  | {
      type: 'agentTaskChanged';
      value: string;
    }
  | {
      type: 'agentGoalChanged';
      value: string;
    }
  | {
      type: 'agentContextChanged';
      value: string;
    }
  | {
      type: 'agentModelChanged';
      value: string;
    }
  | {
      type: 'agentTemperatureChanged';
      value: string;
    }
  | {
      type: 'agentApprovalPolicyChanged';
      value: AgentApprovalPolicy;
    }
  | {
      type: 'agentSandboxModeChanged';
      value: AgentSandboxMode;
    }
  | {
      type: 'agentSessionIdChanged';
      value: string;
    }
  | {
      type: 'agentSubmitStarted';
    }
  | {
      type: 'agentStepReceived';
      step: AgentStep;
    }
  | {
      type: 'agentAssistantDeltaReceived';
      delta: string;
    }
  | {
      type: 'agentDebugEventReceived';
      event: AgentDebugStreamEvent;
    }
  | {
      type: 'agentApprovalRequiredReceived';
      request: AgentApprovalStreamRequest;
    }
  | {
      type: 'agentApprovalResolvedReceived';
      toolCallId: string;
    }
  | {
      type: 'agentRunAborted';
    }
  | {
      type: 'agentSubmitFinished';
      response: AgentApiResponse;
    };

type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
};

type TextAreaFieldProps = TextFieldProps & {
  rows?: number;
};

type ModeSwitcherProps = {
  mode: WorkbenchMode;
  onModeChange: (mode: WorkbenchMode) => void;
};

type AgentPageSwitcherProps = {
  page: AgentPageMode;
  onPageChange: (page: AgentPageMode) => void;
};

type ChatFormProps = {
  form: ChatFormState;
  isSubmitting: boolean;
  canSubmit: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onMessageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onTemperatureChange: (value: string) => void;
};

type AgentFormProps = {
  form: AgentFormState;
  isSubmitting: boolean;
  canSubmit: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onTaskChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onContextChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onTemperatureChange: (value: string) => void;
  onApprovalPolicyChange: (value: AgentApprovalPolicy) => void;
  onSandboxModeChange: (value: AgentSandboxMode) => void;
  onSessionIdChange: (value: string) => void;
};

type AgentInspectorPanelProps = {
  agentPage: AgentPageMode;
  agentView: AgentViewState;
  onAgentPageChange: (page: AgentPageMode) => void;
  onContinueSession: (sessionId: string) => void;
};

const AGENT_APPROVAL_POLICY_OPTIONS: Array<{
  value: AgentApprovalPolicy;
  label: string;
}> = [
  { value: 'on_request', label: 'Ask when needed' },
  { value: 'strict', label: 'Strict approval' },
  { value: 'never', label: 'Auto approve' },
];

const AGENT_SANDBOX_MODE_OPTIONS: Array<{
  value: AgentSandboxMode;
  label: string;
}> = [
  { value: 'read_only', label: 'Read-only' },
  { value: 'workspace_write', label: 'Workspace write' },
  { value: 'danger_full_access', label: 'Danger full access' },
];

const initialState: WorkbenchState = {
  mode: 'agent',
  agentPage: 'debug',
  chatForm: {
    message: '人生的意义是什么。',
    model: 'gpt-5.5',
    temperature: '0.7',
  },
  chatView: {
    status: 'idle',
    response: null,
  },
  agentForm: {
    task: '请梳理当前项目的 Tool Runtime Boundary v1：找出工具注册、路径策略、工具调度、provider schema 适配分别在哪些文件，并说明一次 read 工具调用从模型请求到写回 history 的链路。',
    goal: '必须使用本地项目探索工具完成，至少查看相关源码文件后再回答。',
    context:
      '这是一次用于验收 read、grep、find、ls 真实工具链路的请求。重点关注 lib/agent-tools.ts、lib/agent-builtins.ts、lib/agent-tool-contracts.ts、lib/agent-path-policy.ts、lib/agent-tool-runtime.ts、lib/agent-tool-scheduler.ts、lib/openai-tool-schema.ts、lib/agent.ts。',
    model: 'gpt-5.5',
    temperature: '0.7',
    approvalPolicy: 'on_request',
    sandboxMode: 'read_only',
    sessionId: '',
  },
  agentView: {
    status: 'idle',
    response: null,
  },
};

function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case 'modeChanged':
      return {
        ...state,
        mode: action.mode,
      };

    case 'agentPageChanged':
      return {
        ...state,
        agentPage: action.page,
      };

    case 'chatMessageChanged':
      return {
        ...state,
        chatForm: {
          ...state.chatForm,
          message: action.value,
        },
      };

    case 'chatModelChanged':
      return {
        ...state,
        chatForm: {
          ...state.chatForm,
          model: action.value,
        },
      };

    case 'chatTemperatureChanged':
      return {
        ...state,
        chatForm: {
          ...state.chatForm,
          temperature: action.value,
        },
      };

    case 'chatSubmitStarted':
      return {
        ...state,
        chatView: {
          status: 'submitting',
          response: null,
        },
      };

    case 'chatSubmitFinished':
      return {
        ...state,
        chatView: action.response.ok
          ? {
              status: 'success',
              response: action.response,
            }
          : {
              status: 'error',
              response: action.response,
            },
      };

    case 'agentTaskChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          task: action.value,
        },
      };

    case 'agentGoalChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          goal: action.value,
        },
      };

    case 'agentContextChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          context: action.value,
        },
      };

    case 'agentModelChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          model: action.value,
        },
      };

    case 'agentTemperatureChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          temperature: action.value,
        },
      };

    case 'agentApprovalPolicyChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          approvalPolicy: action.value,
        },
      };

    case 'agentSandboxModeChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          sandboxMode: action.value,
        },
      };

    case 'agentSessionIdChanged':
      return {
        ...state,
        agentForm: {
          ...state.agentForm,
          sessionId: action.value,
        },
      };

    case 'agentSubmitStarted':
      return {
        ...state,
        agentView: {
          status: 'streaming',
          answer: '',
          steps: [],
          debugEvents: [],
          model: null,
          pendingApprovals: [],
        },
      };

    case 'agentStepReceived':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          ...state.agentView,
          steps: [...state.agentView.steps, action.step],
        },
      };

    case 'agentAssistantDeltaReceived':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          ...state.agentView,
          answer: state.agentView.answer + action.delta,
        },
      };

    case 'agentDebugEventReceived':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          ...state.agentView,
          debugEvents: [...state.agentView.debugEvents, action.event],
        },
      };

    case 'agentApprovalRequiredReceived':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          ...state.agentView,
          pendingApprovals: [
            ...state.agentView.pendingApprovals,
            action.request,
          ],
        },
      };

    case 'agentApprovalResolvedReceived':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          ...state.agentView,
          pendingApprovals: state.agentView.pendingApprovals.filter(
            (pending) => pending.toolCallId !== action.toolCallId,
          ),
        },
      };

    case 'agentRunAborted':
      if (state.agentView.status !== 'streaming') {
        return state;
      }

      return {
        ...state,
        agentView: {
          status: 'aborted',
          answer: state.agentView.answer,
          steps: state.agentView.steps,
          debugEvents: state.agentView.debugEvents,
        },
      };

    case 'agentSubmitFinished':
      if (state.agentView.status !== 'streaming') {
        // Carry the events over rather than clearing them. A run that paused
        // for approval is no longer `streaming` by the time it finishes, and
        // clearing here threw away the entire runtime event stream at exactly
        // the moment there was something to look at — leaving the trace and
        // the debug console empty for every approved run. `agentSubmitStarted`
        // is the only place a reset belongs.
        return {
          ...state,
          agentView: action.response.ok
            ? {
                status: 'success',
                response: action.response,
                debugEvents: agentViewDebugEvents(state.agentView),
              }
            : {
                status: 'error',
                response: action.response,
                debugEvents: agentViewDebugEvents(state.agentView),
              },
        };
      }

      return {
        ...state,
        agentView: action.response.ok
          ? {
              status: 'success',
              response: action.response,
              debugEvents: state.agentView.debugEvents,
            }
          : {
              status: 'error',
              response: action.response,
              debugEvents: state.agentView.debugEvents,
            },
      };
  }
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function firstChatValidationMessage(
  response: Extract<ChatApiResponse, { ok: false }>,
): string {
  const fieldErrors = response.validationErrors?.fieldErrors;

  return (
    fieldErrors?.message?.[0] ??
    fieldErrors?.model?.[0] ??
    fieldErrors?.temperature?.[0] ??
    response.validationErrors?.formErrors[0] ??
    response.error
  );
}

function firstAgentValidationMessage(
  response: Extract<AgentApiResponse, { ok: false }>,
): string {
  const fieldErrors = response.validationErrors?.fieldErrors;

  return (
    fieldErrors?.task?.[0] ??
    fieldErrors?.goal?.[0] ??
    fieldErrors?.context?.[0] ??
    fieldErrors?.model?.[0] ??
    fieldErrors?.temperature?.[0] ??
    fieldErrors?.approvalPolicy?.[0] ??
    fieldErrors?.sandboxMode?.[0] ??
    response.validationErrors?.formErrors[0] ??
    response.error
  );
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? 'null' : String(value);
}

function usageLine(usage: AgentUsage | undefined): string {
  if (usage === undefined) {
    return 'usage pending';
  }

  return [
    `input ${usage.totalTokenUsage.inputTokens}`,
    `cached ${formatOptionalNumber(usage.totalTokenUsage.cachedInputTokens)}`,
    `output ${usage.totalTokenUsage.outputTokens}`,
    `reasoning ${usage.totalTokenUsage.reasoningOutputTokens}`,
    `total ${usage.totalTokenUsage.totalTokens}`,
  ].join(' · ');
}

function agentViewDebugEvents(view: AgentViewState): AgentDebugStreamEvent[] {
  if (view.status === 'idle') {
    return [];
  }

  return view.debugEvents;
}

function agentViewUsage(view: AgentViewState): AgentUsage | undefined {
  return view.status === 'success' ? view.response.result.usage : undefined;
}

function agentRunId(view: AgentViewState): string | undefined {
  const runStartedEvent = agentViewDebugEvents(view).find(
    (event): event is Extract<AgentDebugStreamEvent, { type: 'runStarted' }> =>
      event.type === 'runStarted',
  );

  return runStartedEvent?.runId;
}

function agentSessionId(view: AgentViewState): string | undefined {
  const runStartedEvent = agentViewDebugEvents(view).find(
    (event): event is Extract<AgentDebugStreamEvent, { type: 'runStarted' }> =>
      event.type === 'runStarted',
  );

  return runStartedEvent?.sessionId;
}

function agentRunResumed(view: AgentViewState): boolean {
  const runStartedEvent = agentViewDebugEvents(view).find(
    (event): event is Extract<AgentDebugStreamEvent, { type: 'runStarted' }> =>
      event.type === 'runStarted',
  );

  return runStartedEvent?.resumed ?? false;
}

function agentRunPolicyFromEvents(
  events: AgentDebugStreamEvent[],
): AgentRunPolicy | undefined {
  const runStartedEvent = events.find(
    (event): event is Extract<AgentDebugStreamEvent, { type: 'runStarted' }> =>
      event.type === 'runStarted',
  );

  return runStartedEvent?.policy;
}

function runPolicyLabel(policy: AgentRunPolicy | undefined): string {
  if (policy === undefined) {
    return 'pending';
  }

  return `${policy.approvalPolicy} / ${policy.sandboxMode}`;
}

function statusText(
  mode: WorkbenchMode,
  chatView: ChatViewState,
  agentView: AgentViewState,
): string {
  const currentStatus = mode === 'agent' ? agentView.status : chatView.status;

  if (currentStatus === 'submitting' || currentStatus === 'streaming') {
    return 'Running';
  }

  if (currentStatus === 'success') {
    return 'Ready';
  }

  if (currentStatus === 'error') {
    return 'Error';
  }

  if (currentStatus === 'aborted') {
    return 'Aborted';
  }

  return 'Idle';
}

function modelLabel(mode: WorkbenchMode, state: WorkbenchState): string {
  const model = mode === 'agent' ? state.agentForm.model : state.chatForm.model;
  return model.trim() === '' ? 'env OPENAI_MODEL' : model;
}

function RunStatusBadge({ label }: { label: string }) {
  if (label === 'Running') {
    return (
      <strong className="runningStatusBadge">
        <span className="shimmerText">Running</span>
      </strong>
    );
  }

  return <strong>{label}</strong>;
}

function TextField({
  label,
  value,
  onChange,
  inputMode = 'text',
  placeholder,
}: TextFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 5,
}: TextAreaFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: Array<{ value: TValue; label: string }>;
  onChange: (value: TValue) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as TValue)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModeSwitcher({ mode, onModeChange }: ModeSwitcherProps) {
  return (
    <div className="modeSwitcher" aria-label="API mode">
      <button
        type="button"
        className={
          mode === 'agent' ? 'modeButton activeModeButton' : 'modeButton'
        }
        onClick={() => onModeChange('agent')}
      >
        Agent
      </button>
      <button
        type="button"
        className={
          mode === 'chat' ? 'modeButton activeModeButton' : 'modeButton'
        }
        onClick={() => onModeChange('chat')}
      >
        Chat
      </button>
    </div>
  );
}

function AgentPageSwitcher({ page, onPageChange }: AgentPageSwitcherProps) {
  return (
    <div className="subPageSwitcher" aria-label="Agent output page">
      <button
        type="button"
        className={
          page === 'debug'
            ? 'subPageButton activeSubPageButton'
            : 'subPageButton'
        }
        onClick={() => onPageChange('debug')}
      >
        Debug
      </button>
      <button
        type="button"
        className={
          page === 'audit'
            ? 'subPageButton activeSubPageButton'
            : 'subPageButton'
        }
        onClick={() => onPageChange('audit')}
      >
        Audit
      </button>
      <button
        type="button"
        className={
          page === 'session'
            ? 'subPageButton activeSubPageButton'
            : 'subPageButton'
        }
        onClick={() => onPageChange('session')}
      >
        Session
      </button>
    </div>
  );
}

function SubmitButton({
  isSubmitting,
  disabled,
  children,
}: {
  isSubmitting: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button className="primaryButton" type="submit" disabled={disabled}>
      <span
        className={isSubmitting ? 'buttonDot activeButtonDot' : 'buttonDot'}
      />
      {children}
    </button>
  );
}

function ModelControls({
  model,
  temperature,
  onModelChange,
  onTemperatureChange,
}: {
  model: string;
  temperature: string;
  onModelChange: (value: string) => void;
  onTemperatureChange: (value: string) => void;
}) {
  return (
    <div className="controlGrid">
      <TextField
        label="Model"
        value={model}
        placeholder="env OPENAI_MODEL"
        onChange={onModelChange}
      />
      <TextField
        label="Temperature"
        value={temperature}
        inputMode="decimal"
        onChange={onTemperatureChange}
      />
    </div>
  );
}

function AgentForm({
  form,
  isSubmitting,
  canSubmit,
  onSubmit,
  onCancel,
  onTaskChange,
  onGoalChange,
  onContextChange,
  onModelChange,
  onTemperatureChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onSessionIdChange,
}: AgentFormProps) {
  return (
    <form className="requestForm agentComposerForm" onSubmit={onSubmit}>
      {form.sessionId !== '' ? (
        <div className="sessionContinueBanner">
          <span>
            Continuing session <code>{sessionShortId(form.sessionId)}</code>
          </span>
          <button
            type="button"
            className="linkButton"
            onClick={() => onSessionIdChange('')}
          >
            Start new session
          </button>
        </div>
      ) : null}
      <TextAreaField
        label="Task"
        value={form.task}
        onChange={onTaskChange}
        rows={4}
      />
      <details className="composerSettings">
        <summary>Goal, context, model, and policy</summary>
        <div className="composerSettingsBody">
          <TextField label="Goal" value={form.goal} onChange={onGoalChange} />
          <TextAreaField
            label="Context"
            value={form.context}
            onChange={onContextChange}
            rows={3}
          />
          <ModelControls
            model={form.model}
            temperature={form.temperature}
            onModelChange={onModelChange}
            onTemperatureChange={onTemperatureChange}
          />
          <div className="controlGrid policyControlGrid">
            <SelectField
              label="Approval"
              value={form.approvalPolicy}
              options={AGENT_APPROVAL_POLICY_OPTIONS}
              onChange={onApprovalPolicyChange}
            />
            <SelectField
              label="Sandbox"
              value={form.sandboxMode}
              options={AGENT_SANDBOX_MODE_OPTIONS}
              onChange={onSandboxModeChange}
            />
          </div>
        </div>
      </details>
      <div className="formActions">
        <SubmitButton isSubmitting={isSubmitting} disabled={!canSubmit}>
          {isSubmitting ? 'Running agent' : 'Run agent'}
        </SubmitButton>
        {isSubmitting ? (
          <button className="secondaryButton" type="button" onClick={onCancel}>
            Stop
          </button>
        ) : null}
      </div>
    </form>
  );
}

function ChatForm({
  form,
  isSubmitting,
  canSubmit,
  onSubmit,
  onMessageChange,
  onModelChange,
  onTemperatureChange,
}: ChatFormProps) {
  return (
    <form className="requestForm chatComposerForm" onSubmit={onSubmit}>
      <TextAreaField
        label="Message"
        value={form.message}
        onChange={onMessageChange}
        rows={4}
      />
      <details className="composerSettings">
        <summary>Model settings</summary>
        <div className="composerSettingsBody">
          <ModelControls
            model={form.model}
            temperature={form.temperature}
            onModelChange={onModelChange}
            onTemperatureChange={onTemperatureChange}
          />
        </div>
      </details>
      <SubmitButton isSubmitting={isSubmitting} disabled={!canSubmit}>
        {isSubmitting ? 'Calling model' : 'Call model'}
      </SubmitButton>
    </form>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="emptyState">{children}</div>;
}

function WorkbenchEmptyState({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <section className="workbenchEmptyState">
      <span>{title}</span>
      {detail === undefined ? null : <p>{detail}</p>}
    </section>
  );
}

function ErrorState({ children }: { children: ReactNode }) {
  return <div className="errorState">{children}</div>;
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="assistantMarkdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function AgentTrace({ steps }: { steps: AgentStep[] }) {
  return (
    <div className="traceList">
      {steps.map((step) => (
        <article className="traceItem" key={step.order}>
          <div className="traceIndex">{step.order}</div>
          <div className="traceContent">
            <div className="traceTitleRow">
              <h3>{step.title}</h3>
              <span>{step.detail}</span>
            </div>
            {step.output === undefined ? null : (
              <pre className="jsonBlock">{formatJson(step.output)}</pre>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

type ToolDebugCard = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  status: 'requested' | 'running' | 'finished';
  input: unknown;
  result: unknown;
  modelOutput: string | undefined;
  isError: boolean | undefined;
};

type ModelCompletedDebugEvent = Extract<
  AgentDebugStreamEvent,
  { type: 'modelCompleted' }
>;

type HistoryCommittedDebugEvent = Extract<
  AgentDebugStreamEvent,
  { type: 'historyCommitted' }
>;

type PermissionAuditDebugEvent = Extract<
  AgentDebugStreamEvent,
  { type: 'toolPermissionDecided' | 'approvalRequested' }
>;

type HistoryCompactedDebugEvent = Extract<
  AgentDebugStreamEvent,
  { type: 'historyCompacted' }
>;

type AgentSessionFetchState =
  | {
      status: 'idle';
      records: null;
      error: null;
    }
  | {
      status: 'loading';
      records: AgentSessionRecord[] | null;
      error: null;
    }
  | {
      status: 'success';
      records: AgentSessionRecord[];
      error: null;
    }
  | {
      status: 'error';
      records: AgentSessionRecord[] | null;
      error: string;
    };

type AgentSessionListFetchState =
  | {
      status: 'idle';
      sessions: AgentSessionSummary[];
      error: null;
    }
  | {
      status: 'loading';
      sessions: AgentSessionSummary[];
      error: null;
    }
  | {
      status: 'success';
      sessions: AgentSessionSummary[];
      error: null;
    }
  | {
      status: 'error';
      sessions: AgentSessionSummary[];
      error: string;
    };

function createToolDebugCards(
  events: AgentDebugStreamEvent[],
): ToolDebugCard[] {
  const cards = new Map<string, ToolDebugCard>();

  for (const event of events) {
    if (event.type === 'toolRequested') {
      for (const request of event.toolRequests) {
        cards.set(request.toolCallId, {
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          argumentsJson: request.argumentsJson,
          status: 'requested',
          input: undefined,
          result: undefined,
          modelOutput: undefined,
          isError: undefined,
        });
      }
      continue;
    }

    if (event.type === 'toolStarted') {
      const existing = cards.get(event.toolCallId);
      cards.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsJson: event.argumentsJson,
        status: 'running',
        input: existing?.input,
        result: existing?.result,
        modelOutput: existing?.modelOutput,
        isError: existing?.isError,
      });
      continue;
    }

    if (event.type === 'toolFinished') {
      const existing = cards.get(event.toolCallId);
      cards.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsJson: existing?.argumentsJson ?? '',
        status: 'finished',
        input: event.input,
        result: event.result,
        modelOutput: event.modelOutput,
        isError: event.isError,
      });
    }
  }

  return [...cards.values()];
}

function eventLabel(event: AgentDebugStreamEvent): string {
  switch (event.type) {
    case 'runStarted':
      return `run ${event.runId}`;
    case 'modelStarted':
      return `model ${event.stage}`;
    case 'modelRequested':
      return `round ${event.round} ${event.model}`;
    case 'modelCompleted':
      return `round ${event.round} output: ${event.toolCalls.length} tool call(s)`;
    case 'historyCommitted':
      return `${event.items.length} response item(s) committed`;
    case 'toolRequested':
      return `${event.toolRequests.length} tool request(s)`;
    case 'toolStarted':
      return `${event.toolName} started`;
    case 'toolFinished':
      return `${event.toolName} ${event.isError ? 'errored' : 'finished'}`;
    case 'toolPermissionDecided':
      return `${event.request.toolName} ${event.decision.type}`;
    case 'approvalRequested':
      return `${event.request.toolName} approval requested`;
    case 'approvalResolved':
      return `${event.toolName} approval ${event.resolution.type}`;
    case 'historyCompacted':
      return `history compacted: ${event.removedItemCount} item(s) removed, ${event.keptItemCount} kept`;
    case 'runCancelled':
      return event.reason;
  }
}

function modelRequestEvents(
  events: AgentDebugStreamEvent[],
): Array<Extract<AgentDebugStreamEvent, { type: 'modelRequested' }>> {
  return events.filter(
    (
      event,
    ): event is Extract<AgentDebugStreamEvent, { type: 'modelRequested' }> =>
      event.type === 'modelRequested',
  );
}

function modelCompletedEvents(
  events: AgentDebugStreamEvent[],
): ModelCompletedDebugEvent[] {
  return events.filter(
    (event): event is ModelCompletedDebugEvent =>
      event.type === 'modelCompleted',
  );
}

function historyCommittedEvents(
  events: AgentDebugStreamEvent[],
): HistoryCommittedDebugEvent[] {
  return events.filter(
    (event): event is HistoryCommittedDebugEvent =>
      event.type === 'historyCommitted',
  );
}

function permissionAuditEvents(
  events: AgentDebugStreamEvent[],
): PermissionAuditDebugEvent[] {
  return events.filter(
    (event): event is PermissionAuditDebugEvent =>
      event.type === 'toolPermissionDecided' ||
      event.type === 'approvalRequested',
  );
}

function historyCompactedEvents(
  events: AgentDebugStreamEvent[],
): HistoryCompactedDebugEvent[] {
  return events.filter(
    (event): event is HistoryCompactedDebugEvent =>
      event.type === 'historyCompacted',
  );
}

function modelOutputForRound(
  events: AgentDebugStreamEvent[],
  round: number,
): ModelCompletedDebugEvent | undefined {
  return modelCompletedEvents(events).find((event) => event.round === round);
}

function assistantMessageText(event: ModelCompletedDebugEvent): string {
  const committedText = event.assistantMessages
    .map((message) => message.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');

  return event.streamedAssistantText.trim() !== ''
    ? event.streamedAssistantText
    : committedText;
}

function toolCardsForModelOutput(
  event: ModelCompletedDebugEvent,
  allCards: ToolDebugCard[],
): ToolDebugCard[] {
  return event.toolCalls.map((toolCall) => {
    const existing = allCards.find((card) => card.toolCallId === toolCall.id);

    return (
      existing ?? {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsJson: toolCall.argumentsJson,
        status: 'requested',
        input: undefined,
        result: undefined,
        modelOutput: undefined,
        isError: undefined,
      }
    );
  });
}

function agentViewSteps(view: AgentViewState): AgentStep[] {
  if (view.status === 'idle' || view.status === 'error') {
    return [];
  }

  if (view.status === 'success') {
    return view.response.result.steps;
  }

  return view.steps;
}

function agentLiveAnswer(view: AgentViewState): string {
  if (view.status === 'streaming' || view.status === 'aborted') {
    return view.answer;
  }

  if (view.status === 'success') {
    return view.response.result.answer;
  }

  return '';
}

function agentDisplayStatus(view: AgentViewState): string {
  switch (view.status) {
    case 'streaming':
      return 'running';
    case 'aborted':
      return 'stopped';
    case 'success':
      return 'done';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
  }
}

function agentLiveTail(
  liveAnswer: string,
  completedAssistantText: string,
): string {
  if (
    completedAssistantText !== '' &&
    liveAnswer.startsWith(completedAssistantText)
  ) {
    return liveAnswer.slice(completedAssistantText.length);
  }

  return liveAnswer;
}

function ModelRequestDebugView({
  event,
  outputEvent,
}: {
  event: Extract<AgentDebugStreamEvent, { type: 'modelRequested' }>;
  outputEvent: ModelCompletedDebugEvent | undefined;
}) {
  return (
    <article className="modelDebugCard">
      <div className="toolDebugHeader">
        <div>
          <h3>Round {event.round}</h3>
          <span>
            {event.model} · {event.wireApi}
          </span>
        </div>
        <strong className="toolStatus">model</strong>
      </div>
      <div className="debugSummaryGrid compactDebugSummary">
        <div>
          <span className="debugLabel">Temperature</span>
          <strong>
            {event.request.temperature === undefined
              ? 'default'
              : event.request.temperature}
          </strong>
        </div>
        <div>
          <span className="debugLabel">Tool choice</span>
          <strong>{event.request.toolChoice}</strong>
        </div>
        <div>
          <span className="debugLabel">Messages</span>
          <strong>{event.request.messages.length}</strong>
        </div>
        <div>
          <span className="debugLabel">Tools</span>
          <strong>{event.request.tools.length}</strong>
        </div>
      </div>
      <details className="debugDetails" open>
        <summary>Model API input</summary>
        <pre className="jsonBlock fullJsonBlock">
          {formatJson(event.request)}
        </pre>
      </details>
      <details className="debugDetails" open>
        <summary>Model output</summary>
        <pre className="jsonBlock fullJsonBlock">
          {formatJson(
            outputEvent ?? {
              status: 'waiting_for_model_output',
            },
          )}
        </pre>
      </details>
    </article>
  );
}

function parseArgumentsForDisplay(argumentsJson: string): unknown {
  if (argumentsJson.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}

function ToolDebugCardView({ card }: { card: ToolDebugCard }) {
  return (
    <article className="toolDebugCard">
      <div className="toolDebugHeader">
        <div>
          <h3>{card.toolName}</h3>
          <span>{card.toolCallId}</span>
        </div>
        <strong
          className={
            card.isError === true ? 'toolStatus errorToolStatus' : 'toolStatus'
          }
        >
          {card.status}
        </strong>
      </div>
      <div className="debugColumns">
        <div>
          <span className="debugLabel">Arguments</span>
          <pre className="jsonBlock fullJsonBlock">
            {formatJson(parseArgumentsForDisplay(card.argumentsJson))}
          </pre>
        </div>
        <div>
          <span className="debugLabel">Model-visible output</span>
          <pre className="debugTextBlock fullDebugTextBlock">
            {card.modelOutput ?? 'Waiting for tool output...'}
          </pre>
        </div>
      </div>
      <details className="debugDetails">
        <summary>Internal details</summary>
        <pre className="jsonBlock fullJsonBlock">
          {formatJson({
            input: card.input,
            result: card.result,
          })}
        </pre>
      </details>
    </article>
  );
}

function responseItemLabel(
  item: HistoryCommittedDebugEvent['items'][number],
): string {
  switch (item.type) {
    case 'message':
      return item.role === 'assistant'
        ? `assistant ${item.runtimeRole ?? 'unknown_role'}`
        : item.role;
    case 'function_call':
      return `tool request ${item.name}`;
    case 'function_call_output':
      return `tool result ${item.toolName}`;
    case 'compaction_summary':
      return 'compaction summary';
  }
}

function HistoryCommitDebugView({
  event,
  index,
}: {
  event: HistoryCommittedDebugEvent;
  index: number;
}) {
  return (
    <article className="historyCommitCard">
      <div className="toolDebugHeader">
        <div>
          <h3>Commit {index + 1}</h3>
          <span>{event.items.length} response item(s)</span>
        </div>
        <strong className="toolStatus">history</strong>
      </div>
      <div className="historyItemList">
        {event.items.map((item, itemIndex) => (
          <details className="historyItemRow" key={`${item.type}-${itemIndex}`}>
            <summary>
              <code>{item.type}</code>
              <span>{responseItemLabel(item)}</span>
            </summary>
            <pre className="jsonBlock fullJsonBlock">{formatJson(item)}</pre>
          </details>
        ))}
      </div>
    </article>
  );
}

function HistoryCompactionDebugView({
  event,
  index,
}: {
  event: HistoryCompactedDebugEvent;
  index: number;
}) {
  return (
    <article className="historyCommitCard compactionCard">
      <div className="toolDebugHeader">
        <div>
          <h3>Compaction {index + 1}</h3>
          <span>
            {event.removedItemCount} item(s) removed, {event.keptItemCount} kept
          </span>
        </div>
        <strong className="toolStatus askToolStatus">
          {event.tokenUsageBeforeCompaction.totalTokens} tokens
        </strong>
      </div>
      <p className="auditReason">{event.reason}</p>
      <details className="debugDetails">
        <summary>Summary sent to the model</summary>
        <pre className="debugTextBlock fullDebugTextBlock">{event.summary}</pre>
      </details>
    </article>
  );
}

function decisionStatusClass(decision: AgentPermissionDecision): string {
  if (decision.type === 'deny') {
    return 'toolStatus errorToolStatus';
  }

  if (decision.type === 'ask') {
    return 'toolStatus askToolStatus';
  }

  return 'toolStatus';
}

function permissionRequestSummary(request: AgentPermissionRequest): string {
  const path =
    request.resolvedPath ?? request.requestedPath ?? request.pathAccess.type;

  return `${request.category} · ${request.source}/${request.group} · ${path}`;
}

function PermissionAuditView({
  event,
  index,
}: {
  event: PermissionAuditDebugEvent;
  index: number;
}) {
  return (
    <article className="auditDecisionCard">
      <div className="toolDebugHeader">
        <div>
          <h3>
            {index + 1}. {event.request.toolName}
          </h3>
          <span>{permissionRequestSummary(event.request)}</span>
        </div>
        <strong className={decisionStatusClass(event.decision)}>
          {event.decision.type}
        </strong>
      </div>
      <div className="debugSummaryGrid compactDebugSummary">
        <div>
          <span className="debugLabel">Policy</span>
          <strong>
            {event.request.approvalPolicy} / {event.request.sandboxMode}
          </strong>
        </div>
        <div>
          <span className="debugLabel">Decision source</span>
          <strong>{event.decision.source}</strong>
        </div>
        <div>
          <span className="debugLabel">Path access</span>
          <strong>{event.request.pathAccess.type}</strong>
        </div>
        <div>
          <span className="debugLabel">Prior read</span>
          <strong>
            {event.request.requiresPriorRead
              ? String(event.request.priorReadSatisfied)
              : 'not required'}
          </strong>
        </div>
      </div>
      <p className="auditReason">{event.decision.reason}</p>
      <details className="debugDetails">
        <summary>Audit payload</summary>
        <pre className="jsonBlock fullJsonBlock">
          {formatJson({
            eventType: event.type,
            request: event.request,
            decision: event.decision,
          })}
        </pre>
      </details>
    </article>
  );
}

function PermissionAuditList({
  auditEvents,
}: {
  auditEvents: PermissionAuditDebugEvent[];
}) {
  if (auditEvents.length === 0) {
    return <EmptyState>No permission decisions yet.</EmptyState>;
  }

  return (
    <div className="auditDebugList">
      {auditEvents.map((event, index) => (
        <PermissionAuditView
          event={event}
          index={index}
          key={`${event.type}-${event.request.toolCallId}-${index}`}
        />
      ))}
    </div>
  );
}

function AgentDebugConsole({
  events,
  usage,
}: {
  events: AgentDebugStreamEvent[];
  usage: AgentUsage | undefined;
}) {
  const policy = agentRunPolicyFromEvents(events);
  const toolCards = createToolDebugCards(events);
  const modelRequests = modelRequestEvents(events);
  const modelOutputs = modelCompletedEvents(events);
  const historyCommits = historyCommittedEvents(events);
  const auditEvents = permissionAuditEvents(events);
  const compactionEvents = historyCompactedEvents(events);

  return (
    <section className="debugPanel">
      <div className="sectionHeader">
        <span>Debug console</span>
        <code>{events.length} runtime events</code>
      </div>
      <div className="debugSummaryGrid">
        <div>
          <span className="debugLabel">Usage</span>
          <strong>{usageLine(usage)}</strong>
        </div>
        <div>
          <span className="debugLabel">Run policy</span>
          <strong>{runPolicyLabel(policy)}</strong>
        </div>
        <div>
          <span className="debugLabel">Model rounds</span>
          <strong>
            {modelOutputs.length}/{modelRequests.length} completed
          </strong>
        </div>
        <div>
          <span className="debugLabel">Tools</span>
          <strong>{toolCards.length} calls</strong>
        </div>
        <div>
          <span className="debugLabel">History commits</span>
          <strong>{historyCommits.length}</strong>
        </div>
        <div>
          <span className="debugLabel">Audit decisions</span>
          <strong>{auditEvents.length}</strong>
        </div>
        <div>
          <span className="debugLabel">Compactions</span>
          <strong>{compactionEvents.length}</strong>
        </div>
      </div>
      {modelRequests.length === 0 ? (
        <EmptyState>No model request yet.</EmptyState>
      ) : (
        <div className="modelDebugList">
          {modelRequests.map((event) => (
            <ModelRequestDebugView
              event={event}
              outputEvent={modelOutputForRound(events, event.round)}
              key={`${event.round}-${event.model}`}
            />
          ))}
        </div>
      )}
      {toolCards.length === 0 ? (
        <EmptyState>No tool calls yet.</EmptyState>
      ) : (
        <div className="toolDebugList">
          {toolCards.map((card) => (
            <ToolDebugCardView card={card} key={card.toolCallId} />
          ))}
        </div>
      )}
      {historyCommits.length === 0 ? (
        <EmptyState>No history commits yet.</EmptyState>
      ) : (
        <div className="historyDebugList">
          {historyCommits.map((event, index) => (
            <HistoryCommitDebugView
              event={event}
              index={index}
              key={`history-${index}`}
            />
          ))}
        </div>
      )}
      {compactionEvents.length === 0 ? null : (
        <div className="historyDebugList">
          {compactionEvents.map((event, index) => (
            <HistoryCompactionDebugView
              event={event}
              index={index}
              key={`compaction-${index}`}
            />
          ))}
        </div>
      )}
      <details className="debugDetails">
        <summary>Runtime event stream</summary>
        <div className="eventList">
          {events.map((event, index) => (
            <details className="eventRow" key={`${event.type}-${index}`}>
              <summary>
                <code>{event.type}</code>
                <span>{eventLabel(event)}</span>
              </summary>
              <pre className="jsonBlock fullJsonBlock">{formatJson(event)}</pre>
            </details>
          ))}
        </div>
      </details>
    </section>
  );
}

function AgentAuditConsole({ events }: { events: AgentDebugStreamEvent[] }) {
  const auditEvents = permissionAuditEvents(events);

  return (
    <section className="debugPanel auditPanel">
      <div className="sectionHeader">
        <span>Permission audit</span>
        <code>{auditEvents.length} decision(s)</code>
      </div>
      <PermissionAuditList auditEvents={auditEvents} />
    </section>
  );
}

async function fetchAgentSessionRecords(
  runId: string,
): Promise<AgentSessionRecord[]> {
  const response = await fetch(
    `/api/agent/sessions/${encodeURIComponent(runId)}`,
  );
  const data = (await response.json()) as unknown;

  if (
    typeof data === 'object' &&
    data !== null &&
    'ok' in data &&
    data.ok === true &&
    'records' in data &&
    Array.isArray(data.records)
  ) {
    return data.records as AgentSessionRecord[];
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string'
  ) {
    throw new Error(data.error);
  }

  if (!response.ok) {
    throw new Error(`Session request failed with status ${response.status}.`);
  }

  throw new Error('Session API returned an unexpected response shape.');
}

async function fetchAgentSessionSummaries(): Promise<AgentSessionSummary[]> {
  const response = await fetch('/api/agent/sessions');
  const data = (await response.json()) as unknown;

  if (
    typeof data === 'object' &&
    data !== null &&
    'ok' in data &&
    data.ok === true &&
    'sessions' in data &&
    Array.isArray(data.sessions)
  ) {
    return data.sessions as AgentSessionSummary[];
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string'
  ) {
    throw new Error(data.error);
  }

  if (!response.ok) {
    throw new Error(
      `Session list request failed with status ${response.status}.`,
    );
  }

  throw new Error('Session list API returned an unexpected response shape.');
}

function recordsToJsonl(records: AgentSessionRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function sessionPolicyFromRecords(
  records: AgentSessionRecord[],
): AgentRunPolicy | undefined {
  const metaRecord = records.find((record) => record.type === 'session_meta');

  if (metaRecord?.type === 'session_meta') {
    return metaRecord.payload.policy;
  }

  const turnContext = records.find((record) => record.type === 'turn_context');

  if (turnContext?.type === 'turn_context') {
    return {
      approvalPolicy: turnContext.payload.approvalPolicy,
      sandboxMode: turnContext.payload.sandboxMode,
    };
  }

  return undefined;
}

function sessionShortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function AgentSessionView({
  view,
  onContinueSession,
}: {
  view: AgentViewState;
  onContinueSession: (sessionId: string) => void;
}) {
  const sessionIdFromRun = agentSessionId(view);
  const refreshKey = agentViewDebugEvents(view).length;
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | undefined
  >(sessionIdFromRun);
  const [listFetchState, setListFetchState] =
    useState<AgentSessionListFetchState>({
      status: 'idle',
      sessions: [],
      error: null,
    });
  const [fetchState, setFetchState] = useState<AgentSessionFetchState>({
    status: 'idle',
    records: null,
    error: null,
  });

  useEffect(() => {
    if (sessionIdFromRun !== undefined) {
      setSelectedSessionId(sessionIdFromRun);
    }
  }, [sessionIdFromRun]);

  useEffect(() => {
    let cancelled = false;
    setListFetchState((current) => ({
      status: 'loading',
      sessions: current.sessions,
      error: null,
    }));

    fetchAgentSessionSummaries()
      .then((sessions) => {
        if (cancelled) {
          return;
        }

        setListFetchState({
          status: 'success',
          sessions: sessions,
          error: null,
        });

        setSelectedSessionId((current) => current ?? sessions[0]?.id);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setListFetchState((current) => ({
          status: 'error',
          sessions: current.sessions,
          error:
            error instanceof Error ? error.message : 'Session list load failed',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [sessionIdFromRun]);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      setFetchState({
        status: 'idle',
        records: null,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setFetchState((current) => ({
      status: 'loading',
      records: current.records,
      error: null,
    }));

    fetchAgentSessionRecords(selectedSessionId)
      .then((records) => {
        if (cancelled) {
          return;
        }

        setFetchState({
          status: 'success',
          records: records,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setFetchState((current) => ({
          status: 'error',
          records: current.records,
          error: error instanceof Error ? error.message : 'Session load failed',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, refreshKey]);

  const sessions = listFetchState.sessions;
  const selectedSummary = sessions.find(
    (summary) => summary.id === selectedSessionId,
  );
  const records = fetchState.records ?? [];
  const selectedPolicy =
    records.length > 0
      ? sessionPolicyFromRecords(records)
      : selectedSummary === undefined
        ? undefined
        : {
            approvalPolicy: selectedSummary.approvalPolicy,
            sandboxMode: selectedSummary.sandboxMode,
          };

  return (
    <section className="sessionPanel">
      <div className="sectionHeader">
        <span>Session JSONL</span>
        <code>{selectedSessionId ?? 'no session selected'}</code>
        {selectedSessionId === undefined ? null : (
          <button
            type="button"
            className="secondaryButton continueSessionButton"
            onClick={() => onContinueSession(selectedSessionId)}
          >
            Continue this session
          </button>
        )}
      </div>
      <div className="sessionBrowser">
        <div className="sessionList">
          <div className="debugLabel">Sessions</div>
          {listFetchState.status === 'error' ? (
            <ErrorState>{listFetchState.error}</ErrorState>
          ) : null}
          {sessions.length === 0 ? (
            <EmptyState>No agent sessions found.</EmptyState>
          ) : (
            sessions.map((session) => (
              <button
                className={
                  session.id === selectedSessionId
                    ? 'sessionListButton activeSessionListButton'
                    : 'sessionListButton'
                }
                key={session.id}
                type="button"
                onClick={() => setSelectedSessionId(session.id)}
              >
                <span>{session.model}</span>
                <strong>{sessionShortId(session.id)}</strong>
                <small>
                  {session.approvalPolicy} / {session.sandboxMode}
                </small>
              </button>
            ))
          )}
        </div>
        <div className="sessionRecordPane">
          <div className="sessionSummary">
            <div>
              <span className="debugLabel">Records</span>
              <strong>{records.length}</strong>
            </div>
            <div>
              <span className="debugLabel">Load state</span>
              <strong>{fetchState.status}</strong>
            </div>
            <div>
              <span className="debugLabel">Run policy</span>
              <strong>{runPolicyLabel(selectedPolicy)}</strong>
            </div>
            <div>
              <span className="debugLabel">Source</span>
              <strong>{selectedSummary?.source ?? 'pending'}</strong>
            </div>
          </div>
          {fetchState.status === 'error' ? (
            <ErrorState>{fetchState.error}</ErrorState>
          ) : null}
          {selectedSessionId === undefined ? (
            <EmptyState>Select a session to inspect its JSONL.</EmptyState>
          ) : records.length === 0 ? (
            <EmptyState>Waiting for session records...</EmptyState>
          ) : (
            <pre className="jsonlBlock">{recordsToJsonl(records)}</pre>
          )}
        </div>
      </div>
    </section>
  );
}

function toolBatchStatus(cards: ToolDebugCard[]): string {
  if (cards.some((card) => card.isError === true)) {
    return 'needs attention';
  }

  if (cards.every((card) => card.status === 'finished')) {
    return 'done';
  }

  if (cards.some((card) => card.status === 'running')) {
    return 'running';
  }

  return 'queued';
}

function shortenForLabel(value: string, maxLength = 52): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function readStringArgument(
  argumentsJson: string,
  key: string,
): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson);

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }

    const value = (parsed as Record<string, unknown>)[key];

    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function toolActionLabel(toolName: string, argumentsJson: string): string {
  const path = readStringArgument(argumentsJson, 'path');
  const pattern = readStringArgument(argumentsJson, 'pattern');
  const command = readStringArgument(argumentsJson, 'command');

  switch (toolName) {
    case 'read':
      return path ? `Read ${shortenForLabel(path)}` : 'Read a file';
    case 'write':
      return path ? `Wrote ${shortenForLabel(path)}` : 'Wrote a file';
    case 'edit':
      return path ? `Edited ${shortenForLabel(path)}` : 'Edited a file';
    case 'ls':
      return path ? `Listed ${shortenForLabel(path)}` : 'Listed a directory';
    case 'find':
      return pattern ? `Found ${shortenForLabel(pattern)}` : 'Found files';
    case 'grep':
      return pattern
        ? `Searched for ${shortenForLabel(pattern)}`
        : 'Searched file contents';
    case 'shell':
      return command ? `Ran ${shortenForLabel(command)}` : 'Ran a command';
    default:
      return `Used ${toolName}`;
  }
}

type ToolRunPresentedStatus = 'requested' | 'running' | 'finished' | 'error';

function toolCardPresentedStatus(card: ToolDebugCard): ToolRunPresentedStatus {
  if (card.isError === true) {
    return 'error';
  }

  return card.status;
}

function ToolRunStatusHint({ status }: { status: ToolRunPresentedStatus }) {
  if (status === 'running' || status === 'requested') {
    return <span className="toolRunHint shimmerText">running…</span>;
  }

  if (status === 'error') {
    return (
      <span className="toolRunHint toolRunHintError">needs attention</span>
    );
  }

  return null;
}

function ToolRunDetail({ card }: { card: ToolDebugCard }) {
  return (
    <div className="toolRunGrid">
      <details className="toolPayloadDisclosure">
        <summary>Input</summary>
        <pre>{formatJson(parseArgumentsForDisplay(card.argumentsJson))}</pre>
      </details>
      <details className="toolPayloadDisclosure">
        <summary>Result</summary>
        <pre>{card.modelOutput ?? 'Waiting for tool result...'}</pre>
      </details>
    </div>
  );
}

function ToolBatchView({ cards }: { cards: ToolDebugCard[] }) {
  const batchStatus = toolBatchStatus(cards);

  if (cards.length === 1) {
    const card = cards[0];

    return (
      <details className="workBatch singleToolBatch">
        <summary>
          <span className="workBatchLabel">
            {toolActionLabel(card.toolName, card.argumentsJson)}
          </span>
          <ToolRunStatusHint status={toolCardPresentedStatus(card)} />
        </summary>
        <div className="toolBatchList">
          <ToolRunDetail card={card} />
        </div>
      </details>
    );
  }

  return (
    <details className="workBatch">
      <summary>
        <span className="workBatchLabel">
          {batchStatus === 'done' ? 'Used' : 'Using'} {cards.length} tools
        </span>
        <ToolRunStatusHint
          status={
            batchStatus === 'needs attention'
              ? 'error'
              : batchStatus === 'running'
                ? 'running'
                : 'finished'
          }
        />
      </summary>
      <div className="toolBatchList">
        {cards.map((card) => (
          <details className="toolRow" key={card.toolCallId}>
            <summary>
              <span className="toolRowLabel">
                {toolActionLabel(card.toolName, card.argumentsJson)}
              </span>
              <ToolRunStatusHint status={toolCardPresentedStatus(card)} />
            </summary>
            <ToolRunDetail card={card} />
          </details>
        ))}
      </div>
    </details>
  );
}

function AgentTranscript({
  view,
  events,
}: {
  view: AgentViewState;
  events: AgentDebugStreamEvent[];
}) {
  const modelOutputs = modelCompletedEvents(events);
  const toolCards = createToolDebugCards(events);
  const liveAnswer = agentLiveAnswer(view);
  const completedAssistantText = modelOutputs
    .map((event) => assistantMessageText(event))
    .join('');
  const liveTail = agentLiveTail(liveAnswer, completedAssistantText);
  const shouldShowLiveAnswer =
    view.status === 'streaming' && liveTail.trim() !== '';

  if (modelOutputs.length === 0 && !shouldShowLiveAnswer) {
    return (
      <section className="answerPanel">
        <div className="sectionHeader">
          <span>Agent</span>
          <code>{agentDisplayStatus(view)}</code>
        </div>
        {view.status === 'streaming' ? (
          <div className="thinkingIndicator">
            <span className="shimmerText">Thinking…</span>
          </div>
        ) : (
          <EmptyState>Waiting for model output...</EmptyState>
        )}
      </section>
    );
  }

  return (
    <section className="answerPanel">
      <div className="sectionHeader">
        <span>Agent</span>
        <code>{agentDisplayStatus(view)}</code>
      </div>
      <div className="agentTranscript">
        {modelOutputs.map((event) => {
          const text = assistantMessageText(event);
          const cards = toolCardsForModelOutput(event, toolCards);

          return (
            <div className="transcriptRound" key={event.round}>
              {text.trim() === '' ? null : (
                <article className="assistantText">
                  <AssistantMarkdown text={text} />
                </article>
              )}
              {cards.length === 0 ? null : <ToolBatchView cards={cards} />}
            </div>
          );
        })}
        {shouldShowLiveAnswer ? (
          <article className="assistantText liveAssistantText">
            <AssistantMarkdown text={liveTail} />
          </article>
        ) : null}
        {view.status === 'streaming' && !shouldShowLiveAnswer ? (
          <div className="thinkingIndicator">
            <span className="shimmerText">Thinking…</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AgentReadyState({ form }: { form: AgentFormState }) {
  const model = form.model.trim() === '' ? 'env OPENAI_MODEL' : form.model;
  const taskPreview = form.task.trim();

  return (
    <section className="focusReadyState">
      <div className="focusReadyPanel">
        <span className="focusReadyEyebrow">Agent ready</span>
        <h2>Working session</h2>
        <p>{taskPreview}</p>
        <div className="focusReadyMeta">
          <span>{model}</span>
          <span>{form.approvalPolicy}</span>
          <span>{form.sandboxMode}</span>
        </div>
      </div>
    </section>
  );
}

function ChatReadyState({ form }: { form: ChatFormState }) {
  const model = form.model.trim() === '' ? 'env OPENAI_MODEL' : form.model;
  const messagePreview = form.message.trim();

  return (
    <section className="focusReadyState">
      <div className="focusReadyPanel">
        <span className="focusReadyEyebrow">Model ready</span>
        <h2>Direct model call</h2>
        <p>{messagePreview}</p>
        <div className="focusReadyMeta">
          <span>{model}</span>
          <span>temperature {form.temperature}</span>
        </div>
      </div>
    </section>
  );
}

function formatApprovalArguments(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    return argumentsJson;
  }
}

type AgentApprovalDecisionState =
  | { status: 'submitting' }
  | { status: 'error'; error: string };

function AgentApprovalBar({
  pendingApprovals,
}: {
  pendingApprovals: AgentApprovalStreamRequest[];
}) {
  const [decisionState, setDecisionState] = useState<
    Record<string, AgentApprovalDecisionState>
  >({});

  async function submitDecision(
    request: AgentApprovalStreamRequest,
    decision: 'approve' | 'deny',
  ) {
    setDecisionState((current) => ({
      ...current,
      [request.toolCallId]: { status: 'submitting' },
    }));

    const result = await submitAgentApprovalDecision(
      request.runId,
      request.toolCallId,
      decision,
    );

    if (!result.ok) {
      setDecisionState((current) => ({
        ...current,
        [request.toolCallId]: { status: 'error', error: result.error },
      }));
      return;
    }

    setDecisionState((current) => {
      const next = { ...current };
      delete next[request.toolCallId];
      return next;
    });
  }

  return (
    <section className="approvalBar" aria-live="assertive">
      {pendingApprovals.map((request) => {
        const decision = decisionState[request.toolCallId];
        const isSubmitting = decision?.status === 'submitting';

        return (
          <article className="approvalCard" key={request.toolCallId}>
            <div className="approvalCardHeader">
              <strong className="toolStatus askToolStatus">
                Approval needed
              </strong>
              <code>{request.toolName}</code>
            </div>
            <p className="approvalReason">{request.reason}</p>
            <pre className="approvalArguments">
              {formatApprovalArguments(request.argumentsJson)}
            </pre>
            {decision?.status === 'error' ? (
              <p className="approvalError">{decision.error}</p>
            ) : null}
            <div className="approvalActions">
              <button
                type="button"
                className="approveButton"
                disabled={isSubmitting}
                onClick={() => submitDecision(request, 'approve')}
              >
                Approve
              </button>
              <button
                type="button"
                className="denyButton"
                disabled={isSubmitting}
                onClick={() => submitDecision(request, 'deny')}
              >
                Deny
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function AgentRunView({
  view,
  form,
}: {
  view: AgentViewState;
  form: AgentFormState;
}) {
  if (view.status === 'idle') {
    return <AgentReadyState form={form} />;
  }

  if (view.status === 'error') {
    return (
      <div className="resultStack">
        <ErrorState>{firstAgentValidationMessage(view.response)}</ErrorState>
      </div>
    );
  }

  const events = agentViewDebugEvents(view);
  const steps = agentViewSteps(view);

  return (
    <div className="resultStack">
      {view.status === 'streaming' && view.pendingApprovals.length > 0 ? (
        <AgentApprovalBar pendingApprovals={view.pendingApprovals} />
      ) : null}
      <AgentTranscript view={view} events={events} />
      {/* Open by default: the whole point of this panel is that you see the
          call chain the moment a run produces one, without a click. */}
      <details className="stepShelf" open>
        <summary>
          <span>Trace</span>
          <strong>{buildAgentTraceTree(events).spanCount}</strong>
        </summary>
        <AgentTraceWaterfall events={events} />
      </details>
      <details className="stepShelf">
        <summary>
          <span>Run details</span>
          <strong>{steps.length}</strong>
        </summary>
        {steps.length === 0 ? (
          <EmptyState>No run details yet.</EmptyState>
        ) : (
          <AgentTrace steps={steps} />
        )}
      </details>
    </div>
  );
}

function AgentInspectorView({
  view,
  page,
  onContinueSession,
}: {
  view: AgentViewState;
  page: AgentPageMode;
  onContinueSession: (sessionId: string) => void;
}) {
  if (page === 'debug') {
    if (view.status === 'idle') {
      return <WorkbenchEmptyState title="No runtime events yet" />;
    }

    return (
      <div className="resultStack">
        <AgentDebugConsole
          events={agentViewDebugEvents(view)}
          usage={agentViewUsage(view)}
        />
      </div>
    );
  }

  if (page === 'audit') {
    if (view.status === 'idle') {
      return <WorkbenchEmptyState title="No permission decisions yet" />;
    }

    return (
      <div className="resultStack">
        <AgentAuditConsole events={agentViewDebugEvents(view)} />
      </div>
    );
  }

  if (page === 'session') {
    return (
      <div className="resultStack">
        <AgentSessionView view={view} onContinueSession={onContinueSession} />
      </div>
    );
  }
}

function ChatResultView({
  view,
  form,
}: {
  view: ChatViewState;
  form: ChatFormState;
}) {
  if (view.status === 'idle') {
    return <ChatReadyState form={form} />;
  }

  if (view.status === 'submitting') {
    return <EmptyState>Calling model...</EmptyState>;
  }

  if (view.status === 'error') {
    return <ErrorState>{firstChatValidationMessage(view.response)}</ErrorState>;
  }

  return (
    <section className="answerPanel">
      <div className="sectionHeader">
        <span>Response</span>
        <code>{view.response.result.model}</code>
      </div>
      <pre className="answerText">{view.response.result.content}</pre>
    </section>
  );
}

function SessionRail({
  activeRunId,
  onOpenSessions,
}: {
  activeRunId: string | undefined;
  onOpenSessions: () => void;
}) {
  const [listFetchState, setListFetchState] =
    useState<AgentSessionListFetchState>({
      status: 'idle',
      sessions: [],
      error: null,
    });

  useEffect(() => {
    let cancelled = false;
    setListFetchState((current) => ({
      status: 'loading',
      sessions: current.sessions,
      error: null,
    }));

    fetchAgentSessionSummaries()
      .then((sessions) => {
        if (cancelled) {
          return;
        }

        setListFetchState({
          status: 'success',
          sessions: sessions.slice(0, 7),
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setListFetchState((current) => ({
          status: 'error',
          sessions: current.sessions,
          error:
            error instanceof Error ? error.message : 'Session list load failed',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [activeRunId]);

  return (
    <section className="sidebarSection">
      <div className="sidebarSectionHeader">
        <span>Sessions</span>
        <button type="button" onClick={onOpenSessions}>
          View all
        </button>
      </div>
      {listFetchState.status === 'error' ? (
        <p className="sidebarNotice">{listFetchState.error}</p>
      ) : null}
      {listFetchState.sessions.length === 0 ? (
        <p className="sidebarNotice">No saved runs yet.</p>
      ) : (
        <div className="sidebarSessionList">
          {listFetchState.sessions.map((session) => (
            <button
              className={
                session.id === activeRunId
                  ? 'sidebarSessionButton activeSidebarSessionButton'
                  : 'sidebarSessionButton'
              }
              key={session.id}
              type="button"
              onClick={onOpenSessions}
            >
              <span>{session.model}</span>
              <strong>{sessionShortId(session.id)}</strong>
              <small>
                {session.approvalPolicy} / {session.sandboxMode}
              </small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentInspectorPanel({
  agentPage,
  agentView,
  onAgentPageChange,
  onContinueSession,
}: AgentInspectorPanelProps) {
  return (
    <aside className="inspectorColumn" aria-live="polite">
      <div className="inspectorHeader">
        <div>
          <span className="panelKicker">Inspector</span>
          <h2>Run internals</h2>
        </div>
        <AgentPageSwitcher page={agentPage} onPageChange={onAgentPageChange} />
      </div>
      <AgentInspectorView
        view={agentView}
        page={agentPage}
        onContinueSession={onContinueSession}
      />
    </aside>
  );
}

export function ChatPlayground() {
  const [state, dispatch] = useReducer(workbenchReducer, initialState);
  const agentAbortControllerRef = useRef<AbortController | null>(null);
  const chatIsSubmitting = state.chatView.status === 'submitting';
  const agentIsSubmitting = state.agentView.status === 'streaming';
  const chatCanSubmit =
    state.chatForm.message.trim().length > 0 && !chatIsSubmitting;
  const agentCanSubmit =
    state.agentForm.task.trim().length > 0 && !agentIsSubmitting;

  async function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: 'chatSubmitStarted' });

    const response = await requestChatCompletion({
      message: state.chatForm.message,
      model: optionalText(state.chatForm.model),
      temperature: optionalText(state.chatForm.temperature),
    });

    dispatch({
      type: 'chatSubmitFinished',
      response: response,
    });
  }

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    agentAbortControllerRef.current?.abort();

    const abortController = new AbortController();
    agentAbortControllerRef.current = abortController;

    const canUpdateCurrentRun = () =>
      agentAbortControllerRef.current === abortController &&
      !abortController.signal.aborted;

    dispatch({ type: 'agentSubmitStarted' });

    try {
      await requestAgentRunStream(
        {
          task: state.agentForm.task,
          goal: optionalText(state.agentForm.goal),
          context: optionalText(state.agentForm.context),
          model: optionalText(state.agentForm.model),
          temperature: optionalText(state.agentForm.temperature),
          approvalPolicy: state.agentForm.approvalPolicy,
          sandboxMode: state.agentForm.sandboxMode,
          sessionId: optionalText(state.agentForm.sessionId),
        },
        {
          onStep: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentStepReceived',
              step: event.step,
            });
          },
          onAssistantDelta: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentAssistantDeltaReceived',
              delta: event.delta,
            });
          },
          onApprovalRequired: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentApprovalRequiredReceived',
              request: event.request,
            });
          },
          onApprovalResolved: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentApprovalResolvedReceived',
              toolCallId: event.toolCallId,
            });
          },
          onDebug: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentDebugEventReceived',
              event: event.event,
            });
          },
          onDone: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentSubmitFinished',
              response: {
                ok: true,
                result: event.result,
              },
            });
          },
          onError: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentSubmitFinished',
              response: {
                ok: false,
                error: event.error,
              },
            });
          },
        },
        {
          signal: abortController.signal,
        },
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        if (agentAbortControllerRef.current === abortController) {
          dispatch({ type: 'agentRunAborted' });
        }

        return;
      }

      dispatch({
        type: 'agentSubmitFinished',
        response: {
          ok: false,
          error: error instanceof Error ? error.message : 'Request failed',
        },
      });
    } finally {
      if (agentAbortControllerRef.current === abortController) {
        agentAbortControllerRef.current = null;
      }
    }
  }

  function cancelAgentRun() {
    agentAbortControllerRef.current?.abort();
    dispatch({ type: 'agentRunAborted' });
  }

  const currentRunId = agentRunId(state.agentView);
  const currentSessionId = agentSessionId(state.agentView);
  const currentRunResumed = agentRunResumed(state.agentView);

  return (
    <main className="appShell agentWorkbench">
      <aside className="workbenchSidebar">
        <div className="sidebarBrand">
          <span className="productLabel">Next.js API Workbench</span>
          <h1>Agent Harness</h1>
        </div>
        <ModeSwitcher
          mode={state.mode}
          onModeChange={(mode) =>
            dispatch({
              type: 'modeChanged',
              mode: mode,
            })
          }
        />
        <section className="sidebarSection">
          <div className="sidebarSectionHeader">
            <span>Current run</span>
          </div>
          <div className="sidebarRunCard">
            <RunStatusBadge
              label={statusText(state.mode, state.chatView, state.agentView)}
            />
            <span>{modelLabel(state.mode, state)}</span>
            <small>{currentRunId ?? 'no run id yet'}</small>
            {currentRunResumed ? (
              <small className="resumedBadge">
                continuing session{' '}
                {currentSessionId === undefined
                  ? ''
                  : sessionShortId(currentSessionId)}
              </small>
            ) : null}
          </div>
        </section>
        {state.mode === 'agent' ? (
          <SessionRail
            activeRunId={currentSessionId}
            onOpenSessions={() =>
              dispatch({
                type: 'agentPageChanged',
                page: 'session',
              })
            }
          />
        ) : null}
        {/* In the sidebar rather than inside the run's trace panel: stopping
            the backends must not require having a run on screen first. The
            per-run export buttons disable themselves when there is no session
            to send. */}
        <ObservabilityPanel sessionId={currentSessionId} />
      </aside>

      <section className="conversationColumn">
        <header className="conversationHeader">
          <div>
            <span className="panelKicker">
              {state.mode === 'agent' ? 'Agent transcript' : 'Chat completion'}
            </span>
            <h2>
              {state.mode === 'agent' ? 'Working session' : 'Direct model call'}
            </h2>
          </div>
          <div className="runMeta">
            <span>{modelLabel(state.mode, state)}</span>
            <RunStatusBadge
              label={statusText(state.mode, state.chatView, state.agentView)}
            />
          </div>
        </header>
        <div className="conversationScroll" aria-live="polite">
          {state.mode === 'agent' ? (
            <AgentRunView view={state.agentView} form={state.agentForm} />
          ) : (
            <ChatResultView view={state.chatView} form={state.chatForm} />
          )}
        </div>
        <div className="composerDock">
          <div className="composerHeader">
            <div>
              <span className="panelKicker">Request</span>
              <h3>
                {state.mode === 'agent' ? 'Ask the agent' : 'Ask the model'}
              </h3>
            </div>
          </div>
          {state.mode === 'agent' ? (
            <AgentForm
              form={state.agentForm}
              isSubmitting={agentIsSubmitting}
              canSubmit={agentCanSubmit}
              onSubmit={submitAgent}
              onCancel={cancelAgentRun}
              onTaskChange={(value) =>
                dispatch({
                  type: 'agentTaskChanged',
                  value: value,
                })
              }
              onGoalChange={(value) =>
                dispatch({
                  type: 'agentGoalChanged',
                  value: value,
                })
              }
              onContextChange={(value) =>
                dispatch({
                  type: 'agentContextChanged',
                  value: value,
                })
              }
              onModelChange={(value) =>
                dispatch({
                  type: 'agentModelChanged',
                  value: value,
                })
              }
              onTemperatureChange={(value) =>
                dispatch({
                  type: 'agentTemperatureChanged',
                  value: value,
                })
              }
              onApprovalPolicyChange={(value) =>
                dispatch({
                  type: 'agentApprovalPolicyChanged',
                  value: value,
                })
              }
              onSandboxModeChange={(value) =>
                dispatch({
                  type: 'agentSandboxModeChanged',
                  value: value,
                })
              }
              onSessionIdChange={(value) =>
                dispatch({
                  type: 'agentSessionIdChanged',
                  value: value,
                })
              }
            />
          ) : (
            <ChatForm
              form={state.chatForm}
              isSubmitting={chatIsSubmitting}
              canSubmit={chatCanSubmit}
              onSubmit={submitChat}
              onMessageChange={(value) =>
                dispatch({
                  type: 'chatMessageChanged',
                  value: value,
                })
              }
              onModelChange={(value) =>
                dispatch({
                  type: 'chatModelChanged',
                  value: value,
                })
              }
              onTemperatureChange={(value) =>
                dispatch({
                  type: 'chatTemperatureChanged',
                  value: value,
                })
              }
            />
          )}
        </div>
      </section>

      {state.mode === 'agent' ? (
        <AgentInspectorPanel
          agentPage={state.agentPage}
          agentView={state.agentView}
          onAgentPageChange={(page) =>
            dispatch({
              type: 'agentPageChanged',
              page: page,
            })
          }
          onContinueSession={(sessionId) =>
            dispatch({
              type: 'agentSessionIdChanged',
              value: sessionId,
            })
          }
        />
      ) : (
        <aside className="inspectorColumn chatInspector">
          <div className="inspectorHeader">
            <div>
              <span className="panelKicker">Inspector</span>
              <h2>Chat call</h2>
            </div>
          </div>
          <div className="resultStack">
            <section className="debugPanel">
              <div className="debugSummaryGrid">
                <div>
                  <span className="debugLabel">Model</span>
                  <strong>{modelLabel(state.mode, state)}</strong>
                </div>
                <div>
                  <span className="debugLabel">Status</span>
                  <strong>
                    {statusText(state.mode, state.chatView, state.agentView)}
                  </strong>
                </div>
              </div>
            </section>
          </div>
        </aside>
      )}
    </main>
  );
}
