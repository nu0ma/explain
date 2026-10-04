// Structure tree: indentation expresses the hierarchy. One root with 2-4 children becomes an org chart; anything else is an indented list with connector lines.
import { mdInline } from '../markdown.ts';
import { ComponentError, fields } from './error.ts';
import { esc } from '../svg/text.ts';
import type { Component } from './types.ts';

export type TreeNode = {
  label: string;
  sub: string;
  hi: boolean;
  indent: number;
  step: number;
  children: TreeNode[];
};

export default {
  name: 'tree',
  summary: '階層ツリー（組織図・字下げリスト）',
  syntax: `\`\`\`tree [list]
根ノード | 副題
  子ノード
    孫ノード | 1 行の説明
  *強調する子ノード
\`\`\`
- 字下げ（空白か Tab）で階層を表す。"ラベル | 説明" で灰色の説明をつける。
- 根が 1 つで子が 2〜4 個 → 組織図。子がもっと多いか引数 list → 字下げリスト。根が複数 → 横に並べる。
- ラベルにはインラインの Markdown を使える（例：\`src/\` ソース）。`,
  example: '```tree\nexplain | 解説 HTML を作る CLI\n  src/\n    `cli.js` 入口\n  test/\n    lint.test.js | STE 検査のテスト\n```',
  tips: `- ディレクトリ、組織、分類のように親子の関係があるものに使う。親子でないつながりはflowで示す。
- 説明に関係する枝だけを残し、ほかは省く。`,
  render(text, { args }) {
    const roots = buildTree(text);
    if (!roots.length) throw new ComponentError('tree にはノードが 1 つ以上必要です', 1);
    const listMode = /\blist\b/.test(args);
    if (roots.length === 1) {
      const [root] = roots;
      const n = root.children.length;
      if (!listMode && n >= 2 && n <= 4) return orgHtml(root);
      return `<div class="am-tree">${rootBox(root, true)}${listHtml(root.children)}</div>`;
    }
    if (!listMode && roots.length <= 4) {
      return `<div class="am-tree"><div class="am-tree-cols am-tree-cols--free" style="--n: ${roots.length}">${roots.map(colHtml).join('')}</div></div>`;
    }
    return `<div class="am-tree">${listHtml(roots)}</div>`;
  },
} satisfies Component;

function buildTree(text: string): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  let step = 0;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.replace(/\t/g, '  ').match(/^ */)?.[0].length ?? 0;
    const node: TreeNode = { ...parseLabel(raw.trim()), indent, step: step++, children: [] };
    while (stack.length && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

function parseLabel(t: string): { label: string; sub: string; hi: boolean } {
  const hi = t.startsWith('*');
  const [label, sub = ''] = fields(hi ? t.slice(1) : t);
  return { label, sub, hi };
}

// When a label starts with inline code followed by more text (e.g. `cli.js` 入口), render the code part as a gray tag.
const labelHtml = (label: string): string => mdInline(label).replace(/^<code>([^<]*)<\/code>(?=\s*\S)/, '<span class="am-tree-tag">$1</span>');

// data-key / data-step are for video: nodes with the same name morph across scenes and appear in source-line order.
const vattrs = (n: TreeNode): string => ` data-key="${esc(n.label)}" data-step="${n.step}"`;

const boxInner = (n: TreeNode): string => `${labelHtml(n.label)}${n.sub ? `<small>${mdInline(n.sub)}</small>` : ''}`;

function rootBox(root: TreeNode, solo = false): string {
  return `<div class="am-tree-root${solo ? ' am-tree-root--solo' : ''}"><div class="am-tree-box am-tree-box--root"${vattrs(root)}>${boxInner(root)}</div></div>`;
}

function colHtml(node: TreeNode): string {
  const children = node.children.length ? listHtml(node.children) : '';
  return `<div class="am-tree-col"><div class="am-tree-box${node.hi ? ' am-tree-box--hi' : ''}"${vattrs(node)}>${boxInner(node)}</div>${children}</div>`;
}

function orgHtml(root: TreeNode): string {
  return `<div class="am-tree">${rootBox(root)}<div class="am-tree-cols" style="--n: ${root.children.length}">${root.children.map(colHtml).join('')}</div></div>`;
}

function listHtml(nodes: TreeNode[]): string {
  return `<ul class="am-tree-list">${nodes.map(liHtml).join('')}</ul>`;
}

function liHtml(n: TreeNode): string {
  const sub = n.sub ? `<span class="am-tree-sub">${mdInline(n.sub)}</span>` : '';
  const kids = n.children.length ? `<ul>${n.children.map(liHtml).join('')}</ul>` : '';
  return `<li${n.hi ? ' class="am-tree-hi"' : ''}${vattrs(n)}><span class="am-tree-label">${labelHtml(n.label)}</span>${sub}${kids}</li>`;
}
