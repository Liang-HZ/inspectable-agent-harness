# 15. Tool Contract Boundary And Toy Removal

This chapter explains how tool definitions move from a few built-in functions
to an agent-owned tool contract. The contract leaves room for builtin, dynamic,
MCP, and hosted tool sources.

After reading this chapter, you should understand:

- what tool source, group, path policy, and execution mode mean
- why provider schemas compile from the agent tool contract
- why the toy tool must leave the default capability surface
- how current built-ins compose into read-only exploration and editing

## Background

The tool file had grown too large and too specific. More importantly, names like
"workspace tools" were too narrow for the future.

`read`, `write`, `grep`, and `find` should not inherently mean "workspace
only." Path access should depend on policy:

```text
current project
allowed roots
danger full access
```

## New Contract

The provider-neutral tool definition now lives in:

```text
lib/agent-tool-contracts.ts
```

It records:

```text
source        builtin | dynamic | mcp | hosted
group         utility_builtins | read_only_builtins | editing_builtins | shell_builtins
category      utility | read | search | write | shell
annotations   readOnly / destructive / openWorld / idempotent
execution     executionMode, timeoutMs, abortable
pathAccess    none | current_project | allowed_roots | danger_full_access
modelTool     provider-neutral model-facing schema
execute       concrete handler
```

## Tool Groups

`lib/agent-tools.ts` now composes groups:

```text
utility_builtins     empty
read_only_builtins   ls/find/grep/read
editing_builtins     write/edit
shell_builtins       empty
```

The shell group is not dead code. It is an explicit future slot.

## Built-In Tools

Concrete read-only built-ins moved into:

```text
lib/agent-builtins.ts
```

Concrete editing built-ins live in:

```text
lib/agent-editing-builtins.ts
```

Path policy moved into:

```text
lib/agent-path-policy.ts
```

This makes it possible to reuse file tools under different future access modes.

Editing tools are only provider-visible when the run policy allows them. A
`read_only` run exposes `ls/find/grep/read`; a `workspace_write` run also
exposes `write/edit`. The runtime still checks permissions during dispatch, so
a hidden write-capable call cannot bypass the policy.

## Provider Boundary

Provider dialects only receive `modelTool`.

They do not receive:

- source
- group
- category
- path policy
- permission annotations
- timeout
- abortable

Those are runtime facts, not provider wire facts.

## Toy Tool Removal

The temporary text-counting tool was removed.

The frontend default task now exercises real project exploration through
`ls/find/grep/read`.

This was a meaningful cleanup: the agent should be tested on real file
exploration, not on a custom demo function.

## Tests

`tests/agent-tool-contracts.test.ts` verifies:

- active groups
- tool metadata
- provider-visible tool stripping
- path policy behavior

## Current Status

This layer establishes the agent's own tool contract boundary and is
documented in `docs/evolution.md` as Tool Runtime Boundary v1.

## Common Misunderstandings

### Misunderstanding 1: Tool Name Is Tool Classification

The tool name is only the call identifier. Classification comes from source,
group, path policy, and execution mode.

### Misunderstanding 2: Removing The Toy Tool Weakens The Demo

It makes the demo more real. The default scenario should use `ls`, `find`,
`grep`, and `read`, which transfer to real repositories.

### Misunderstanding 3: Provider Schema Is The Tool Contract

Provider schema is a wire representation. The agent-owned tool contract is the
runtime source of truth.

## Chapter Summary

This chapter establishes the long-term tool registration and adaptation
boundary: tools belong to the agent contract first, then provider dialects
compile them into external schemas. The toy tool is removed and real built-ins
become the default capability.

## Chapter Checkpoint

Every facet of the tool contract — group composition, runtime metadata, the
provider-visible surface, and path policy — has a matching case, no key
needed:

```bash
npx tsx --test tests/agent-tool-contracts.test.ts
```

Measured output:

```text
✔ tool groups expose current builtin surface (0.729666ms)
✔ current tool definitions declare runtime metadata explicitly (0.151791ms)
✔ provider-visible tools do not include runtime metadata (0.088917ms)
✔ provider-visible editing tools depend on run sandbox mode (0.073125ms)
✔ path access policies enforce current project and allowed roots (0.436ms)
✔ relative path resolution follows the active path policy base (0.142541ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Note the third and fourth cases: they pin down "runtime facts like
annotations, group, and timeout never leak into the provider schema" and
"whether editing tools are exposed depends on the sandbox mode". That is the
contract boundary this chapter is about — tools belong to the agent contract
first, and providers only receive the compiled wire representation.
