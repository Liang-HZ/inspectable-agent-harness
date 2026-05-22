'use client';

import { FormEvent, useReducer } from 'react';

import { requestAgentRun } from '../lib/agent-api-client';
import type { AgentApiResponse } from '../lib/agent-api-types';
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
      status: 'submitting';
      response: null;
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
      type: 'agentSubmitFinished';
      response: AgentApiResponse;
    };

const initialState: WorkbenchState = {
  mode: 'agent',
  chatForm: {
    message: '人生的意义是什么。',
    model: 'glm-4.7',
    temperature: '0.7',
  },
  chatView: {
    status: 'idle',
    response: null,
  },
  agentForm: {
    task: '帮我把“调用模型”这件事拆成后端 agent 的下一步能力。',
    goal: '给出清晰、可执行、适合逐步实现的建议。',
    context:
      '当前项目已经有 /api/chat，可以调用 OpenAI-compatible Chat Completions。',
    model: 'glm-4.7',
    temperature: '0.4',
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
          status: 'submitting',
          response: null,
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

export function ChatPlayground() {
  const [state, dispatch] = useReducer(workbenchReducer, initialState);
  const chatIsSubmitting = state.chatView.status === 'submitting';
  const agentIsSubmitting = state.agentView.status === 'submitting';
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
    dispatch({ type: 'agentSubmitStarted' });

    const response = await requestAgentRun({
      task: state.agentForm.task,
      goal: optionalText(state.agentForm.goal),
      context: optionalText(state.agentForm.context),
      model: optionalText(state.agentForm.model),
      temperature: optionalText(state.agentForm.temperature),
    });

    dispatch({
      type: 'agentSubmitFinished',
      response: response,
    });
  }

  return (
    <main className="shell">
      <section className="panel">
        <div>
          <p className="eyebrow">Next.js API Workbench</p>
          <h1>Model backend</h1>
          <p className="lede">
            Chat stays as the direct model call. Agent adds task, goal, context,
            and inspectable execution steps.
          </p>
        </div>

        <div className="tabs" aria-label="API mode">
          <button
            type="button"
            className={state.mode === 'agent' ? 'tab activeTab' : 'tab'}
            onClick={() => dispatch({ type: 'modeChanged', mode: 'agent' })}
          >
            Agent
          </button>
          <button
            type="button"
            className={state.mode === 'chat' ? 'tab activeTab' : 'tab'}
            onClick={() => dispatch({ type: 'modeChanged', mode: 'chat' })}
          >
            Chat
          </button>
        </div>

        {state.mode === 'agent' ? (
          <form className="form" onSubmit={submitAgent}>
            <label>
              <span>Task</span>
              <textarea
                value={state.agentForm.task}
                onChange={(event) =>
                  dispatch({
                    type: 'agentTaskChanged',
                    value: event.target.value,
                  })
                }
              />
            </label>

            <label>
              <span>Goal</span>
              <input
                value={state.agentForm.goal}
                onChange={(event) =>
                  dispatch({
                    type: 'agentGoalChanged',
                    value: event.target.value,
                  })
                }
              />
            </label>

            <label>
              <span>Context</span>
              <textarea
                className="compactTextarea"
                value={state.agentForm.context}
                onChange={(event) =>
                  dispatch({
                    type: 'agentContextChanged',
                    value: event.target.value,
                  })
                }
              />
            </label>

            <div className="grid">
              <label>
                <span>Model</span>
                <input
                  value={state.agentForm.model}
                  onChange={(event) =>
                    dispatch({
                      type: 'agentModelChanged',
                      value: event.target.value,
                    })
                  }
                  placeholder="env OPENAI_MODEL"
                />
              </label>

              <label>
                <span>Temperature</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={state.agentForm.temperature}
                  onChange={(event) =>
                    dispatch({
                      type: 'agentTemperatureChanged',
                      value: event.target.value,
                    })
                  }
                />
              </label>
            </div>

            <button type="submit" disabled={!agentCanSubmit}>
              {agentIsSubmitting ? 'Running...' : 'Run agent'}
            </button>
          </form>
        ) : (
          <form className="form" onSubmit={submitChat}>
            <label>
              <span>Message</span>
              <textarea
                value={state.chatForm.message}
                onChange={(event) =>
                  dispatch({
                    type: 'chatMessageChanged',
                    value: event.target.value,
                  })
                }
              />
            </label>

            <div className="grid">
              <label>
                <span>Model</span>
                <input
                  value={state.chatForm.model}
                  onChange={(event) =>
                    dispatch({
                      type: 'chatModelChanged',
                      value: event.target.value,
                    })
                  }
                  placeholder="env OPENAI_MODEL"
                />
              </label>

              <label>
                <span>Temperature</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={state.chatForm.temperature}
                  onChange={(event) =>
                    dispatch({
                      type: 'chatTemperatureChanged',
                      value: event.target.value,
                    })
                  }
                />
              </label>
            </div>

            <button type="submit" disabled={!chatCanSubmit}>
              {chatIsSubmitting ? 'Calling...' : 'Call model'}
            </button>
          </form>
        )}
      </section>

      <section className="result" aria-live="polite">
        <div className="resultHeader">
          <span>{state.mode === 'agent' ? 'Agent result' : 'Response'}</span>
          {state.mode === 'agent' && state.agentView.status === 'success' ? (
            <code>{state.agentView.response.result.model}</code>
          ) : state.mode === 'chat' && state.chatView.status === 'success' ? (
            <code>{state.chatView.response.result.model}</code>
          ) : null}
        </div>

        {state.mode === 'agent' ? (
          state.agentView.status === 'success' ? (
            <div className="resultBody">
              <ol className="steps">
                {state.agentView.response.result.steps.map((step) => (
                  <li key={step.order}>
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))}
              </ol>
              <pre>{state.agentView.response.result.answer}</pre>
            </div>
          ) : (
            <pre>
              {state.agentView.status === 'error'
                ? firstAgentValidationMessage(state.agentView.response)
                : state.agentView.status === 'submitting'
                  ? 'Running agent...'
                  : 'Agent result will appear here.'}
            </pre>
          )
        ) : (
          <pre>
            {state.chatView.status === 'success'
              ? state.chatView.response.result.content
              : state.chatView.status === 'error'
                ? firstChatValidationMessage(state.chatView.response)
                : state.chatView.status === 'submitting'
                  ? 'Calling model...'
                  : 'Result will appear here.'}
          </pre>
        )}
      </section>
    </main>
  );
}
