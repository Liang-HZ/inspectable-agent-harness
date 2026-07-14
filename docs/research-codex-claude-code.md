# 调研笔记:Codex CLI 与 Claude Code 的 harness 机制

本文档是 2026-07 对 openai/codex 源码(main 分支)与 Claude Code 官方文档的调研摘要,
作为本项目 shell / approval / resume / compaction 各阶段的设计参照。教程章节引用这里的
结论时,以本文为准。

## 1. Shell/exec 工具

### Codex CLI(codex-rs)

当前默认工具 `shell_command`,参数已从早期 `command: string[]` 数组演化为单个字符串:

| 参数 | 说明 |
| --- | --- |
| `command` (required) | 用户默认 shell 执行的脚本字符串 |
| `workdir` | 默认 turn cwd;description 要求 "Always set the workdir param... Do not use cd" |
| `timeout_ms` | 默认 10000ms |
| `login` | login shell 语义,默认 true |
| `sandbox_permissions` | `use_default` / `with_additional_permissions` / `require_escalated` |
| `justification` | 配合 escalation,作为呈现给用户的批准问句 |
| `prefix_rule` | 批准后可复用的命令前缀,如 `["git","pull"]` |

另有交互式 `exec_command` + `write_stdin`(PTY 会话、`yield_time_ms`、
`max_output_tokens` 默认 10000 tokens、structured output_schema)。

输出处理:采集侧硬上限 1 MiB;stdout/stderr **合并流**;呈现给模型前按 per-model
TruncationPolicy(bytes 或 tokens)做**中间截断**(保头保尾砍中间)。给模型的格式:

```text
Exit code: {exit_code}
Wall time: {duration_seconds} seconds
Total output lines: {total_lines}   <- 仅截断时出现
Output:
{truncated_output}
```

### Claude Code Bash

参数 `command` / `description` / `timeout` / `run_in_background`。timeout 默认
120000ms、上限 600000ms(env 可调)。输出默认 30000 字符截断;新版本超限会把完整
输出落盘、给模型返回文件路径 + 预览。工作目录跨调用持久,shell 状态不持久。

## 2. 命令安全分类与 approval

### Codex 双轴

- **AskForApproval**: `untrusted` / `on-failure`(弃用) / `on-request`(默认) / `never`
- **SandboxPolicy**: `read-only` / `workspace-write`(cwd+TMPDIR+/tmp 可写,`.git/` 例外只读)
  / `danger-full-access` / `external-sandbox`
- sandbox 决定"技术上能做什么",approval 决定"何时问人";判定结果三值:
  `AutoApprove { sandbox_type }` / `AskUser` / `Reject { reason }`

**known-safe 白名单**(`is_safe_command.rs`):

- 无条件安全:`cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat tail tr true uname uniq wc which whoami`
- 条件安全:`find`(排除 `-exec/-delete/...`)、`rg`(排除 `--pre/-z/...`)、
  `git`(仅 `status|log|diff|show|branch` 且排除危险选项)、`sed`(仅 `sed -n Np`)、
  `base64`(排除 `-o`)
- 复合命令:解析 `bash -lc` 脚本,仅当全部子命令安全且操作符无副作用(`&& || ; |`)时整体安全
- 用户可扩展 execpolicy,批准时可持久化前缀规则(ExecPolicyAmendment)

### Claude Code

- 模式:`default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`
  (bypass 仍有 `rm -rf /` circuit breaker)
- 规则:`permissions.allow/deny/ask` 数组,判定顺序固定 **deny → ask → allow**;
  `Bash(npm run test *)` 前缀通配;复合命令按 `&& || ; |` 拆分后**每段都必须匹配**;
  匹配前剥 wrapper(`timeout nice nohup ...`)
- 内置只读白名单(不可配置):`ls cat echo pwd head tail grep find wc which diff stat du cd` + 只读 git
- 任一层 deny 不可被其他层 allow 覆盖

## 3. Approval 暂停/恢复

### Codex

1. 工具 runtime 判需批准 → `session.request_command_approval(...)`
2. 创建 oneshot channel,以 approval_id(=call_id)插入 `pending_approvals` map
3. 发 `ExecApprovalRequest` 事件后 **await 在 channel 上**(该 tool future 挂起,
   其他并行 tool 不受影响)
