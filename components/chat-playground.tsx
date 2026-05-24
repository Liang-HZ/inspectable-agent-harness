'use client';

import { FormEvent, ReactNode, useReducer, useRef } from 'react';

import { requestAgentRunStream } from '../lib/agent-api-client';
import type { AgentApiResponse, AgentStep } from '../lib/agent-api-types';
import { requestChatCompletion } from '../lib/chat-api-client';
import type { ChatApiResponse } from '../lib/chat-api-types';

type WorkbenchMode = 'chat' | 'agent';

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
      model: string | null;
    }
  | {
      status: 'aborted';
      answer: string;
      steps: AgentStep[];
    }
  | {
      status: 'success';
      response: Extract<AgentApiResponse, { ok: true }>;
    }
  | {
      status: 'error';
      response: Extract<AgentApiResponse, { ok: false }>;
    };

type WorkbenchState = {
  mode: WorkbenchMode;
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
      type: 'agentSubmitStarted';
    }
  | {
      type: 'agentStepReceived';
      step: AgentStep;
    }
  | {
      type: 'agentAnswerDeltaReceived';
      delta: string;
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
};

type ResultPanelProps = {
  mode: WorkbenchMode;
  chatView: ChatViewState;
  agentView: AgentViewState;
};

const initialState: WorkbenchState = {
  mode: 'agent',
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
    task: '请统计这段文本的字符数、行数和词数：hello world\nsecond line',
    goal: '请使用可用工具得到准确统计。',
    context: '这是一次调试请求。',
    model: 'gpt-5.5',
    temperature: '0.7',
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

    case 'agentSubmitStarted':
      return {
        ...state,
        agentView: {
          status: 'streaming',
          answer: '',
          steps: [],
          model: null,
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

    case 'agentAnswerDeltaReceived':
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
        },
      };

    case 'agentSubmitFinished':
      return {
        ...state,
        agentView: action.response.ok
          ? {
              status: 'success',
              response: action.response,
            }
          : {
              status: 'error',
              response: action.response,
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
    response.validationErrors?.formErrors[0] ??
    response.error
  );
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
}: AgentFormProps) {
  return (
    <form className="requestForm" onSubmit={onSubmit}>
      <TextAreaField label="Task" value={form.task} onChange={onTaskChange} />
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
    <form className="requestForm" onSubmit={onSubmit}>
      <TextAreaField
        label="Message"
        value={form.message}
        onChange={onMessageChange}
      />
      <ModelControls
        model={form.model}
        temperature={form.temperature}
        onModelChange={onModelChange}
        onTemperatureChange={onTemperatureChange}
      />
      <SubmitButton isSubmitting={isSubmitting} disabled={!canSubmit}>
        {isSubmitting ? 'Calling model' : 'Call model'}
      </SubmitButton>
    </form>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="emptyState">{children}</div>;
}

function ErrorState({ children }: { children: ReactNode }) {
  return <div className="errorState">{children}</div>;
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

function AgentResultView({ view }: { view: AgentViewState }) {
  if (view.status === 'idle') {
    return <EmptyState>Agent result will appear here.</EmptyState>;
  }

  if (view.status === 'error') {
    return (
      <ErrorState>{firstAgentValidationMessage(view.response)}</ErrorState>
    );
  }

  if (view.status === 'streaming') {
    return (
      <div className="resultStack">
        <section className="answerPanel">
          <div className="sectionHeader">
            <span>Answer</span>
            <code>{view.model ?? 'streaming'}</code>
          </div>
          <pre className="answerText">
            {view.answer === '' ? 'Waiting for answer...' : view.answer}
          </pre>
        </section>
        <section className="tracePanel">
          <div className="sectionHeader">
            <span>Trace</span>
            <code>{view.steps.length} steps</code>
          </div>
          {view.steps.length === 0 ? (
            <EmptyState>Waiting for first step...</EmptyState>
          ) : (
            <AgentTrace steps={view.steps} />
          )}
        </section>
      </div>
    );
  }

  if (view.status === 'aborted') {
    return (
      <div className="resultStack">
        <section className="answerPanel">
          <div className="sectionHeader">
            <span>Answer</span>
            <code>aborted</code>
          </div>
          <pre className="answerText">
            {view.answer === ''
              ? 'Run stopped before answer output.'
              : view.answer}
          </pre>
        </section>
        <section className="tracePanel">
          <div className="sectionHeader">
            <span>Trace</span>
            <code>{view.steps.length} steps</code>
          </div>
          {view.steps.length === 0 ? (
            <EmptyState>Run stopped before first step.</EmptyState>
          ) : (
            <AgentTrace steps={view.steps} />
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="resultStack">
      <section className="answerPanel">
        <div className="sectionHeader">
          <span>Answer</span>
          <code>{view.response.result.model}</code>
        </div>
        <pre className="answerText">{view.response.result.answer}</pre>
      </section>
      <section className="tracePanel">
        <div className="sectionHeader">
          <span>Trace</span>
          <code>{view.response.result.steps.length} steps</code>
        </div>
        <AgentTrace steps={view.response.result.steps} />
      </section>
    </div>
  );
}

function ChatResultView({ view }: { view: ChatViewState }) {
  if (view.status === 'idle') {
    return <EmptyState>Response will appear here.</EmptyState>;
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

function ResultPanel({ mode, chatView, agentView }: ResultPanelProps) {
  return (
    <section className="workspacePanel resultPanel" aria-live="polite">
      <div className="panelHeader">
        <div>
          <span className="panelKicker">Output</span>
          <h2>{mode === 'agent' ? 'Agent run' : 'Chat completion'}</h2>
        </div>
      </div>
      {mode === 'agent' ? (
        <AgentResultView view={agentView} />
      ) : (
        <ChatResultView view={chatView} />
      )}
    </section>
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
          onAnswerDelta: (event) => {
            if (!canUpdateCurrentRun()) {
              return;
            }

            dispatch({
              type: 'agentAnswerDeltaReceived',
              delta: event.delta,
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

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <span className="productLabel">Next.js API Workbench</span>
          <h1>Model Backend</h1>
        </div>
        <div className="runMeta">
          <span>{modelLabel(state.mode, state)}</span>
          <strong>
            {statusText(state.mode, state.chatView, state.agentView)}
          </strong>
        </div>
      </header>

      <section className="workspaceGrid">
        <section className="workspacePanel requestPanel">
          <div className="panelHeader">
            <div>
              <span className="panelKicker">Request</span>
              <h2>{state.mode === 'agent' ? 'Agent' : 'Chat'}</h2>
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
        </section>

        <ResultPanel
          mode={state.mode}
          chatView={state.chatView}
          agentView={state.agentView}
        />
      </section>
    </main>
  );
}
