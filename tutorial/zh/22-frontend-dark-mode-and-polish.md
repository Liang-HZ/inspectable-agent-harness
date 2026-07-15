# 22. 前端 Dark Mode 与页面打磨

本章和前面几章性质不同——它不引入新的 runtime 能力，而是回过头把已经存在的几个前端页面(Agent 工作台、Debug/Audit/Session 面板、Chat 模式)打磨成一致、可用的状态，并补上一个此前完全缺失的基础能力：dark mode。

读完本章后，应该理解：

- 为什么一个"能跑"的 CSS 文件不代表可以安全加 dark mode
- 语义化 CSS 变量和"哪个颜色该转换"之间的取舍
- 三类容易被自动化脚本漏掉的颜色声明，以及为什么它们最危险
- 为什么这里选择遵循系统偏好，而不是做一个手动切换开关
- 打磨前端时，"逐页截图验证"比"看代码" 更可靠

## 背景

到第 21 章为止，后端的四个深层缺口(shell、approval resume、session resume、compaction)都已经补齐，并且每一个都配了教程和测试。前端这边，`app/globals.css` 从项目最早期开始积累，已经长到 2500 多行，包含 3 次为不同断点重新定义的同一批组件样式，以及超过 150 种十六进制颜色值——其中很多只出现一次，是不同阶段迭代时留下的细微色差，而不是一套干净的设计令牌。

这个项目从来没有 dark mode。用浏览器的 `prefers-color-scheme: dark` 打开页面，看到的还是完全相同的浅色界面。对一个对标 Codex/Claude Code 的开发者工具来说，这是一个明显的完成度缺口。

## 设计选择

### 语义化变量，而不是逐组件重写

不去重写每一个组件的样式，而是在 `:root` 里定义一组语义化 CSS 自定义属性：

```text
--page-bg / --surface / --surface-tint      背景层级
--border / --border-strong                  边框
--text-strong / --text-primary /
--text-secondary / --text-muted             文字层级
--accent / --accent-hover / --accent-text /
--accent-tint-bg / --accent-tint-border /
--accent-contrast                           主题色及其变体
--danger / --warning / --success 三组         状态色(各含 text/border/bg)
```

`:root` 里是浅色默认值，`@media (prefers-color-scheme: dark) { :root { ... } }` 里是对应的深色值。这个结构本身很直接——难点不在于设计变量，而在于**把已经存在的硬编码颜色值安全地替换成这些变量，同时不能破坏浅色模式**。

### 用脚本做高频颜色的机械转换

2500 行、150+ 种颜色不可能靠手工一一核对。先跑一次频率统计，发现颜色分布极不均匀：`#ffffff` 单独出现 45 次，`#d8e1e4` 系列的边框色出现 30+ 次，几个核心文字色各出现 5-13 次——这些高频颜色构成了页面的骨架。用 Python 脚本对这些颜色做精确的字符串替换(不是模糊匹配，是对每个具体的十六进制值做一对一映射到对应变量)，一次性转换了 165 处。

这一步是安全的，因为：

- 只替换值，不改变声明结构
- 每个替换都有明确的语义映射(不是"猜"这个颜色应该变浅还是变深)
- 转换后立即跑 `npm run build`，让 Turbopack 的 CSS 解析器验证语法没有被破坏

### 三类脚本会漏掉的颜色声明

第一轮转换完成后，在真实浏览器里用 `prefers-color-scheme: dark` 渲染页面，发现好几处标题文字完全消失——白色文字叠在没有变暗的浅色卡片背景上。逐个排查后，归纳出脚本漏掉的三类模式：

**跨行的 `background` 声明。** 例如：

```css
.conversationScroll {
  background:
    linear-gradient(
      180deg,
      rgba(255, 254, 250, 1),
      rgba(255, 254, 250, 0) 180px
    ),
    #fffefa;
  padding: 34px 44px;
}
```

脚本按行扫描，只在包含字面量 `background` 关键字的那一行找颜色——但这条声明跨了 6 行，颜色值分布在没有 `background` 字样的行上，全部被漏掉。修复方式是直接把这类装饰性渐变简化成纯色 `var(--surface)`，而不是费力保留原有的渐变结构。

**`rgba(...)` 字面量，而不是十六进制。** 很多"玻璃质感"的卡片头(`.conversationHeader`、`.inspectorHeader`)背景用的是 `rgba(255, 254, 250, 0.96)` 这样的半透明白色叠加，不是 `#fffefa`。脚本的正则只匹配 `#RRGGBB`，天然不会碰这些值。

