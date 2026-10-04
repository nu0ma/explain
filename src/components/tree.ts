// 構造ツリー：字下げで階層を表す。根が 1 つで子が 2〜4 個なら組織図、それ以外は線つきの字下げリストで描く。
import { mdInline } from '../markdown.ts';
import { ComponentError, fields } from './error.ts';
import { esc } from '../svg/text.ts';

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
  example: '```tree\nexplain-cli | 解説 HTML を作る CLI\n  src/\n    `cli.js` 入口\n  test/\n    lint.test.js | STE 検査のテスト\n```',
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
};

function buildTree(text) {
  const roots = [];
  const stack = [];
  let step = 0;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.replace(/\t/g, '  ').match(/^ */)[0].length;
    const node = { ...parseLabel(raw.trim()), indent, step: step++, children: [] };
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    (stack.length ? stack.at(-1).children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

function parseLabel(t) {
  const hi = t.startsWith('*');
  const [label, sub = ''] = fields(hi ? t.slice(1) : t);
  return { label, sub, hi };
}

// ラベルがインラインコードで始まり後ろに文字が続くとき（例：`cli.js` 入口）、コード部分を灰色の番号ラベルにする。
const labelHtml = (label) => mdInline(label).replace(/^<code>([^<]*)<\/code>(?=\s*\S)/, '<span class="am-tree-tag">$1</span>');

// data-key / data-step は動画で使う。同じ名前のノードは場面をまたいで変形し、ソースの行ごとに順に現れる。
const vattrs = (n) => ` data-key="${esc(n.label)}" data-step="${n.step}"`;

const boxInner = (n) => `${labelHtml(n.label)}${n.sub ? `<small>${mdInline(n.sub)}</small>` : ''}`;

function rootBox(root, solo = false) {
  return `<div class="am-tree-root${solo ? ' am-tree-root--solo' : ''}"><div class="am-tree-box am-tree-box--root"${vattrs(root)}>${boxInner(root)}</div></div>`;
}

function colHtml(node) {
  const children = node.children.length ? listHtml(node.children) : '';
  return `<div class="am-tree-col"><div class="am-tree-box${node.hi ? ' am-tree-box--hi' : ''}"${vattrs(node)}>${boxInner(node)}</div>${children}</div>`;
}

function orgHtml(root) {
  return `<div class="am-tree">${rootBox(root)}<div class="am-tree-cols" style="--n: ${root.children.length}">${root.children.map(colHtml).join('')}</div></div>`;
}

function listHtml(nodes) {
  return `<ul class="am-tree-list">${nodes.map(liHtml).join('')}</ul>`;
}

function liHtml(n) {
  const sub = n.sub ? `<span class="am-tree-sub">${mdInline(n.sub)}</span>` : '';
  const kids = n.children.length ? `<ul>${n.children.map(liHtml).join('')}</ul>` : '';
  return `<li${n.hi ? ' class="am-tree-hi"' : ''}${vattrs(n)}><span class="am-tree-label">${labelHtml(n.label)}</span>${sub}${kids}</li>`;
}