4. 用户提交 `Op::ExecApproval { id, decision }` → 取出 channel 发送决策
5. `ReviewDecision`: `Approved` / `ApprovedForSession`(session 内同 key 免问)/
   `ApprovedExecpolicyAmendment` / `Denied`(default)/ `TimedOut` / `Abort`(终止 turn)
6. **拒绝时给模型的 function_call_output 就是 `"rejected by user"`**;超时为
   `"approval request timed out"`。Denied 让模型换路,Abort 终止 turn
7. **pending 状态不落盘**——批准是 turn 内存状态,进程死了等于拒绝

### Claude Code

- SDK 形态:`canUseTool(toolName, input) => {behavior: "allow"|"deny", updatedInput?, message?}`
- 拒绝时 tool_result 是 `is_error: true` + "The user doesn't want to proceed with this
  tool use. The tool use was rejected (eg. if it was a file edit, the new_string was
  NOT written to the file)."
- 用户拒绝附言会成为新的 user message
- 同样不持久化 pending;"don't ask again" 写入 settings.local.json

**结论**:pending approval = 内存里 `Map<callId, resolver>` + 挂起的 Promise;
关键不变量是**拒绝也必须产出一条合法 tool output**(维持 call/output 配对),
文案要引导模型"换路走而不是重试"。

## 4. Session replay / resume

### Codex rollout

- `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{uuid}.jsonl`,每行 `{timestamp, item}`
- `RolloutItem`: `SessionMeta` / `ResponseItem`(模型可见条目)/ `Compacted` /
  `TurnContext`(每 turn 的 model/approval/sandbox 快照)/ `EventMsg`(仅元信息类)
- resume:读全部 items → **反向找最近 `Compacted` 检查点** → 从该点起用后续
  ResponseItem 重建模型历史 → 回放 TurnContext 恢复策略
- **模型状态不保存,resume = 用 transcript 重建 prompt**;瞬态事件(delta)不持久化

### Claude Code

- `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`,parentUuid 链
- `--continue` 最近会话 / `--resume [id]` / `--fork-session`
- 恢复即整个消息历史重灌;只记对话不记文件系统状态

## 5. Context compaction

### Claude Code

- 触发:约 92% context window 减 ~13K buffer;连续 3 次失败即停用 auto-compact
- **Microcompact**(不调模型):把陈旧大块 tool_result 卸载,tool_use 保留、
  result 替换为占位——轻量保配对
- **Full compact**:调模型生成 9 段式 summary 替换全部旧历史;compaction 后恢复
  最近 5 个文件内容、todo list、continuation message

### Codex

- 触发:token usage 超 per-model `model_auto_compact_token_limit`;支持 mid-turn compaction
- 重建历史 = **完全替换**:`initial_context + 最近原始 user messages(20K token 预算,逆序回填)+ 一条 user 角色 summary 消息`
- rollout 写 `Compacted` 检查点,resume 从检查点重建
- **配对不变量**(normalize 层):orphan output 删除;缺 output 的 call 插入
  synthetic output(UUIDv5 稳定派生保 prompt cache);逐条裁剪时连带删除配对另一半

**结论**:实现顺序建议——① normalize 层兜底(orphan 删除 + missing output 合成);
② compaction 全量替换(initial context + 尾部 user messages + summary);
③ 持久化 `Compacted` 检查点,resume 从检查点向后重放。

## Sources

- openai/codex 源码:`core/src/tools/handlers/shell_spec.rs`、`core/src/exec.rs`、
  `shell-command/src/command_safety/is_safe_command.rs`、`core/src/session/mod.rs`、
  `core/src/tools/approvals.rs`、`core/src/compact.rs`、
  `core/src/context_manager/{normalize,history}.rs`、`protocol/src/protocol.rs`
- Codex docs: agent-approvals-security、concepts/sandboxing
- Claude Code docs: permissions、tools-reference、sessions
- DeepWiki openai/codex: command execution pipeline、rollout persistence、session resumption