**渐变叠加在已转换的纯色之上。** `.focusReadyPanel`("AGENT READY" 卡片)的背景是：

```css
background:
  linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(247, 249, 241, 0.9)),
  var(--surface);
```

`var(--surface)` 那部分已经正确变暗了，但上面还叠着一层白色渐变，视觉上依然是浅色——这解释了为什么浏览器里看到的是"背景变暗了一点，但还是很亮"而不是"完全没变"。

这三类问题的共同点是：它们都不是"颜色转换错了"，而是"颜色转换根本没发生"，而且都必须**在真实浏览器里渲染出来看**才能发现——单靠读 CSS 源码很容易漏掉多行声明和渐变叠加的组合效果。

### 收尾：一个统一的 dark-mode override block

与其在源文件里到处追着修每一处 `rgba`/多行声明，不如在文件末尾加一个集中的 `@media (prefers-color-scheme: dark)` block，列出所有已知问题选择器，强制它们使用纯色变量并清空 `background-image`:

```css
@media (prefers-color-scheme: dark) {
  .conversationHeader,
  .inspectorHeader,
  .composerDock,
  .sidebarNotice,
  .conversationScroll {
    background: var(--surface);
    background-image: none;
  }

  .focusReadyPanel,
  .sidebarRunCard {
    background: var(--surface);
    background-image: none;
  }
  /* ... */
}
```

这个 block 故意放在文件**最后**——CSS 里同优先级的规则按源码顺序生效，而这个项目里同一个类名经常在不同的响应式断点 block 里被重新定义好几次。放在最后，不用去追踪某个视口宽度下到底是哪一份定义在生效，新规则总能赢。

这是一个务实的选择：与其为每一处渐变精确设计一个深色版本，不如在深色模式下直接去掉装饰性的玻璃质感渐变，换成纯色背景。视觉上更简单，但换来的是可维护性和确定性。

### 为什么没有手动切换开关

这个项目现在只响应 `prefers-color-scheme`，没有加一个"浅色/深色"按钮。原因很直接：加开关意味着要在 `layout.tsx` 里塞一段"绘制前读 localStorage，避免闪烁"的脚本，在组件里接状态和持久化逻辑，再补 UI——这些都是新的功能面，而"跟随系统设置"已经覆盖了用户实际需要的核心场景(操作系统里配了深色模式，这个工具就该是深色的)，且实现和维护成本低一个数量级。这和 "not the priority" 的定位是一致的：先把缺失的能力(响应系统偏好)补齐，不是必须做的锦上添花(手动开关)先不做。

## 其他两处修复

**Chat 模式下不该看到 "Sessions" 侧栏。** `SessionRail` 组件展示的是 agent session 列表和"继续这个 session"的入口——这些概念只在 Agent 模式下有意义，Chat 模式(直接调用模型，不走 session store)显示它纯属误导。修复是一行条件渲染：`{state.mode === 'agent' ? <SessionRail ... /> : null}`。

**`color: var(--surface)` 被误用为高对比度文字色。** 有 5 处地方(`.primaryButton`、`.approveButton`、`.activeModeButton` 等)用白色文字搭配深色/主题色背景，写法是 `color: #ffffff`。脚本按值转换时，这些 `#ffffff` 和"面板背景"用的是同一个值，被一起转成了 `var(--surface)`。这是语义冲突而不是转换错误——`#ffffff` 在这几处的真实含义是"文字要跟按钮背景形成对比"，不是"这是一块面板"。深色模式下 `--surface` 变暗后，这些按钮的文字会跟着变成暗色，导致按钮文字消失。修复是引入专门的 `--accent-contrast` 变量(浅色模式下是白色，深色模式下是接近黑色)，把这 5 处 `color: var(--surface)` 改成 `color: var(--accent-contrast)`。

## Transcript 工具展示与 shimmer 指示器

后续一轮打磨改了 transcript 里工具执行的呈现方式，对标 Codex/Claude Code 的折叠格式。

**工具名从原始标识符改成动作短语。** 之前每个工具卡片直接显示原始工具名(`read`、`grep`、`shell`)，对读者没有信息量。现在 `toolActionLabel(toolName, argumentsJson)` 从参数里提取关键信息拼成人类可读的动作短语：`read {path:"lib/agent.ts"}` → "Read lib/agent.ts",`shell {command:"git status"}` → "Ran git status",`grep {pattern:"..."}` → "Searched for ...";没有可提取参数时退回泛化短语("Ran a command")。标签用英文，与参考截图和整个应用保持一致。

