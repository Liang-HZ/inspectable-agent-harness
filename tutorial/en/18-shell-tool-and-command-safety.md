# 18. Shell Tool And Command Safety

This chapter explains the harness's first shell capability: how the `shell`
tool executes commands, how output is truncated, and why it needs a
safe-command classifier that is independent of tool annotations.

After reading this chapter, you should understand:

- why shell was the most important capability gap after the file tools
- how Codex CLI and Claude Code draw their shell safety boundaries
- what the safe-command classifier allows, rejects, and why it is
  deliberately conservative
- how a tool-level permission override composes with the generic
  permission decision
- how timeout, output truncation, and kill semantics keep shell from
  dragging down the runtime

## Background

Before this capability, the model only had `ls`/`find`/`grep`/`read` plus
`write`/`edit`. But many actions in real coding tasks only exist behind a
shell: `git status`, `git diff`, `wc -l`, running tests, installing
dependencies.

Both reference systems treat shell as a core tool:

- Codex CLI's `shell` tool combines a sandbox policy (`read-only` /
  `workspace-write` / `danger-full-access`) with an approval policy
  (`untrusted` / `on-failure` / `on-request` / `never`). Known-safe
  read-only commands such as `ls`, `cat`, and `git status` auto-approve
  even under the strictest policy.
- Claude Code's `Bash` tool has a timeout ceiling, output truncation, and
  permission rules (prefix-matched allowlists) that decide which commands
  skip approval.

This project adopts the same layering at teaching size: one `shell` tool,
one testable classifier, one tool-level override boundary.

## Tool Contract

`lib/agent-shell-builtins.ts` defines the `shell` tool:

```text
command    Required. Command string executed with bash -c
workdir    Optional. Relative paths resolve from the project root under path policy
timeoutMs  Optional. Between 1000 and 60000, default 10000
```

Runtime metadata:

```text
group:          shell_builtins
category:       shell
annotations:    readOnly=false, destructive=true, openWorld=true
executionMode:  sequential
timeoutMs:      60000 (hard runtime ceiling)
pathAccess:     current_project
```

The two timeout layers are intentional: the definition-level
`timeoutMs: 60000` is the hard ceiling the runtime enforces, while the
model-supplied `timeoutMs` is a per-call soft timeout implemented inside
the tool, which kills the child process when it fires. The model can ask
for more time for slow commands but can never push past the runtime
ceiling.

## The Safe-Command Classifier

`lib/agent-shell-safety.ts` answers one question: does this command match a
known read-only pattern?

Its output is a two-value decision:

```text
safe          Known read-only pattern, can auto-approve
needs_review  Cannot prove read-only, hand back to the approval policy
```

Classification order:

1. Any shell control construct is immediately `needs_review`: `;`, `&&`,
   `||`, `&`, `>`, `<`, backticks, `$`, newlines. The classifier does not
   analyze bash semantics, so it refuses to analyze these constructs.
2. The command splits into pipeline segments on `|`, and every segment must
   be safe on its own. `grep -c export lib/agent.ts | cat` is safe;
   `cat a.txt | sh` is not.
3. Each segment is tokenized by a quote-aware mini tokenizer. Backslash
   escapes or an unterminated quote are `needs_review`.
4. `argv[0]` must be in the read-only command allowlist: `ls`, `cat`,
   `grep`, `rg`, `head`, `tail`, `wc`, `find`, `git`, and so on.
5. Two commands get extra argument checks: `find` rejects action flags like
   `-delete`/`-exec`; `git` only allows read-only subcommands such as
   `status`/`log`/`diff`/`show`, and `git branch` only in bare listing
   form.

The key tradeoff: **the classifier prefers false negatives over false
positives**. `echo $HOME` is harmless, but `$` is rejected, because
allowing variable expansion means analyzing what it expands into. The cost
of being conservative is one extra approval; the cost of a false positive
is executing an unapproved arbitrary command.

This mirrors Codex's `is_known_safe_command`: allowlist exact patterns,
route everything else through approval.

## Tool-Level Permission Override

The generic permission decision (`decideAgentToolPermission`) only looks at
annotations and policy; it never parses tool arguments. But shell risk
lives entirely inside the arguments — `ls` and `rm -rf` look identical at
the annotations layer.

So the tool contract gained an optional boundary:

