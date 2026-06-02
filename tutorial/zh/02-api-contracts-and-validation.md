# 02. API Contract 与 Validation

本章说明项目如何把 HTTP 输入、运行时配置和前端响应处理稳定下来。Agent 还没有真正复杂之前，先把 API contract 做清楚，可以避免后续所有能力都建立在模糊输入上。

读完本章后，应该理解：

- request body 为什么必须先从 `unknown` 解析成业务对象
- Zod 为什么放在 DTO 边界，而不是散落在 service 中
- validation error 为什么要同时有稳定摘要和结构化字段错误
- 前端为什么也要解析 response discriminant

## 背景

`/api/chat` 出现以后，下一个问题不是模型智能，而是边界可信度。

HTTP request body 是 `unknown`。环境变量可能缺失。前端 `fetch` 回来的 JSON 也不可信。如果这些 shape 不在边界校验，TypeScript 就只是装饰。

## 本章构建了什么

项目为这些边界建立 contract：

- request input parsing
- validation error shape
- server model config
- frontend response parsing
- shared API types

重要文件：

```text
lib/chat-input.ts
lib/chat-api-types.ts
lib/chat-api-client.ts
lib/env.ts
app/api/chat/route.ts
```

## Zod 在 DTO 边界

Request parser 在边界使用 Zod，并返回 discriminated result。Service 永远不看 raw request JSON。

Route flow：

```text
request.json()
  -> parseChatInput(unknown)
  -> ChatInput
  -> callChatModel(...)
```

这个模式后来也成为 agent input parser 的模板。

## 结构化 validation errors

项目不把所有 validation 问题压成一句话。

API response 有：

```ts
{
  ok: false,
  error: 'Request body validation failed.',
  validationErrors: {
    formErrors: string[],
    fieldErrors: { ... }
  }
}
```

这比让 client 解析自然语言 error 更稳定。

## 环境配置

`lib/env.ts` 会 trim env vars，并把空字符串当成缺失。

这很重要，因为 `.env.local` 错误很常见。Config boundary 应该在模型调用前清晰失败。

当前变量包括：

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_WIRE_API
```

`OPENAI_WIRE_API` 是后面 model gateway 支持 Chat Completions / Responses dialect 后出现的。

## 前端 response parsing

Browser client 不盲信 `fetch(...).json()`。它会把 response parse 成 shared API types 后再交给 React。

当 streaming agent route 引入更多 event shape 后，这个模式变得更重要。

## 取舍

项目接受一些 boilerplate，换来：

- 可靠 type narrowing
- 可预测 API error shape
- 更容易协调前后端
- 更安全的未来 agent input

这是学习型 repo。看见边界本身就是目标的一部分。

## 验证

这一层通过这些方式验证：

```bash
npm run typecheck
npm run build
```

以及直接 API probe：

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","temperature":0}'
```

## 它如何为 agent 做准备

Agent route 后来复用了这些经验：

- 先 parse
- service 接收 plain input
- 显式 result discriminant
- validation errors 保持结构化
- framework object 留在 route boundary

## 常见误解

### 误解一：validation 只是为了防止接口报错

Validation 更重要的作用是固定边界语义。Agent endpoint 会接受更多字段，如果输入边界不稳定，provider、tool、session 层都会被迫处理脏数据。

### 误解二：错误信息只需要一个字符串

单个字符串适合人类读，但不适合前端定位字段。`validationErrors` 让 UI 能显示具体字段错误，也让测试可以断言稳定结构。

### 误解三：前端可以完全相信后端返回

前端仍然应该解析 response discriminant。这样 backend 改错或代理层返回异常 shape 时，UI 不会静默进入错误状态。

## 本章小结

这一章把 API contract 固定下来：route 只处理 HTTP，parser 处理不可信输入，env 层处理配置，service 只看 typed input，前端按 discriminant 解析结果。这套规则后来直接复用到 agent API。
