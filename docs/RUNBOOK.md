# RUNBOOK · inspectable-agent-harness

本仓库有两份产物：

1. **agent harness 本体**（Next.js 应用 + `lib/` 运行时 + `tests/`）——只在本地跑，不部署。
2. **教程站**（`tutorial/` 下的 Markdown + VitePress）——部署在 `learn.liangai.org`。

本文只覆盖第 2 项，因为只有它有线上形态。

---

## 一、架构一页

```text
tutorial/                     教程正文（真源，GitHub 上直接可读）
├── zh/                       中文，站点 /zh/
│   ├── README.md             教程说明（站点上是 /zh/ 首页）
│   ├── 06-tool-runtime/      分节章节：README.md + 01-xx.md ...
│   └── 07-xxx.md             单文件章节（重写中，两种形态共存）
├── en/                       英文，站点 /en/
├── index.md                  站点首页（hero）
└── .vitepress/
    ├── config.mts            站点配置：双语、导航、搜索、链接改写
    ├── sidebar.mts           扫描文件系统生成侧边栏，两种章节形态都认
    └── dist/                 构建产物（gitignore）
```

约定：

- **章节目录文件叫 `README.md` 而不是 `index.md`**，这样在 GitHub 上点进文件夹能直接读到。站点侧由 `config.mts` 的 `rewrites` 映射成目录首页。
- **正文里指向仓库其他目录的相对链接**（`../../docs/`、`../../tests/`）在站点上不存在，构建时由 `rewriteRepoLinks` 改写成 GitHub 绝对地址。源文件保持相对路径，GitHub 上直接读也是通的。
- **侧边栏不手写**。`sidebar.mts` 扫 `tutorial/zh` 与 `tutorial/en`，`NN-xxx.md` 当单文件章节、`NN-xxx/` 当分节章节。新增章节不需要改配置。

## 二、部署路径与 CI 触发

| 项 | 值 |
| --- | --- |
| 平台 | Cloudflare Pages |
| Pages 项目名 | `learn-liangai` |
| Cloudflare Account ID | `fe15c2c6bceaa6066bce8cb02965b896` |
| 自定义域名 | `learn.liangai.org` |
| 触发条件 | push 到 `master` 且改动命中 `tutorial/**`、`package.json`、`package-lock.json`、workflow 自身 |
| 手动触发 | GitHub Actions → 部署教程站 → Run workflow |
| workflow | `.github/workflows/deploy-tutorial.yml` |

本地预览：

```bash
npm run docs:dev       # http://localhost:5173
npm run docs:build     # 产物在 tutorial/.vitepress/dist
npm run docs:preview
```

## 三、secrets 清单

| 名称 | 用途 | 备注 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | wrangler 部署 Pages | **按仓库隔离**，别的仓库配过不等于这里有。必须是 API Token（Bearer），不是 Global API Key |

查看与设置：

```bash
gh secret list -R Liang-HZ/inspectable-agent-harness
gh secret set CLOUDFLARE_API_TOKEN -R Liang-HZ/inspectable-agent-harness
```

secret 只写不可读，任何人（包括 agent）都拿不出已有仓库里的值，只能从 Cloudflare 面板重新取或新签一个。

## 四、首次上线需要人做的三件事

CI 和站点代码就绪之后，还有三步只能在面板/终端里由人完成：

1. **建 Pages 项目**：Cloudflare → Workers & Pages → Create → Pages → 项目名必须是 `learn-liangai`（与 workflow 里 `--project-name` 一致）。
2. **绑定自定义域名**：项目 → Custom domains → 加 `learn.liangai.org`。Cloudflare 会新增一条显式 CNAME 压过 `*.liangai.org` 泛解析，**泛解析记录保留不动**（analytics 依赖它）。绑定后、首次部署前访问返回 **522 是正常的**。
3. **设仓库 secret**：`gh secret set CLOUDFLARE_API_TOKEN -R Liang-HZ/inspectable-agent-harness`。

三步做完，在 Actions 里手动跑一次 workflow_dispatch 即可上线。

## 五、冒烟与回滚

**冒烟**（不要只看 HTTP 状态码）：

```bash
curl -s https://learn.liangai.org/zh/ | grep -q "Inspectable Agent Harness" && echo OK || echo "不是教程站"
```

`*.liangai.org` 有泛解析指向 Oracle，而那台机器的 nginx 把 Umami 当默认站点。**没配记录的子域名返回的是 Umami 登录页，状态码同样是 200**。所以断言必须落在本站独有内容上。

判断是不是"压根没配记录"：

```bash
curl -s https://definitely-does-not-exist-9x7q.liangai.org | grep -o '<title>[^<]*</title>'
```

如果它也返回 Umami，说明你查的子域名多半只是没加记录。

**回滚**：Cloudflare Pages 面板 → 项目 → Deployments → 选上一次成功的部署 → Rollback。教程站是纯静态，回滚无副作用。

## 六、常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| workflow 报 `it's necessary to set a CLOUDFLARE_API_TOKEN` | 仓库 secret 没设，值是空的 | `gh secret set CLOUDFLARE_API_TOKEN -R Liang-HZ/inspectable-agent-harness` |
| `Authentication failed (status: 400) [code: 9106]` | 存成了 Global API Key，不是 API Token | 到 Cloudflare 面板签一个带 Pages 部署权限的 API Token 重新设 |
| 访问 `learn.liangai.org` 看到 Umami 登录页 | custom domain 没绑定，命中泛解析 | 到 Pages 项目里绑定自定义域名 |
| 绑定后返回 522 | 域名已切到 Pages 项目，但项目里还没有部署 | 手动触发一次 workflow |
| 构建报 dead link | 教程里新增了指向仓库外的相对链接 | 用 `../../` 前缀（会被自动改写成 GitHub 链接），或改成绝对 URL |
| 侧边栏少了新章节 | 目录命名不符合 `NN-xxx` | 章节目录/文件必须两位数字编号开头 |

## 七、恢复演练

教程站无状态、无数据库，真源是 Git 仓库本身。演练方式：

```bash
git clone https://github.com/Liang-HZ/inspectable-agent-harness.git /tmp/harness-restore
cd /tmp/harness-restore && npm ci && npm run docs:build
```

构建产物能出来，就说明站点可以从零重建。Cloudflare Pages 项目丢失时，按第四节重新建项目、绑域名、跑一次 workflow 即可。
