import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildSidebar } from './sidebar.mts';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/Liang-HZ/inspectable-agent-harness';

/**
 * 教程正文里指向仓库其他目录的相对链接（../../docs/、../../tests/）在站点上不存在，
 * 构建时改写成 GitHub 上的绝对地址。源文件保持相对链接，这样在 GitHub 上直接读也是通的。
 */
function rewriteRepoLinks(md: any): void {
  const defaultRender =
    md.renderer.rules.link_open ??
    ((tokens: any, idx: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (
    tokens: any,
    idx: number,
    options: any,
    env: any,
    self: any,
  ) => {
    const hrefIndex = tokens[idx].attrIndex('href');

    if (hrefIndex >= 0) {
      const href = tokens[idx].attrs[hrefIndex][1] as string;

      if (href.startsWith('../../')) {
        tokens[idx].attrs[hrefIndex][1] = `${REPO}/blob/master/${href.replace(/^\.\.\/\.\.\//, '')}`;
        tokens[idx].attrPush(['target', '_blank']);
        tokens[idx].attrPush(['rel', 'noreferrer']);
      }
    }

    return defaultRender(tokens, idx, options, env, self);
  };
}

export default withMermaid(
  defineConfig({
    srcDir,
    outDir: resolve(srcDir, '.vitepress/dist'),
    cleanUrls: true,
    lastUpdated: true,
    title: 'Inspectable Agent Harness',
    description:
      '从裸 OpenAI 兼容 API 起步，从零构建一个 coding agent 运行时。25 章中英双语教程。',

    // 章节目录在仓库里叫 README.md（GitHub 直接可读），站点上当成目录首页
    rewrites: {
      ':lang/README.md': ':lang/index.md',
      ':lang/:chapter/README.md': ':lang/:chapter/index.md',
    },

    // 正文里指向仓库其他目录的链接由 rewriteRepoLinks 改写，不参与死链检查
    ignoreDeadLinks: [/^\.\.\/\.\.\//],

    markdown: {
      lineNumbers: false,
      config: rewriteRepoLinks,
    },

    themeConfig: {
      socialLinks: [{ icon: 'github', link: REPO }],
      search: {
        provider: 'local',
        options: {
          locales: {
            zh: {
              translations: {
                button: { buttonText: '搜索教程', buttonAriaLabel: '搜索教程' },
                modal: {
                  noResultsText: '没有找到相关内容',
                  resetButtonTitle: '清除',
                  footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
                },
              },
            },
          },
        },
      },
    },

    locales: {
      zh: {
        label: '中文',
        lang: 'zh-Hans',
        link: '/zh/',
        themeConfig: {
          nav: [
            { text: '教程', link: '/zh/' },
            { text: '源码', link: REPO },
            { text: 'liangai.org', link: 'https://liangai.org/agent-harness' },
          ],
          sidebar: { '/zh/': buildSidebar(srcDir, 'zh') },
          outline: { level: [2, 3], label: '本页内容' },
          docFooter: { prev: '上一节', next: '下一节' },
          editLink: {
            pattern: `${REPO}/edit/master/tutorial/:path`,
            text: '在 GitHub 上编辑本页',
          },
          lastUpdatedText: '最后更新',
          returnToTopLabel: '回到顶部',
          darkModeSwitchLabel: '主题',
          footer: {
            message: 'MIT 开源 · 教程与代码同仓维护',
            copyright: `<a href="${REPO}">github.com/Liang-HZ/inspectable-agent-harness</a>`,
          },
        },
      },

      en: {
        label: 'English',
        lang: 'en-US',
        link: '/en/',
        themeConfig: {
          nav: [
            { text: 'Tutorial', link: '/en/' },
            { text: 'Source', link: REPO },
            { text: 'liangai.org', link: 'https://liangai.org/en/agent-harness' },
          ],
          sidebar: { '/en/': buildSidebar(srcDir, 'en') },
          outline: { level: [2, 3], label: 'On this page' },
          editLink: {
            pattern: `${REPO}/edit/master/tutorial/:path`,
            text: 'Edit this page on GitHub',
          },
          footer: {
            message: 'MIT licensed · tutorial and code live in the same repo',
            copyright: `<a href="${REPO}">github.com/Liang-HZ/inspectable-agent-harness</a>`,
          },
        },
      },
    },
  }),
);
