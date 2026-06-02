# Building An Inspectable Agent Harness

This tutorial reconstructs the project from the beginning to the current
runtime. It is based on the git history, the current working tree, and the
design decisions that have been encoded in the codebase.

It is not a source-code reference. It is a guided explanation of why the code is
split the way it is.

Chinese mirror: [../zh/README.md](../zh/README.md)

## Chapter Map

| Chapter | Topic | Why It Exists |
| --- | --- | --- |
| [01](01-project-starting-point.md) | Project starting point and constraints | Establish the learning repo, explicit style, and smallest runnable API path. |
| [02](02-api-contracts-and-validation.md) | API contracts and validation | Keep HTTP, DTO, config, and service boundaries readable before agent complexity. |
| [03](03-living-architecture-and-workbench.md) | Living architecture and workbench | Make the project explain itself as it grows. |
| [04](04-first-agent-and-observability.md) | First agent and observability | Add `/api/agent`, steps, structured logs, and the first inspectable tool flow. |
| [05](05-streaming-cancellation-and-events.md) | Streaming, cancellation, and events | Turn the agent into a live run with abort and internal runtime events. |
| [06](06-tool-runtime-and-permission-skeleton.md) | Tool runtime and permission skeleton | Move execution behind a runtime boundary before adding risky tools. |
| [07](07-jsonl-sessions-and-usage.md) | JSONL sessions and usage | Persist runs and separate raw provider usage from normalized totals. |
| [08](08-provider-dialect-boundary.md) | Provider dialect boundary | Keep OpenAI Chat/Responses quirks out of the agent loop. |
| [09](09-response-items-and-runtime-spine.md) | Response items and runtime spine | Replace fixed teaching steps with provider-neutral model-visible history. |
| [10](10-streaming-sampling-and-commit-semantics.md) | Streaming sampling and commit semantics | Explain deltas, committed assistant messages, tool calls, and final answer detection. |
| [11](11-deterministic-runtime-tests.md) | Deterministic runtime tests | Prove the loop without calling a real provider. |
| [12](12-real-readonly-tools.md) | Real read-only tools | Replace toy capability with `ls`, `find`, `grep`, and `read`. |
| [13](13-tool-output-and-strict-openai-schema.md) | Tool output and strict OpenAI schema | Separate internal metadata from model-visible text and handle OpenAI strict schemas. |
| [14](14-debug-console-and-session-viewer.md) | Debug Console and session viewer | Split end-user transcript, runtime debug, and persisted JSONL views. |
| [15](15-tool-contract-boundary-and-toy-removal.md) | Tool contract boundary and toy removal | Add source/group/path/execution metadata and remove the toy tool. |
| [16](16-unlimited-loop-and-guardrails.md) | Unlimited loop and guardrails | Remove the artificial round cap while stopping repeated identical tool loops. |
| [17](17-current-state-and-next-steps.md) | Current state and next steps | Summarize what is real now and what must come next. |

## How To Read

If you are new to the project, read chapters 01 through 05 first. They explain
why this repo values explicit boundaries and inspectability.

If you want the current agent runtime, read chapters 08 through 16. They cover
the provider-neutral loop, real tools, debug surface, session records, and loop
guardrails.

If you are adding the next capability, read chapter 17 before implementing it.
The next layer should follow the same discipline: define the boundary, expose
the data flow, write real tests, and update the tutorial.

## Main Thread

The central idea is:

```text
The model supplies reasoning.
The harness supplies the runtime where that reasoning can safely act.
```

In this project, the harness owns:

- route boundaries
- input validation
- provider dialects
- streaming events
- model-visible history
- tools
- permissions
- cancellation
- debug surfaces
- session records
- loop guardrails

That is why the tutorial spends more time on boundaries than on prompts.