**单工具直接展示，多工具折叠成组。** 一次模型输出后如果只调用了一个工具，summary 直接显示那个工具的动作短语("Ran git status ›")，展开即是它的 Input/Result;如果调用了多个，summary 显示 "Used N tools"，展开后是每个工具的嵌套 `<details>`(缩略动作短语)，再展开才是单个工具的详情。这正是参考截图里"两次文本输出之间的工具折叠成一组、展开是缩略、再展开是详情"的三层结构。

**"运行中"状态用渐变 shimmer 文字。** 新增一个 `.shimmerText` 类：多色渐变(teal → cyan → 亮色高光)裁剪到文字上(`background-clip: text` + `color: transparent`)，只动画 `background-position`，做出一条彩色光带不断扫过文字的循环效果。应用在三处：header 和 sidebar 的 "Running" 徽章、transcript 里等待模型输出时的 "Thinking…" 指示器。shimmer 颜色也走 CSS 变量，深色模式下用更亮的青色。加了 `prefers-reduced-motion: reduce` 守卫，尊重"减少动态效果"的系统设置时关闭动画。

## 逐页验证

没有依赖代码审查判断"应该没问题了"，而是在真实浏览器里(通过 `resize_window` 的 `colorScheme` 参数模拟系统深色模式)逐个检查了：

```text
Agent 工作台(composer + transcript + 三个 inspector tab: Debug/Audit/Session)
Chat 模式(消息 + 结果 + inspector)
Approval 卡片(用临时注入的假状态渲染,验证后还原)
Compaction 卡片(同上)
移动端窄屏布局(390px 宽度)
```

每一处都截图确认文字可读、背景层级正确、状态色(危险红/警告黄/成功绿)在深色背景下依然清晰。这个过程直接推翻了"脚本跑完就该没问题了"的假设——第一轮机械转换后，浏览器截图立刻暴露了标题文字消失的问题，如果只看 CSS 源码去判断"变量都替换了应该没事"，这类跨行声明和渐变叠加的问题会被完全放过。

## 还没做什么

- **约 145 处低频装饰颜色仍是硬编码。** 主要是阴影(`rgba(31, 48, 42, 0.08)` 这类极低透明度的投影)和小面积装饰元素(状态圆点、次要图标)，深色模式下会保持原有色值。这些不影响可读性，只是深色模式下的阴影/光晕效果不如浅色模式下精细。
- **没有手动主题切换开关**，原因见上文。
- **`.jsonBlock`/`.debugTextBlock` 等"终端风格"深色代码块没有做深色模式适配。** 它们设计上就是深色背景配浅绿色文字，在浅色页面里本来就是故意突出的"暗色终端"观感；在深色页面里视觉上会自然融入，不需要额外处理。
- **没有对比度审计工具集成。** 所有颜色搭配是靠人工截图检查确认的，没有跑自动化的 WCAG 对比度检测。

## 本章小结

前端打磨这一章没有新的架构决策，核心是一个纪律问题：大规模颜色替换看起来像是可以完全自动化的机械工作，但真正的风险藏在自动化脚本的假设边界之外——多行声明、rgba 字面量、语义重复使用同一个颜色值。工具能做完 90% 的转换，但最后 10%(也是最容易造成"文字看不见"这种用户直接会遇到的 bug 的部分)必须靠在真实浏览器里逐页看，而不是相信 diff 看起来是对的。

## 本章验证点

本章的能力是纯前端的，验证方式是界面操作，不需要 key（打开页面不需要模型，只有真正跑任务才需要）：

1. 启动 dev server（`npx next dev -p 3102`），浏览器打开 `http://localhost:3102`。
2. 切换系统外观：macOS 在系统设置 → 外观里切换浅色/深色；或者用浏览器 DevTools 模拟——Chrome 的 Rendering 面板里把 `prefers-color-scheme` 强制为 `dark`。页面应该不需要刷新就整体切换。
3. 深色模式下重点看本章修过的位置：页面标题和卡片头的文字必须可读（不能出现"白字叠浅色背景"）；主按钮（Send/Approve 这类）的文字必须和按钮背景有对比；Chat 模式下左侧不应该出现 Sessions 侧栏。
4. 系统设置里开启"减弱动态效果"（macOS：辅助功能 → 显示），确认 Running 徽章的 shimmer 动画停止——这是 `prefers-reduced-motion` 守卫在生效。

预期现象：两种外观下所有文字可读、背景层级清晰、危险红/警告黄/成功绿三组状态色都保持可辨。如果发现某个角落还是浅色——那可能就是本章"还没做什么"里说的约 145 处低频装饰颜色之一，属于已声明的边界而不是回归。
