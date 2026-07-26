import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 章节有两种形态，侧边栏要同时认：
 *   - 单文件章节：zh/07-jsonl-sessions-and-usage.md
 *   - 分节章节：  zh/06-tool-runtime/{README.md, 01-xxx.md, 02-xxx.md, ...}
 * 重写过程中两种会共存，所以这里按文件系统实际情况生成，不维护手写清单。
 */

type SidebarItem = {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
};

const CHAPTER_PATTERN = /^(\d{2})-(.+?)(\.md)?$/;

/**
 * 取 H1 里"编号之后"的部分作为标题。正文里的 H1 有三种写法，都要认：
 *   "# 第 06 章 · 工具执行前的那道门"
 *   "# 02 · 检查该由谁来做"
 *   "# 07. JSONL sessions 与 usage"
 */
function readTitle(filePath: string): string | undefined {
  const raw = readFileSync(filePath, 'utf8');
  const heading = raw.match(/^#\s+(.+)$/m);

  if (heading === null) {
    return undefined;
  }

  return heading[1]
    .replace(/^第\s*\d+\s*章\s*[·.:：]?\s*/, '')
    .replace(/^\d{1,2}\s*[·.:：]\s*/, '')
    .trim();
}

/** "06 · 工具执行前的那道门" —— 编号前置，方便在侧边栏里扫读 */
function formatChapterLabel(order: string, title: string | undefined): string {
  if (title === undefined || title.length === 0) {
    return order;
  }

  return `${order} · ${title}`;
}

function sectionItems(dir: string, urlBase: string): SidebarItem[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md' && name !== 'index.md')
    .sort();

  return files.map((name) => {
    const order = name.slice(0, 2);
    const title = readTitle(join(dir, name));

    return {
      text: formatChapterLabel(order, title),
      link: `${urlBase}${name.replace(/\.md$/, '')}`,
    };
  });
}

export function buildSidebar(srcDir: string, lang: 'zh' | 'en'): SidebarItem[] {
  const langDir = join(srcDir, lang);
  const overviewText = lang === 'zh' ? '教程说明' : 'Overview';
  const chapterIndexText = lang === 'zh' ? '本章导读' : 'Chapter map';
  const appendixText = lang === 'zh' ? '附录' : 'Appendix';

  const entries = readdirSync(langDir).sort();
  const chapters: SidebarItem[] = [];
  const appendices: SidebarItem[] = [];

  for (const entry of entries) {
    const fullPath = join(langDir, entry);
    const isDirectory = statSync(fullPath).isDirectory();
    const match = entry.match(CHAPTER_PATTERN);

    if (match === null) {
      if (entry.startsWith('appendix') && entry.endsWith('.md')) {
        appendices.push({
          text: readTitle(fullPath) ?? entry,
          link: `/${lang}/${entry.replace(/\.md$/, '')}`,
        });
      }

      continue;
    }

    const order = match[1];

    if (isDirectory) {
      const indexPath = join(fullPath, 'README.md');

      chapters.push({
        text: formatChapterLabel(order, readTitle(indexPath)),
        collapsed: true,
        items: [
          { text: chapterIndexText, link: `/${lang}/${entry}/` },
          ...sectionItems(fullPath, `/${lang}/${entry}/`),
        ],
      });

      continue;
    }

    chapters.push({
      text: formatChapterLabel(order, readTitle(fullPath)),
      link: `/${lang}/${entry.replace(/\.md$/, '')}`,
    });
  }

  const sidebar: SidebarItem[] = [
    { text: overviewText, link: `/${lang}/` },
    ...chapters,
  ];

  if (appendices.length > 0) {
    sidebar.push({ text: appendixText, collapsed: true, items: appendices });
  }

  return sidebar;
}
