---
layout: home

hero:
  name: Inspectable Agent Harness
  text: 把 coding agent 拆开给你看
  tagline: 从裸 OpenAI 兼容 API 起步，不用任何框架，一步步建出一个可检查的 agent 运行时。25 章中英双语，每章都能自己跑起来验证。
  actions:
    - theme: brand
      text: 开始读（中文）
      link: /zh/
    - theme: alt
      text: Read in English
      link: /en/
    - theme: alt
      text: GitHub 源码
      link: https://github.com/Liang-HZ/inspectable-agent-harness

features:
  - title: 从一次 API 调用开始
    details: 不依赖 LangChain，不依赖任何 agent SDK。第一章只有一个 HTTP 路由，最后一章有流式循环、工具契约、权限策略、审批恢复、上下文压缩和 OS 级沙箱。
  - title: 每一步都能自己验证
    details: 每章末尾都有可以动手跑的验证点，多数不需要 API key。141 个确定性测试离线可跑，教程里的结论都能在代码里对上。
  - title: 讲的是判断，不是源码导览
    details: 每处边界都交代当时可选的做法、为什么选这个、代价是什么。第 23 章直接列出与生产级 harness（Codex CLI / Claude Code）的差距总表。
---
