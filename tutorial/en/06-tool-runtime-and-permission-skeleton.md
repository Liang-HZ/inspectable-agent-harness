# 06. Tool Runtime And Permission Skeleton

This chapter explains why tool execution cannot stay a plain function call. Real
agent tools need a runtime boundary for preparation, execution, errors, events,
and permission policy.

After reading this chapter, you should understand:

- the difference between tool definitions and tool execution runtime
- why a permission skeleton appears before dangerous tools
- why tool facts are separate from policy decisions
- how runtime events support both frontend debug and future telemetry

## Background

Once the model can request tools, a dangerous temptation appears: call the tool
directly from the agent loop.

That would make the loop own too much:

- registry lookup
- permission checks
- event emission
- error conversion
- tool execution
- output shaping

The project moved tool execution behind a runtime boundary before adding more
tools.

## Tool Runtime Boundary

The key file is:

```text
lib/agent-tool-runtime.ts
```

It owns the lifecycle of a single tool call:

```text
lookup tool
create permission request
decide permission
emit lifecycle events
execute handler
convert result
return AgentToolExecution
```

## Permission Skeleton

The permission layer lives in:

```text
lib/agent-permissions.ts
```

It models:

- tool annotations
- approval policy
- sandbox mode
- permission requests
- permission decisions

Current decisions are intentionally small:

- safe read-only built-ins can run
- path-denied tool calls fail before execution and become model-visible tool
  errors
- approval-required paths fail closed
- interactive approval resume is deferred

The permission request now carries both static tool facts and per-call data:

```text
declaredPathAccess
effective pathAccess for the current sandboxMode
requestedPath from the tool arguments
```

That means `sandboxMode=danger_full_access` can widen read-only file tools to
absolute paths, while the default `read_only` mode keeps them inside the current
project.

## Why Tool Facts Are Separate From Policy

A tool declares facts:

```ts
readOnly: true
destructive: false
openWorld: false
idempotent: true
```

The runtime applies policy to those facts. The tool does not decide whether it
is allowed to run.

This matters because future user settings, project trust, sandbox mode, and
approval hooks should all affect decisions without changing tool handlers.

## Runtime Events

The tool runtime emits:

```text
tool_permission_decided
approval_requested
tool_started
tool_finished
```

These events later became visible in the Debug Console.

## Git Evidence

Relevant commits:

```text
567da1f Add agent tool runtime boundary
cdd881c Add agent permission policy skeleton
```

## Deferred Work

This phase did not implement:

- OS sandboxing
- approval resume
- user decision UI
- shell permission prompts
- write/edit confirmations

That restraint was intentional. The permission contract appeared before the
risky tools.

## Common Misunderstandings

### Misunderstanding 1: Read-Only Tools Do Not Need A Runtime

Even read-only tools need argument validation, path policy, output truncation,
error formatting, and events. Runtime boundaries are not only for risky tools.

### Misunderstanding 2: Permission Policy Belongs Inside Each Tool

Tools should report facts: what path they access, whether they write, whether
they need network. Whether execution is allowed belongs to policy.

The read-only tools still perform a `realpath` guard inside the handler. That is
not a replacement for permission policy; it is a second safety check that catches
symlink escapes after the pre-execution decision.

### Misunderstanding 3: Shell Should Come First Because It Is Faster

Shell is powerful, but it has the largest safety surface. A runtime and
permission skeleton keeps future shell behavior from becoming special-case code.

## Chapter Summary

This chapter upgrades tool execution into a runtime contract. Tools describe
capability, the runtime orchestrates execution, and the permission skeleton
leaves room for sandbox and approval behavior.

## Chapter Checkpoint

Verify that the key invariants of the tool contract and permission skeleton are
locked down by tests (no key required):

```bash
npx tsx --test tests/agent-tool-contracts.test.ts
```

Measured: all 6 cases pass:

```text
✔ tool groups expose current builtin surface
✔ current tool definitions declare runtime metadata explicitly
✔ provider-visible tools do not include runtime metadata
✔ provider-visible editing tools depend on run sandbox mode
✔ path access policies enforce current project and allowed roots
✔ relative path resolution follows the active path policy base
ℹ pass 6
```

`provider-visible tools do not include runtime metadata` maps directly onto
this chapter's "tool facts versus policy" boundary; the two path policy cases
cover the rule that `sandboxMode` decides the effective pathAccess.
