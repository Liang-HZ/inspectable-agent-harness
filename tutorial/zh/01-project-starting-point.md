# 01. 项目起点与约束

本章从项目最小可运行形态开始。目标不是先写一个完整 agent，而是先建立一个可读、可测、可继续扩展的 Next.js 后端边界。

读完本章后，应该理解三件事：

- 为什么项目从普通模型 API 开始，而不是直接进入 agent loop
- 为什么代码被拆成 route、input、env、client、service 几层
- 为什么这个 repo 刻意选择显式、朴素、容易检查的 TypeScript 写法

## 起始目标

项目的第一步很小：

```text
写一个 Next.js + TypeScript 后端。
提供一个能调用 OpenAI 兼容接口的模型 API。
模型、baseURL、apiKey 都从配置读取。
代码结构要足够清楚，方便后续扩展成 agent。
```

这个目标看起来普通，但它决定了后续架构的性格：先把边界做清楚，再逐步增加能力。

这里的“OpenAI 兼容接口”不是指只支持 OpenAI 官方服务，而是指使用 OpenAI SDK 的 Chat Completions 调用形状，并允许通过 `OPENAI_BASE_URL` 接入兼容实现。

## 核心文件

第一版稳定后端由几个很小的文件组成：

```text
app/api/chat/route.ts
lib/chat-input.ts
lib/env.ts
lib/openai-compatible-client.ts
lib/chat.ts
```

它们对应一条很朴素的服务端链路：

```text
HTTP request
  -> route handler
  -> request body validation
  -> environment config
  -> OpenAI-compatible client
  -> model call service
  -> JSON response
```

这条链路后来变复杂了，但基本边界没有变。`/api/agent`、streaming route、provider adapter、tool runtime 都是在这套边界上继续长出来的。

## 分层规则

项目采用接近传统后端的职责划分：

```text
Controller       -> app/api/.../route.ts
DTO / parsing    -> lib/*-input.ts
Config           -> lib/env.ts
Client           -> lib/*-client.ts
Service          -> lib/*.ts
```

这不是为了形式化分层，而是为了防止后续 agent 逻辑全部堆进一个文件。

### Route handler 只做 HTTP 边界

`route.ts` 负责：

- 读取 `NextRequest`
- 解析 JSON
- 调用 input parser
- 调用 service
- 返回 `NextResponse.json(...)`

它不负责：

- 组织 prompt
- 创建模型 client
- 执行工具
- 解析 provider stream
- 写 session 文件

这样做的结果是：HTTP 框架类型不会污染业务层。service 层只接收普通 TypeScript 对象。

### Input parser 负责不可信输入

来自 HTTP request 的 body 是 `unknown`。它必须先通过 parser 变成明确的业务输入。

项目早期就采用这种结果形状：

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

这种写法比直接抛异常更啰嗦，但好处是边界非常清楚：输入要么变成可用对象，要么变成明确的错误响应。

### Config 层负责环境变量

`lib/env.ts` 读取 server-only 环境变量：

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
```

它负责 trim、默认值、缺失配置错误。业务层不直接读 `process.env`，这样后续测试和 provider 切换都会简单很多。

## 代码风格

这个 repo 在学习阶段偏好显式对象字段：

```ts
return {
  ok: true,
  result: result,
};
```

它比 shorthand 更长：

```ts
return { ok: true, result };
```

但显式写法更适合教学和审阅。读者能直接看到 API response 的 shape，而不用在变量名和字段名之间做额外推断。

这种风格后来也影响了 agent runtime：

- event 使用显式 `type`
- response item 使用显式 discriminant
- tool result 区分内部 metadata 和模型可见文本
- provider dialect 把外部格式转换为内部稳定格式

## Git 证据

仓库第一个提交是：

```text
75be406 Add Next.js model and agent backend
```

它加入了 Next.js app layout、`/api/chat`、OpenAI-compatible client、env handling、README，以及最早的 agent 文件。

这说明项目从第一步开始就不是一个纯聊天 demo，而是一个会继续演化成 agent harness 的后端学习项目。

## 常见误解

### 误解一：第一章只是普通 API 教程

第一章确实只有普通 API，但它建立的是后续 agent 的承重结构。后面的工具执行、流式输出、session 记录和调试页面，都依赖这里的边界纪律。

### 误解二：显式写法只是代码风格

显式写法不是审美问题，而是可检查性问题。Agent runtime 会有很多中间对象，如果这些对象的 shape 不清楚，调试会很快变困难。

### 误解三：一开始就应该抽象 provider

项目没有一开始就做 provider dialect。因为第一阶段只需要证明：HTTP 边界、配置读取、OpenAI-compatible 调用和返回格式是干净的。等 Chat Completions 与 Responses 的差异真实出现后，再抽象 provider boundary 更稳。

## 本章小结

第一章建立的是项目的地基：

- route handler 保持薄
- input validation 留在边界
- env 读取集中管理
- SDK client 独立创建
- service 接收普通对象
- response shape 显式可读

后续所有 agent 能力都沿着这条线继续生长，而不是推翻重来。

## 本章验证点

验证地基三件事：类型边界干净、全量测试绿、起点提交与正文一致。以下命令都不需要 API key。

1. 类型检查，脚本横幅之后无任何输出即通过：

```bash
npm run typecheck
```

2. 全量测试，实测尾部输出（截取）：

```bash
npm test
```

```text
ℹ tests 103
ℹ pass 103
ℹ fail 0
```

3. 确认仓库第一个提交：

```bash
git log --reverse --oneline | head -1
```

实测输出：`75be406 Add Next.js model and agent backend`，与本章 Git 证据一致。