```ts
decidePermission?: (
  argumentsJson: string,
  policy: AgentRunPolicy,
) => AgentPermissionDecision | undefined;
```

The composition rule lives in `agent-tool-runtime.ts`:

```text
1. Run the generic decision first
2. A generic deny is final (path policy and read-only write denials
   cannot be overturned by a tool)
3. Otherwise, if the tool override returns a decision, use it, with the
   decision source marked tool_override
4. If the override returns undefined, fall back to the generic decision
```

The shell override logic:

```text
command missing or empty   -> deny VALIDATION_ERROR
classifier says safe       -> allow (tool_override)
classifier says needs_review:
  sandboxMode read_only    -> deny PERMISSION_DENIED
  other sandbox modes      -> undefined, fall back to generic policy
```

After falling back, `approvalPolicy: never` allows the call, and the other
policies land on `ask` because of the destructive/openWorld annotations.

This changes capability in an important way: **shell is now visible in
read-only runs**. Previously the whole `shell_builtins` group was hidden in
read-only mode; now the model can run `git log` in the most conservative
mode, while every non-allowlisted command is denied at the permission
boundary.

## Permission Behavior Matrix

| Command | Sandbox | Approval | Result |
| --- | --- | --- | --- |
| `git status` | any | any | allow (tool_override) |
| `npm test` | read_only | any | deny (read-only run) |
| `npm test` | workspace_write | never | allow (policy) |
| `npm test` | workspace_write | on_request/strict | ask -> still fails closed |
| `pwd` with escaping workdir | any | any | deny (path policy, not overridable) |

The `ask` branch still throws `AgentApprovalRequiredError` — interactive
approval/resume is the next chapter's topic.

## Execution Semantics

`bash -c` starts the child process with stdin ignored (no interactivity,
an intentional boundary).

Output is collected per stream with two caps:

```text
10240 chars
256 lines
```

Exceeding either cap truncates the stream and flags it, and the
model-visible output ends with a `[stdout truncated to ...]` notice.

For comparison, current Codex captures up to a 1 MiB hard cap, merges
stdout/stderr into one stream, applies **middle truncation** (keep head and
tail, cut the middle) against a per-model budget, and reports the total
line count when truncated. Claude Code defaults to 30000 characters and
newer versions persist the full output to disk, returning only a file path
plus preview. This project takes the simplest teaching version: per-stream,
head-preserving truncation. Middle truncation and persist-to-disk are
recorded follow-ups (see `docs/research-codex-claude-code.md`).

There are three completion paths:

- Normal exit: the exit code (including non-zero) is presented to the
  model as a **success output**. A failing command is information the model
  needs, not a runtime error.
- Per-call timeout: the child is killed and a `TIMEOUT` error returns with
  the tail of the partial output, so the model knows how far the command
  got.
- Run-level abort: the runtime abort signal triggers the same kill path.

What the model sees:

```text
Command: git status
Workdir: .
Exit code: 0 (34ms)

stdout:
On branch feat/agent-usable-v1
...

stderr:
(empty)
```

## What Is Still Missing

- **No OS-level sandbox.** Under workspace_write + never, unsafe commands
  execute directly on your machine. Codex enforces with Seatbelt on macOS
  and Landlock on Linux; this project's only enforcement layer today is
  the permission boundary itself.
- **No PTY / interactive sessions.** stdin is ignored, so `vim` or `top`
  hang until the timeout.
- **No background execution.** Long commands can only raise `timeoutMs`.
- **The ask branch still fails closed.** The next chapter fixes that.

## Which Tests Prove It

`tests/agent-shell-builtins.test.ts`:

- a representative command matrix for safe/needs_review classification
- read-only runs: safe commands allowed, unsafe commands denied
- workspace_write + on_request: unsafe commands throw approval required
- workdir escapes denied by path policy (not overridable)
- non-zero exit codes as normal output, oversized output truncation, and
  `sleep 30` killed at a 1-second timeout
- empty command returns VALIDATION_ERROR at the permission boundary

## Chapter Summary

The core of the shell capability is not `spawn` but the composition of
three boundaries: an argument-aware safe-command classifier, a permission
composition rule where deny is final, and resource boundaries of
timeout/truncation/kill. Together they turn "give the model a shell" from
reckless into auditable.
