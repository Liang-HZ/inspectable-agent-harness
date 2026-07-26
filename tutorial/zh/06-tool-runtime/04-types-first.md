← 上一节：[03 · 判断写成一个纯函数](03-where-it-goes.md) · [章目录](README.md) · 下一节：05 · 把执行搬出主循环

# 04 · 把三样信息写成类型

第 02 节说检查函数要三样信息，第 03 节说它是个纯函数、信息都靠参数传进去。

那就有一件事必须先做：**把这三样信息写成类型**。写完它们，这个函数的输入就定死了。

先写类型再写逻辑，还有个额外好处：类型定下来之后编译器会开始报错，指出哪里还没接上。那些报错就是接下来几节的待办清单。

下面四个类型都写在新文件 `lib/agent-permissions.ts` 里。

## 第一样：工具是什么性质

第 02 节列的四件事，逐条对应一个字段：

```ts
export type AgentToolAnnotations = {
  readOnly?: boolean;      // 只读，不改任何东西
  destructive?: boolean;   // 会造成不可逆的后果
  openWorld?: boolean;     // 会访问外部世界，比如发网络请求
  idempotent?: boolean;    // 同样的调用做两次，结果和做一次一样
};
```

`read_file` 的声明是：只读，不破坏，不访问外部世界，可重复。

这里有个刻意的缺席，值得停一下：**没有 `allowed` 字段，也没有 `requiresApproval` 字段。**

原因是第 02 节讲过的：这四件事只跟工具本身有关，换到哪个项目、哪个用户、哪次运行都成立。而"能不能执行"取决于工具之外的东西。

如果把 `requiresApproval: true` 写进工具，等于把一个会变的结论固化进了不变的地方。到第 24 章加沙箱模式时，你会发现每个工具的这个字段都要重新判断一遍。

**工具只声明自己是什么，不声明自己能不能被执行。**

## 第二样：这次调用要碰什么

这类信息不需要新类型，它就是模型填进来的参数，加上解析之后的结果。第 09 节把它和其他信息拼在一起时会看到具体字段。

这里只记一件事：路径要保留两份，**模型填的原始值**和**解析后的绝对路径**。第 02 节说过原因，`../../etc/hosts` 看起来像项目内的相对路径，解析完在项目外。

## 第三样：这次运行的规矩

第 02 节说这类信息至少有两个维度，写成类型就是：

```ts
export type AgentApprovalPolicy = 'strict' | 'on_request' | 'never';

export type AgentSandboxMode =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';

export type AgentRunPolicy = {
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
};
```

`approvalPolicy` 管要不要问人：`strict` 是能问就问，`on_request` 是有需要才问，`never` 是从不问。

`sandboxMode` 管能碰多少：`read_only` 只能读，`workspace_write` 可以改工作区，`danger_full_access` 不设限。

两个维度分开，是因为它们的组合都有实际意义。"可以改文件但每次都问一下"用得上，"只能读且不打扰你"也用得上。合成一个枚举的话，这些组合就表达不出来了。

## 输出：判断的结果

输入齐了，还差输出。判断的结果有三种：

```ts
export type AgentPermissionDecision =
  | { type: 'allow'; source: AgentPermissionDecisionSource; reason: string }
  | { type: 'ask';   source: AgentPermissionDecisionSource; reason: string }
  | {
      type: 'deny';
      source: AgentPermissionDecisionSource;
      errorCode: AgentToolErrorCode;
      reason: string;
    };
```

允许执行、需要问人、拒绝执行。

注意 `deny` 比另外两个多一个字段 `errorCode`。这不是随手加的。

被拒绝的调用，结果要回传给模型（第 14 节会讲为什么必须回传）。模型拿到之后要决定下一步怎么办：换一个路径重试？还是告诉用户这件事做不了？

这个决定需要一个明确的代号。只给一句人话理由不够用，因为那等于让模型靠猜句子来分辨情况。

`allow` 和 `ask` 不需要代号，它们的下一步在代码里已经写死了。

## 还要记录是谁做的决定

三种结果都带一个 `source` 字段：

```ts
export type AgentPermissionDecisionSource =
  | 'annotation'      // 根据工具自己的声明得出
  | 'policy'          // 根据这次运行的规矩得出
  | 'tool_override'   // 工具自带的特殊判断
  | 'hook'            // 外部挂进来的钩子
  | 'user'            // 人做的决定
  | 'guardian';       // 更高一层的守卫
```

先说为什么需要它。

设想一个具体场景：有人报告 agent 拒绝了一个本该允许的操作。如果只记了"被拒绝了"，你得从头复现才知道原因。如果记了来源，方向立刻就有了——来源是 `annotation`，说明工具的声明写错了；来源是 `policy`，说明这次运行的模式设得太严。

再说为什么现在就写六个。

这一章只会用到前两个，后面四个是空位。空着也先写出来，是因为它们决定了后面章节接线接在哪：第 19 章的人工审批接 `user`，第 24 章沙箱给出的结论算 `policy`。

先留好位置，比以后发现枚举不够用、再回头改所有用到的地方省事。

## 让编译器给你列清单

四个类型写完，保存，跑：

```bash
npm run typecheck
```

会看到报错，大意是：工具定义里没有 `annotations` 这个字段；没有任何地方产出 `AgentPermissionDecision`。

这些报错是对的，它们就是接下来几节的任务：

- 第 07 节：给工具加上 `annotations`
- 第 08 节：定下这次运行的默认规矩
- 第 09 节：把三样信息拼成一个请求对象
- 第 11 节：写出产出 `AgentPermissionDecision` 的那个纯函数

## 本节小结

- 三个输入类型对应第 02 节列的三样信息，一个输出类型描述判断结果。
- 工具的四个标注只说"是什么"，不说"能不能"，因为前者不变、后者会变。
- 只有拒绝需要带错误代号，因为模型要靠它决定下一步。
- 决定来源现在只用两个，另外四个是给后面章节留的接线位。
- 类型写完，编译器的报错就是接下来几节的待办清单。

下一节我们把工具执行从主循环里搬出来。那一步只搬家，不改任何行为。

---

← 上一节：[03 · 判断写成一个纯函数](03-where-it-goes.md) · [章目录](README.md) · 下一节：05 · 把执行搬出主循环
