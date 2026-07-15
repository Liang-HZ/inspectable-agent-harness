# 12. Real Read-Only Tools

This chapter explains why the project removes toy capability and adds real
read-only project exploration tools. A coding agent needs to work against real
repositories, not a custom demo function.

After reading this chapter, you should understand:

- what `ls`, `find`, `grep`, and `read` each provide
- why dedicated read-only tools come before shell
- how path policy affects file access
- why output limits and debug details are separate

## Background

The toy tool proved tool mechanics, but it could not make the agent useful.

A coding agent needs to explore the local project. The first real tool surface
became read-only file exploration.

## Tool Set

Current active built-ins:

```text
ls      list directory entries
find    find files by pattern
grep    search file contents with ripgrep
read    read UTF-8 text with line pagination
```

The implementation now lives in:

```text
lib/agent-builtins.ts
```

The original committed version used `lib/agent-workspace-tools.ts`; that file
was later removed when the tool contract boundary was renamed and generalized.

## Why Not Shell First

Shell is powerful, but it raises hard problems:

- process sandboxing
- command approval
- destructive commands
- output streaming and truncation
- long-running sessions
- cancellation of process trees

The read-only tools gave the agent real usefulness while postponing those
risks.

## Path Policy

Current tools use:

```text
current_project
```

The path policy code lives in:

```text
lib/agent-path-policy.ts
```

Relative paths resolve from the project root. Paths outside the allowed root
become model-visible tool errors.

## Output Limits

Tools do not dump unbounded output into history.

Examples:

- `read` supports `offset` and `limit`
- `grep` has match limits and byte limits
- `find` and `ls` return deterministic bounded lists
- notices tell the model how to continue

This is important because tool output enters model-visible history.

## Model-Facing vs Debug Details

The model sees compact text.

The debug UI can see structured details.

That split is essential: the model should not have to parse internal JSON, but
humans need enough structure to inspect what happened.

## Tests

`tests/agent-builtins.test.ts` covers:

- file content and line metadata
- path escape rejection
- pagination notices
- strict-mode `null` optional arguments
- real `rg` execution
- deterministic `find` and `ls`
- timeout and abort behavior through the runtime

## Git Evidence

Relevant commit:

```text
0b1c88f Add workspace read tools
```

A later evolution renamed the layer from workspace tools to built-in
read-only tools and removed the toy tool: the name no longer implies
"workspace only", and access scope is decided entirely by path policy.

## Common Misunderstandings

### Misunderstanding 1: Shell Makes Dedicated Tools Unnecessary

Shell is flexible, but harder to control for permissions, truncation, output
format, and safety. Dedicated read-only tools provide stable, structured,
lower-risk exploration first.

### Misunderstanding 2: Read/Grep Naturally Mean Workspace-Only

Tool names should not define access scope. Access scope belongs to path policy,
such as current project, allowed roots, or danger full access.

### Misunderstanding 3: Tool Output Should Always Be Complete

Model context is limited. Tools should return useful bounded text, and when
truncated, provide actionable continuation hints.

## Chapter Summary

This chapter moves the agent from toy tools to real file exploration: dedicated
read-only tools provide controlled capability, path policy manages access, and
output formatting serves both model readability and debug inspection.
