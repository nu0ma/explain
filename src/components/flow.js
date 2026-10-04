// フロー図・構成図：原稿には関係（A -> B: ラベル）だけを書く。座標は dagre が計算し、ここでは配置結果を SVG に描く。
import dagre from '@dagrejs/dagre';
import { esc, measure, wrap } from '../svg/text.js';
import { f, smoothPath, arrowDefs, svgOpen, textLines } from '../svg/shapes.js';
import { ComponentError, contentLines } from './error.js';

const FS = 13;
const LH = 17;
const TEXT_MAX = 150;
const EDGE_FS = 11.5;
const DIRS = new Set(['TB', 'LR', 'BT', 'RL']);

// 形の括弧：長い開き括弧から先に照合する。
const BRACKETS = [
  { open: '[(', close: ')]', shape: 'db' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
];
// 差分の矢印（+-> 追加、x-> 削除）は通常の矢印より先に照合する。
const ARROW = /^\s*(\+->|x->|-->|->)\s*/;
const EDGE_DIFF = { '+->': 'add', 'x->': 'del' };
// ノードの差分の印：+ 追加、~ 変更、- 削除。
const NODE_DIFF = { '+': 'add', '~': 'chg', '-': 'del' };
const DIFF_LABEL = { add: '追加', chg: '変更', del: '削除' };

export default {
  name: 'flow',
  summary: 'フロー図・構成図（自動レイアウト）',
  syntax: `\`\`\`flow [TB|LR|BT|RL]
A -> B: ラベル                ← 実線。コロンの後ろが矢印のラベル
A --> C                       ← 点線
A -> B -> C                   ← 連鎖
A -> B & C                    ← 分岐（ファンアウト）
(開始)  {判定?}  [(データベース)]  [コロン: を含む文字]   ← 角丸・ひし形・円柱・長方形
*重要なノード                  ← 先頭の * で強調
+新しいノード  ~変えるノード  -消すノード   ← 差分の色分け（追加・変更・削除）
A +-> B   A x-> B             ← 追加する矢印・削除する矢印（前後に空白を入れる）
group グループ名: B, C        ← ノードを 1 つのグループで囲む
\`\`\`
- ノードは括弧の中の文字で識別する。2 回目以降は文字だけで参照できる。向きの既定は TB（上から下）。
- 差分の印を使うと、図の下に凡例が出る。印はそのノードの最初の登場で 1 回だけ付ければよい。`,
  example: '```flow LR\n(ユーザー) -> ゲートウェイ: HTTPS\nゲートウェイ -> 認証 & *業務サービス\n業務サービス -> [(データベース)]\ngroup バックエンド: 認証, 業務サービス\n```',
  render(text, { args, uid }) {
    const model = parseFlow(text);
    const dir = (args.match(/\b(TB|LR|BT|RL)\b/i)?.[1] ?? 'TB').toUpperCase();
    return `<figure class="am-diagram am-flow">${layout(model, DIRS.has(dir) ? dir : 'TB', uid())}${legend(model)}</figure>`;
  },
};

export function parseFlow(text) {
  const nodes = new Map();
  const edges = [];
  const groups = [];
  const upsert = (spec, line) => {
    const prev = nodes.get(spec.id);
    if (!prev) nodes.set(spec.id, { ...spec, line });
    else nodes.set(spec.id, { ...prev, shape: spec.explicit ? spec.shape : prev.shape, hi: prev.hi || spec.hi, diff: prev.diff || spec.diff });
    return spec.id;
  };

  for (const { text: t, line } of contentLines(text)) {
    const g = t.match(/^group\s+(.+?)\s*[:：]\s*(.+)$/i);
    if (g) {
      groups.push({ name: g[1], members: g[2].split(/[,，]/).map((s) => s.trim()).filter(Boolean), line });
      continue;
    }
    const { chain, label } = parseChain(t, line);
    const ids = chain.map((step) => ({ ...step, ids: step.nodes.map((n) => upsert(n, line)) }));
    for (let k = 1; k < ids.length; k++) {
      const isLast = k === ids.length - 1;
      for (const from of ids[k - 1].ids) {
        for (const to of ids[k].ids) {
          edges.push({ from, to, dashed: ids[k].arrow === '-->', diff: EDGE_DIFF[ids[k].arrow] ?? null, label: isLast ? label : '', line });
        }
      }
    }
  }
  if (!nodes.size) throw new ComponentError('flow にはノードが 1 つ以上必要です', 1);
  for (const grp of groups) {
    const missing = grp.members.filter((m) => !nodes.has(m));
    if (missing.length) throw new ComponentError(`group ${grp.name} が存在しないノードを参照しています：${missing.join('、')}`, grp.line);
  }
  return { nodes, edges, groups };
}

// 1 行 = ノードの組（& 区切り）を矢印でつないだもの。末尾に ": ラベル" をつけられる。
function parseChain(t, line) {
  const chain = [];
  let pos = 0;
  let arrow = null;
  for (;;) {
    const group = [];
    for (;;) {
      const { node, end } = parseNode(t, pos, line);
      group.push(node);
      pos = end;
      const amp = t.slice(pos).match(/^\s*&\s*/);
      if (!amp) break;
      pos += amp[0].length;
    }
    chain.push({ arrow, nodes: group });
    const a = t.slice(pos).match(ARROW);
    if (!a) break;
    arrow = a[1];
    pos += a[0].length;
  }
  const rest = t.slice(pos).trim();
  if (rest && !/^[:：]/.test(rest)) {
    throw new ComponentError(`flow を解析できません："${t}"。関係は A -> B: ラベル と書いてください`, line);
  }
  return { chain, label: rest.replace(/^[:：]\s*/, '') };
}

function parseNode(t, start, line) {
  let pos = start + t.slice(start).match(/^\s*/)[0].length;
  const diff = NODE_DIFF[t[pos]] ?? null;
  if (diff) pos++;
  const hi = t[pos] === '*';
  if (hi) pos++;
  const bracket = BRACKETS.find((b) => t.startsWith(b.open, pos));
  let label;
  let end;
  if (bracket) {
    const close = t.indexOf(bracket.close, pos + bracket.open.length);
    if (close === -1) throw new ComponentError(`flow の形の括弧が閉じていません：${bracket.close} がありません`, line);
    label = t.slice(pos + bracket.open.length, close).trim();
    end = close + bracket.close.length;
  } else {
    const m = t.slice(pos).match(/^(.*?)(?=\s+(?:\+->|x->)|\s*(?:-->|->|&|[:：]|$))/);
    label = m[1].trim();
    end = pos + m[0].length;
  }
  if (!label) throw new ComponentError(`flow に空のノードがあります："${t}"`, line);
  return { node: { id: label, label, shape: bracket?.shape ?? 'rect', explicit: Boolean(bracket), hi, diff }, end };
}

function nodeSize(node) {
  const lines = wrap(node.label, TEXT_MAX, FS);
  const tw = Math.max(...lines.map((l) => measure(l, FS)));
  const th = lines.length * LH;
  const w = Math.max(tw + 28, 64);
  const h = th + 18;
  const size = {
    rect: [w, h],
    round: [w + 12, h],
    diamond: [(tw + 28) * 1.5, h * 1.6],
    db: [w, h + 14],
  }[node.shape];
  return { lines, width: size[0], height: size[1] };
}

function layout({ nodes, edges, groups }, rankdir, id) {
  const g = new dagre.graphlib.Graph({ compound: groups.length > 0, multigraph: true });
  g.setGraph({ rankdir, nodesep: 36, ranksep: 46, marginx: 14, marginy: groups.length ? 26 : 14 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map();
  for (const n of nodes.values()) {
    const s = nodeSize(n);
    sizes.set(n.id, s);
    g.setNode(n.id, { width: s.width, height: s.height });
  }
  groups.forEach((grp, i) => {
    g.setNode(`__group${i}`, { label: grp.name });
    grp.members.forEach((m) => g.setParent(m, `__group${i}`));
  });
  edges.forEach((e, i) => {
    const label = e.label ? { label: e.label, width: measure(e.label, EDGE_FS) + 12, height: 18, labelpos: 'c' } : {};
    g.setEdge(e.from, e.to, label, `e${i}`);
  });
  dagre.layout(g);

  const clusters = groups.map((grp, i) => {
    const c = g.node(`__group${i}`);
    const x = c.x - c.width / 2;
    const y = c.y - c.height / 2;
    return `<rect class="am-cluster" x="${f(x)}" y="${f(y)}" width="${f(c.width)}" height="${f(c.height)}" rx="4"/><text class="am-cluster-label" x="${f(x + 8)}" y="${f(y + 14)}">${esc(grp.name)}</text>`;
  });

  // 動画ではソースの行ごとに順に現れる。同じ行に書いた矢印と、その行で初めて出たノードは同じ手順に入る。
  const stepOf = new Map([...new Set([...[...nodes.values()].map((n) => n.line), ...edges.map((e) => e.line)])].sort((a, b) => a - b).map((l, k) => [l, k]));
  const edgeSvg = edges.map((e, i) => {
    const data = g.edge({ v: e.from, w: e.to, name: `e${i}` });
    const pts = clipEnds(data.points, g.node(e.from), nodes.get(e.from).shape, g.node(e.to), nodes.get(e.to).shape);
    const path = `<path class="am-edge${e.dashed ? ' am-edge--dashed' : ''}${e.diff ? ` am-edge--${e.diff}` : ''}" d="${smoothPath(pts)}" marker-end="url(#${id}-arrow${e.diff ? `-${e.diff}` : ''})"/>`;
    if (!e.label) return `<g data-step="${stepOf.get(e.line)}">${path}</g>`;
    const w = measure(e.label, EDGE_FS) + 10;
    return `<g data-step="${stepOf.get(e.line)}">${path}<g class="am-edge-label"><rect x="${f(data.x - w / 2)}" y="${f(data.y - 9)}" width="${f(w)}" height="18" rx="3"/>${textLines([e.label], data.x, data.y, LH)}</g></g>`;
  });

  const nodeSvg = [...nodes.values()].map((n) => {
    const { x, y } = g.node(n.id);
    const { width: w, height: h, lines } = sizes.get(n.id);
    return `<g class="am-node am-node--${n.shape}${n.hi ? ' am-node--hi' : ''}${n.diff ? ` am-node--${n.diff}` : ''}" data-key="${esc(n.label)}" data-step="${stepOf.get(n.line)}">${shapeSvg(n.shape, x, y, w, h)}${textLines(lines, x, y + (n.shape === 'db' ? 4 : 0), LH)}</g>`;
  });

  const { width, height } = g.graph();
  const label = `フロー図：${[...nodes.keys()].slice(0, 8).join('、')}`;
  return `${svgOpen(width, height, label)}${arrowDefs(id)}${diffArrowDefs(id, edges)}<g>${clusters.join('')}</g><g>${edgeSvg.join('')}</g><g>${nodeSvg.join('')}</g></svg>`;
}

function shapeSvg(shape, x, y, w, h) {
  const l = x - w / 2;
  const t = y - h / 2;
  if (shape === 'diamond') {
    return `<polygon class="am-node-shape" points="${f(x)},${f(t)} ${f(x + w / 2)},${f(y)} ${f(x)},${f(t + h)} ${f(l)},${f(y)}"/>`;
  }
  if (shape === 'db') {
    const ry = 7;
    return `<path class="am-node-shape" d="M${f(l)},${f(t + ry)} A${f(w / 2)},${ry} 0 0 1 ${f(l + w)},${f(t + ry)} V${f(t + h - ry)} A${f(w / 2)},${ry} 0 0 1 ${f(l)},${f(t + h - ry)} Z"/><path class="am-node-shape" d="M${f(l)},${f(t + ry)} A${f(w / 2)},${ry} 0 0 0 ${f(l + w)},${f(t + ry)}"/>`;
  }
  const rx = shape === 'round' ? h / 2 : 3;
  return `<rect class="am-node-shape" x="${f(l)}" y="${f(t)}" width="${f(w)}" height="${f(h)}" rx="${f(rx)}"/>`;
}

// dagre は矢印の端を長方形の境界で切る。ひし形では斜辺との交点を求め直す。そうしないと矢印が宙に浮く。
function clipEnds(points, from, fromShape, to, toShape) {
  const pts = points.map((p) => ({ ...p }));
  if (fromShape === 'diamond' && pts.length > 1) pts[0] = diamondPoint(from, pts[1]);
  if (toShape === 'diamond' && pts.length > 1) pts[pts.length - 1] = diamondPoint(to, pts[pts.length - 2]);
  return pts;
}

function diamondPoint(node, toward) {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  const k = Math.abs(dx) / (node.width / 2) + Math.abs(dy) / (node.height / 2);
  if (k === 0) return { x: node.x, y: node.y };
  return { x: node.x + dx / k, y: node.y + dy / k };
}

// 差分の矢印は矢じりも同じ色にするため、使われた種類だけマーカーを足す。
function diffArrowDefs(id, edges) {
  const kinds = [...new Set(edges.map((e) => e.diff).filter(Boolean))];
  if (!kinds.length) return '';
  return `<defs>${kinds.map((k) => `<marker id="${id}-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="am-arrow am-arrow--${k}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('')}</defs>`;
}

// 差分の印が 1 つでもあれば、使われた種類だけの凡例を図の下に出す。
function legend({ nodes, edges }) {
  const used = new Set([...[...nodes.values()].map((n) => n.diff), ...edges.map((e) => e.diff)].filter(Boolean));
  if (!used.size) return '';
  const items = ['add', 'chg', 'del'].filter((k) => used.has(k)).map((k) => `<span class="am-legend-item am-legend-item--${k}"><i></i>${DIFF_LABEL[k]}</span>`);
  return `<figcaption class="am-legend">${items.join('')}</figcaption>`;
}
