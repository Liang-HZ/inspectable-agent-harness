# 00. 环境准备与第一次跑通

本章只做一件事：让你在自己的机器上，把这个项目从 `git clone` 走到"第一次看到 agent 在界面上流式跑完一个任务"。

后面的 22 章讲的都是设计：边界为什么这么切、取舍为什么这么做。但对跨行读者来说，真正的第一道坎往往不是设计，而是环境——Node 版本不对、API key 不知道去哪拿、base URL 少了个 `/v1`、`rg` 没装。这些问题每一个都能耗掉一晚上，而且和 agent 本身毫无关系。本章把它们一次性清掉。

如果你已经是熟练的 Node/Next.js 开发者，本章可以十分钟扫完，重点看 [API key 的三条路径](#api-key三条路径与费用预期)和[常见故障排查](#常见故障排查)两节。

读完本章后，你应该：

- 装好 Node.js、git、ripgrep 三个前置软件
- 拿到一个能用的 OpenAI 兼容 API key，并清楚它大概花多少钱
- 配好 `.env.local`，理解每个变量的作用
- 在界面上跑通一次 Chat 调用和一次 Agent 流式调用
- 用 curl 直接调过 `/api/chat` 和 `/api/agent/stream`，见过原始响应长什么样
- 跑通 `npm test` 和 `npm run typecheck`，确认环境完整

## 前置软件

### Node.js 20 LTS 或更高

本项目用 Next.js 16，要求 Node.js 20.9 以上。推荐直接装 22 LTS。

macOS 推荐用 nvm 管理版本(以后切版本不用重装)：

```bash
# 安装 nvm(命令以 https://github.com/nvm-sh/nvm 官方 README 为准)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash

# 重开终端后：
nvm install --lts
nvm use --lts
```

Windows 可以用官网安装包(https://nodejs.org 选 LTS)，或用 winget：

```powershell
winget install OpenJS.NodeJS.LTS
```

也可以用 nvm-windows(https://github.com/coreybutler/nvm-windows)，效果和 macOS 的 nvm 类似。

验证：

```bash
node -v    # 应该输出 v20.9 以上或 v22.x
npm -v
```

### git

macOS 自带(第一次运行 `git` 会提示装 Xcode Command Line Tools)；Windows 装 Git for Windows(https://git-scm.com)，它附带的 Git Bash 也是后面跑 curl 命令的推荐环境。

### ripgrep(容易被忽略，但必须装)

这是最容易漏掉的一个。本项目 agent 的 `grep` 工具不是自己实现的文本搜索，而是直接调用本地的 `rg` 命令(见 `lib/agent-builtins.ts` 里的 `runRipgrep`)。如果机器上没有 `rg`，`grep` 工具每次执行都会失败，模型会收到这样的错误：

```text
Error [EXECUTION_ERROR]: ripgrep (rg) is required for grep but was not found: spawn rg ENOENT
```

注意这是一个 model-visible 错误——它不会让整个 run 崩掉，模型会看到这条错误然后尝试换别的工具。所以症状很隐蔽：agent 还能跑，只是搜索类任务变笨了。装上就好：

```bash
# macOS
brew install ripgrep

# Windows
winget install BurntSushi.ripgrep.MSVC

# Debian / Ubuntu
sudo apt install ripgrep
```

验证：

```bash
rg --version
```

## 获取代码与安装依赖

```bash
git clone <你拿到的仓库地址>
cd <仓库目录>
npm install
```

`npm install` 会按 `package-lock.json` 装一百三十多个包(Next.js、React、OpenAI SDK、Zod，以及 TypeScript 工具链)，网络正常时一两分钟内完成。对比 Java/Python 的心智模型：`package.json` 相当于 `pom.xml`/`pyproject.toml`，`package-lock.json` 相当于锁定精确版本的 lockfile，`node_modules/` 是装在项目目录里的本地依赖(不是全局的)。

## API key：三条路径与费用预期

这个项目调用的是"OpenAI 兼容"的 Chat Completions API——这是一个事实上的行业标准，OpenAI 定义了 wire 格式，大量其他厂商照着实现。所以你不一定需要 OpenAI 官方的 key，任何兼容 provider 都能跑。三条路径按推荐顺序：

### 路径 A：OpenAI 官方

在 https://platform.openai.com 注册、绑卡、创建 API key。优点是兼容性零问题(它就是标准本身)；缺点是需要国际信用卡，且国内网络不可直连。

费用量级：本教程默认的 `gpt-4o-mini` 大约是每百万输入 token 零点几美元、每百万输出 token 一美元以内的量级。跑完全部教程的实验，通常花不到几美元。具体价格以 https://openai.com/pricing 为准。

### 路径 B：国内可直连的 OpenAI 兼容 provider(推荐国内读者)

这些厂商的 API 实现了 OpenAI Chat Completions 的 wire 格式，注册门槛低、支持国内支付、网络直连。配置时只需要换 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 三个值：

| Provider | `OPENAI_BASE_URL` 形态 | 说明 |
| --- | --- | --- |
| DeepSeek 官方 | `https://api.deepseek.com/v1` | 模型如 `deepseek-chat`。价格是个位数人民币每百万 token 的量级。 |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | 聚合平台，一个 key 可以调 Qwen、DeepSeek 等多家模型，部分小模型免费。 |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 注意必须用 `compatible-mode` 这个路径才是 OpenAI 兼容形态。模型如 `qwen-plus`，新用户通常有免费额度。 |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | 模型 id 以官网文档为准。 |

价格都在变，上表只给量级感受，**一切以各家官网为准**。

两个必须注意的点：

1. **选的模型必须支持 tool calling(function calling)。** 上面列的默认模型都支持，但如果你换了别的模型 id，先查该模型文档确认。Chat 模式不依赖 tool calling，但 agent 的整个循环建立在模型能发起 `tool_calls` 之上——不支持的模型跑 agent 会直接退化成"只会说话不会动手"。
2. **`OPENAI_WIRE_API` 保持 `openai-chat-completions`。** 本项目支持两种 wire 协议(见第 8 章的 provider dialect boundary)，其中 `openai-responses` 是 OpenAI 官方的 Responses API 语义，绝大多数兼容 provider 并没有实现它。用兼容 provider 时，`openai-chat-completions` 是正确且唯一的选择。

### 路径 C：中转/代理站(谨慎)

网上有大量"API 中转站"，声称低价转售 OpenAI 官方模型。风险你需要知道：key 和请求内容都经过第三方(不要发任何敏感数据)；宣称的模型可能被偷换成便宜模型；预付费余额可能随时跑路。本教程是学习项目，请求内容没什么敏感的，但如果你用中转站，把它当成随时会失效的消耗品，不要充大额。

## 配置 .env.local

```bash
cp .env.example .env.local
```

`.env.local` 被 git 忽略，key 不会被提交。四个变量逐个说：

```bash
OPENAI_API_KEY=sk-your-api-key
```

你的 API key。这是唯一没有默认值的变量：缺了它，服务端会在第一次调模型时返回错误 `Missing OPENAI_API_KEY in environment variables.`(见 `lib/env.ts`)。

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
```

API 的基础地址，默认指向 OpenAI 官方。用兼容 provider 时换成上表里的地址。**注意 `/v1` 后缀**——OpenAI SDK 会在这个地址后面拼 `/chat/completions`，大多数 provider 要求完整路径是 `.../v1/chat/completions`，少了 `/v1` 的典型症状是 404(排查表里有)。

```bash
OPENAI_MODEL=gpt-4o-mini
```

模型 id。用兼容 provider 时换成该 provider 的模型 id(如 `deepseek-chat`、`qwen-plus`)。建议显式填写，不要依赖代码里的 fallback。

```bash
OPENAI_WIRE_API=openai-chat-completions
```

wire 协议选择：`openai-chat-completions` 或 `openai-responses`。如上所述，除非你用 OpenAI 官方且明确想试 Responses API，否则保持 `openai-chat-completions`。

改过 `.env.local` 之后，重启 `npm run dev` 最稳妥——环境变量是在服务端读取的。

## 第一次跑通：界面

```bash
npm run dev
```

终端会输出本地地址，打开：

```text
http://localhost:3000
```

你会看到一个三栏的工作台(workbench)：

- **左侧 rail**：品牌区("Next.js API Workbench / Agent Harness")、Agent/Chat 模式切换、当前 run 的状态卡片(状态徽章、模型名、run id)。Agent 模式下这里还有 Sessions 列表——现在是空的，跑过之后会出现历史 session。
- **中间 transcript 栏**：上方是对话/结果区，下方是 composer(请求表单)。
- **右侧 Inspector**：Agent 模式下有 Debug/Audit/Session 三个 tab，展示运行时事件、权限决策和持久化的 session 记录。这是这个项目"可检查性"哲学的主要载体，后面第 14 章会专门讲。

### 先跑一次 Chat(验证 key 和 base URL)

页面默认在 Agent 模式。先点左侧的 **Chat** 切过去——Chat 是一次不带工具的裸模型调用，链路最短，最适合验证配置。

在中间下方的 Message 输入框里随便写一句话，点 **Call model**。几秒后中间出现模型回复，右侧 Inspector 显示这次调用的详细信息。如果这一步报错，先去[排查表](#常见故障排查)对症状。

### 再跑一次 Agent(第一次看到流式和工具)

切回 **Agent** 模式。在 Task 输入框里给一个需要动手的任务，比如：

```text
帮我找出当前项目里 agent 工具注册相关的文件，并解释它们的关系。
```

(Task 下面折叠着 Goal、Context、模型和权限策略的设置，现在全部保持默认即可。)

点 **Run agent**。这次和 Chat 不同，你会看到过程：

- 左侧状态徽章变成流光效果的 "Running"，运行中 composer 旁边出现 **Stop** 按钮(可以中途取消)
- 中间 transcript 里，工具调用以折叠条目的形式逐个出现(`ls`、`grep`、`read`……)，等待模型输出时有 "Thinking…" 指示器
- 模型的最终回答一个 token 一个 token 地流出来
- 右侧 Inspector 的 Debug tab 里，原始运行时事件(modelRequested、toolStarted、toolFinished……)实时滚动

跑完后，左侧 Sessions 列表里会出现这个 session——它已经被持久化成了 JSONL 文件(第 7 章)，Inspector 的 Session tab 可以直接查看。

看到这一幕，你就已经见过这本教程要拆解的全部东西了：流式(第 5、10 章)、工具(第 12 章)、事件(第 5 章)、session(第 7、20 章)、inspector(第 14 章)。后面 22 章就是解释这一幕背后的每一条边界。

## 第一次跑通：curl

界面背后是两个普通的 HTTP 路由，用 curl 直接打一遍，能建立"前端只是消费者"的直觉。以下命令来自仓库根 `README.md`，可直接复制(Windows 读者建议在 Git Bash 里跑，cmd 的引号规则会破坏 JSON)。

先调 `/api/chat`：

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"用一句话解释一下 TypeScript 为什么适合写后端。"}'
```

预期返回一个带显式判别字段的 JSON：

```json
{
  "ok": true,
  "result": {
    "model": "gpt-4o-mini",
    "content": "...",
    "usage": null
  }
}
```

再调流式的 `/api/agent/stream`(注意 `-N`，它让 curl 不缓冲输出，事件到达就打印)：

```bash
curl -N -X POST http://localhost:3000/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "帮我找出当前项目里 agent 工具注册相关的文件，并解释它们的关系。",
    "goal": "请使用本地文件探索工具完成，不要只凭记忆回答。",
    "temperature": 0
  }'
```

这次不是一个 JSON，而是一串 Server-Sent Events：每个事件一行 `data: {...}`，后跟一个空行。你会看到类似这样的流(内容截断)：

```text
data: {"type":"debug","event":{"type":"runStarted","runId":"...","sessionId":"...", ...}}

data: {"type":"step","step":{...}}

data: {"type":"debug","event":{"type":"toolStarted","toolName":"grep", ...}}

data: {"type":"assistantDelta","delta":"这几"}

data: {"type":"assistantDelta","delta":"个文件"}

data: {"type":"done","result":{...}}
```

`step` 是进度、`assistantDelta` 是最终回答的文本增量、`done` 携带完整结果、出错时是 `error`。SSE 这个协议本身，[附录](appendix-prerequisites.md)第 4 座桥有专门讲解。

请求非法时的错误形状也统一：

```json
{
  "ok": false,
  "error": "Request body validation failed."
}
```

## 健康检查

两条命令，确认环境完整。都不需要 API key——测试是确定性的，不调真实 provider(为什么能做到，见第 11 章)：

```bash
npm test
```

预期最后几行：

```text
ℹ tests 103
ℹ pass 103
ℹ fail 0
```

```bash
npm run typecheck
```

`tsc --noEmit` 全量类型检查，**没有任何输出就是通过**。这两条命令以后每章改完代码都值得跑一遍。

## 常见故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 调用报 `Missing OPENAI_API_KEY in environment variables.` | 没有 `.env.local`，或 key 为空，或改了没重启 dev server | 确认 `cp .env.example .env.local` 且填了 key，重启 `npm run dev` |
| 报 404，或 provider 返回 HTML 而不是 JSON | `OPENAI_BASE_URL` 少了 `/v1`(或多了别的路径) | 对照上文表格检查完整 base URL，SDK 会在其后拼 `/chat/completions` |
| agent 里 `grep` 工具反复报 `Error [EXECUTION_ERROR]: ripgrep (rg) is required for grep but was not found: spawn rg ENOENT` | 本机没装 ripgrep | `brew install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` / `sudo apt install ripgrep`，然后重启 dev server |
| `npm run dev` 说 3000 端口被占用 | 有别的进程占着 3000 | Next.js 会自动换一个端口并在终端打印实际地址，照着打开即可；或用 `lsof -i :3000`(macOS/Linux)找到占用进程 |
| curl 报 `Request body must be valid JSON.` | JSON 被 shell 的引号规则破坏(常见于 Windows cmd) | 换 Git Bash 或 PowerShell，保持单引号包 JSON、内部用双引号 |
| Chat 正常但 agent 只输出文字、从不调用工具 | 所选模型不支持 tool calling | 换一个明确支持 function calling 的模型 id |
| 401 / Unauthorized | key 填错、过期，或 key 和 base URL 不属于同一家 provider | 确认三个变量来自同一家 provider |

## 本章小结

环境这一层没有任何设计可言，但它决定你能不能开始。现在你有了：能跑的 Node 工具链、能调的模型、跑通过的界面和 curl，以及两条随时可以确认"我没弄坏东西"的健康检查命令。

从[第 1 章](01-project-starting-point.md)开始进入正题：这个项目为什么从一个刻意最小的 API 路径起步。读正文的过程中，凡是遇到 TypeScript、Zod、SSE 这类概念断层，随时回[附录：前置知识桥](appendix-prerequisites.md)。
