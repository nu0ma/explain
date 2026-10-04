// Flow / architecture diagram: the script states only relations (A -> B: label). the layered layout in ../svg/layout.ts computes coordinates; this module draws the result as SVG.
import { esc, measure, wrap } from '../svg/text.ts';
import { f, smoothPath, arrowDefs, svgOpen, textLines } from '../svg/shapes.ts';
import type { Point } from '../svg/shapes.ts';
import { layoutGraph } from '../svg/layout.ts';
import type { Box, Rankdir } from '../svg/layout.ts';
import { ComponentError, contentLines } from './error.ts';
import type { Component } from './types.ts';

export type FlowShape = 'db' | 'rect' | 'round' | 'diamond';
export type FlowDiff = 'add' | 'chg' | 'del';

export type FlowNode = {
  id: string;
  label: string;
  shape: FlowShape;
  // True when the shape came from an explicit bracket, so it overrides an earlier bare mention.
  explicit: boolean;
  hi: boolean;
  diff: FlowDiff | null;
  line: number;
};
export type FlowEdge = { from: string; to: string; dashed: boolean; diff: FlowDiff | null; label: string; line: number };
export type FlowGroup = { name: string; members: string[]; line: number };
export type FlowModel = { nodes: Map<string, FlowNode>; edges: FlowEdge[]; groups: FlowGroup[] };

type NodeSpec = Omit<FlowNode, 'line'> & { labelDeclared: boolean };
type ChainStep = { arrow: string | null; nodes: NodeSpec[] };
type NodeSize = { lines: string[]; width: number; height: number };

const FS = 13;
const LH = 17;
const TEXT_MAX = 150;
const EDGE_FS = 11.5;
const CLUSTER_FS = 11;
const DIRS: ReadonlySet<string> = new Set<Rankdir>(['TB', 'LR', 'BT', 'RL']);
const isRankdir = (dir: string): dir is Rankdir => DIRS.has(dir);

// Shape brackets: match longer opening brackets first.
const BRACKETS: ReadonlyArray<{ open: string; close: string; shape: FlowShape }> = [
  { open: '[(', close: ')]', shape: 'db' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
];
// Diff arrows (+-> added, x-> removed) are matched before the plain arrows.
const ARROW = /^\s*(\+->|x->|-->|->)\s*/;
const EDGE_DIFF: Partial<Record<string, FlowDiff>> = { '+->': 'add', 'x->': 'del' };
// Node diff marks: + added, ~ changed, - removed.
const NODE_DIFF: Partial<Record<string, FlowDiff>> = { '+': 'add', '~': 'chg', '-': 'del' };
const DIFF_LABEL: Record<FlowDiff, string> = { add: '追加', chg: '変更', del: '削除' };

export default {
  name: 'flow',
  summary: 'フロー図・構成図（自動レイアウト）',
  syntax: `\`\`\`flow [TB|LR|BT|RL]
A -> B: ラベル                ← 実線。コロンの後ろが矢印のラベル
A --> C                       ← 点線
A -> B -> C                   ← 連鎖
A -> B & C                    ← 分岐（ファンアウト）
(開始)  {判定?}  [(データベース)]  [コロン: を含む文字]   ← 角丸・ひし形・円柱・長方形
@api1[API] -> @api2[API]       ← IDを分けて同じ表示名のノードを描く
api1 -> api2                  ← 宣言したIDで参照する
*重要なノード                  ← 先頭の * で強調
+新しいノード  ~変えるノード  -消すノード   ← 差分の色分け（追加・変更・削除）
A +-> B   A x-> B             ← 追加する矢印・削除する矢印（前後に空白を入れる）
group グループ名: B, C        ← ノードを 1 つのグループで囲む
\`\`\`
- ノードは括弧の中の文字で識別する。2 回目以降は文字だけで参照できる。向きの既定は TB（上から下）。
- @id[表示名]でIDと表示名を分けられる。IDは英字か _ で始め、英数字・_・-・. を使う。ほかの形の括弧も使える。
- 矢印とgroupではIDを参照する。同じIDを再び宣言すると、最後の表示名を使う。
- 動画では同じIDのノードが場面をまたいでつながる。場面ごとに表示名を変えてもよい。同じ場面の別のノードには別のIDを使う。
- 差分の印を使うと、図の下に凡例が出る。印はそのノードの最初の登場で 1 回だけ付ければよい。`,
  example: '```flow LR\n(ユーザー) -> ゲートウェイ: HTTPS\nゲートウェイ -> 認証 & *業務サービス\n業務サービス -> [(データベース)]\ngroup バックエンド: 認証, 業務サービス\n```',
  tips: `- 何が何につながるか、構成、判断の分かれ道を示すときに使う。やりとりの順番を見せたいときはsequenceを使う。
- ノード名には、コードの識別子ではなく、そのノードが読者にとって何をするかを書く。
- 変更の前後を見せるときは、前と後で同じノードを使い、差分の印で追加と削除を示す。
- 1つの図のノードは10個前後までにする。多いときはgroupでまとめるか、パネルを分ける。`,
  render(text, { args, uid }) {
    const model = parseFlow(text);
    const dir = (args.match(/\b(TB|LR|BT|RL)\b/i)?.[1] ?? 'TB').toUpperCase();
    return `<figure class="am-diagram am-flow">${layout(model, isRankdir(dir) ? dir : 'TB', uid())}${legend(model)}</figure>`;
  },
} satisfies Component;

export function parseFlow(text: string): FlowModel {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const groups: FlowGroup[] = [];
  const declared = new Set<string>();
  const upsert = ({ labelDeclared, ...spec }: NodeSpec, line: number): string => {
    if (labelDeclared) declared.add(spec.id);
    const prev = nodes.get(spec.id);
    if (!prev) nodes.set(spec.id, { ...spec, line });
    else nodes.set(spec.id, { ...prev, label: labelDeclared ? spec.label : prev.label, shape: spec.explicit ? spec.shape : prev.shape, hi: prev.hi || spec.hi, diff: prev.diff || spec.diff });
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
      const arrow = ids[k].arrow;
      for (const from of ids[k - 1].ids) {
        for (const to of ids[k].ids) {
          edges.push({ from, to, dashed: arrow === '-->', diff: arrow === null ? null : EDGE_DIFF[arrow] ?? null, label: isLast ? label : '', line });
        }
      }
    }
  }
  if (!nodes.size) throw new ComponentError('flow にはノードが 1 つ以上必要です', 1);
  // A bare "@id" naming a declared ID is almost always a reference written with the @ by mistake.
  // Without this check it silently becomes a new node labeled "@id".
  for (const node of nodes.values()) {
    const ref = node.id.startsWith('@') && !node.explicit ? node.id.slice(1) : '';
    if (ref && declared.has(ref)) throw new ComponentError(`flow の ${node.id} は新しいノードになります。宣言したIDを参照するときは @ を付けずに ${ref} と書いてください`, node.line);
  }
  for (const grp of groups) {
    const missing = grp.members.filter((m) => !nodes.has(m));
    if (missing.length) throw new ComponentError(`group ${grp.name} が存在しないノードを参照しています：${missing.join('、')}`, grp.line);
  }
  return { nodes, edges, groups };
}

// One line = groups of nodes (separated by &) joined by arrows, optionally followed by ": label".
function parseChain(t: string, line: number): { chain: ChainStep[]; label: string } {
  const chain: ChainStep[] = [];
  let pos = 0;
  let arrow: string | null = null;
  for (;;) {
    const group: NodeSpec[] = [];
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

function parseNode(t: string, start: number, line: number): { node: NodeSpec; end: number } {
  let pos = start + (t.slice(start).match(/^\s*/)?.[0].length ?? 0);
  const diff = NODE_DIFF[t[pos]] ?? null;
  if (diff) pos++;
  const hi = t[pos] === '*';
  if (hi) pos++;
  // Only the opt-in @id immediately followed by a shape bracket declares an ID.
  // Ordinary bare labels (including API(v1), email addresses, and @mentions) stay unchanged.
  const named = t.slice(pos).match(/^@([A-Za-z_][A-Za-z0-9_.-]*)(?=\[|\(|\{)/);
  if (named) pos += named[0].length;
  const bracket = BRACKETS.find((b) => t.startsWith(b.open, pos));
  let label: string;
  let end: number;
  if (bracket) {
    const close = t.indexOf(bracket.close, pos + bracket.open.length);
    if (close === -1) throw new ComponentError(`flow の形の括弧が閉じていません：${bracket.close} がありません`, line);
    label = t.slice(pos + bracket.open.length, close).trim();
    end = close + bracket.close.length;
  } else {
    // The lookahead ends in $, so this always matches.
    const m = t.slice(pos).match(/^(.*?)(?=\s+(?:\+->|x->)|\s*(?:-->|->|&|[:：]|$))/);
    label = m?.[1].trim() ?? '';
    end = pos + (m?.[0].length ?? 0);
  }
  if (!label) throw new ComponentError(`flow に空のノードがあります："${t}"`, line);
  return { node: { id: named?.[1] ?? label, label, labelDeclared: Boolean(named), shape: bracket?.shape ?? 'rect', explicit: Boolean(bracket), hi, diff }, end };
}

function nodeSize(node: FlowNode): NodeSize {
  const lines = wrap(node.label, TEXT_MAX, FS);
  const tw = Math.max(...lines.map((l) => measure(l, FS)));
  const th = lines.length * LH;
  const w = Math.max(tw + 28, 64);
  const h = th + 18;
  const sizes: Record<FlowShape, [number, number]> = {
    rect: [w, h],
    round: [w + 12, h],
    diamond: [(tw + 28) * 1.5, h * 1.6],
    db: [w, h + 14],
  };
  const size = sizes[node.shape];
  return { lines, width: size[0], height: size[1] };
}

function layout({ nodes, edges, groups }: FlowModel, rankdir: Rankdir, id: string): string {
  const sized = [...nodes.values()].map((n) => ({ n, size: nodeSize(n) }));
  // A node listed in several groups belongs to the last one.
  const groupOf = new Map<string, number>();
  groups.forEach((grp, i) => grp.members.forEach((m) => groupOf.set(m, i)));
  const g = layoutGraph({
    rankdir,
    nodesep: 36,
    ranksep: 46,
    edgesep: 12,
    margin: 14,
    clusterPad: { top: 26, right: 12, bottom: 12, left: 12 },
    nodes: sized.map(({ n, size }) => ({ id: n.id, width: size.width, height: size.height, cluster: groupOf.has(n.id) ? String(groupOf.get(n.id)) : undefined })),
    clusters: groups.map((grp, i) => ({ id: String(i), minWidth: measure(grp.name, CLUSTER_FS, { mono: true }) + 16 })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label ? { width: measure(e.label, EDGE_FS) + 12, height: 18 } : undefined })),
  });
  const boxOf = (key: string): Box => {
    const b = g.nodes.get(key);
    if (!b) throw new Error(`layout did not place node ${key}`);
    return b;
  };

  const clusters = groups.flatMap((grp, i) => {
    const c = g.clusters.get(String(i));
    if (!c) return [];
    const x = c.x - c.width / 2;
    const y = c.y - c.height / 2;
    return [`<rect class="am-cluster" x="${f(x)}" y="${f(y)}" width="${f(c.width)}" height="${f(c.height)}" rx="4"/><text class="am-cluster-label" x="${f(x + 8)}" y="${f(y + 14)}">${esc(grp.name)}</text>`];
  });

  // In video, elements appear one source line at a time. Arrows on a line and nodes first seen on that line share a step.
  const stepOf = new Map([...new Set([...[...nodes.values()].map((n) => n.line), ...edges.map((e) => e.line)])].sort((a, b) => a - b).map((l, k) => [l, k]));
  const edgeSvg = edges.map((e, i) => {
    const data = g.edges[i];
    const pts = clipEnds(data.points, boxOf(e.from), nodes.get(e.from)?.shape, boxOf(e.to), nodes.get(e.to)?.shape);
    const path = `<path class="am-edge${e.dashed ? ' am-edge--dashed' : ''}${e.diff ? ` am-edge--${e.diff}` : ''}" d="${smoothPath(pts)}" marker-end="url(#${id}-arrow${e.diff ? `-${e.diff}` : ''})"/>`;
    if (!e.label || !data.label) return `<g data-step="${stepOf.get(e.line)}">${path}</g>`;
    const w = measure(e.label, EDGE_FS) + 10;
    const { x: lx, y: ly } = data.label;
    return `<g data-step="${stepOf.get(e.line)}">${path}<g class="am-edge-label"><rect x="${f(lx - w / 2)}" y="${f(ly - 9)}" width="${f(w)}" height="18" rx="3"/>${textLines([e.label], lx, ly, LH)}</g></g>`;
  });

  const nodeSvg = sized.map(({ n, size }) => {
    const { x, y } = boxOf(n.id);
    const { width: w, height: h, lines } = size;
    return `<g class="am-node am-node--${n.shape}${n.hi ? ' am-node--hi' : ''}${n.diff ? ` am-node--${n.diff}` : ''}" data-key="${esc(n.id)}" data-step="${stepOf.get(n.line)}">${shapeSvg(n.shape, x, y, w, h)}${textLines(lines, x, y + (n.shape === 'db' ? 4 : 0), LH)}</g>`;
  });

  const label = `フロー図：${[...nodes.values()].slice(0, 8).map((n) => n.label).join('、')}`;
  return `${svgOpen(g.width, g.height, label)}${arrowDefs(id)}${diffArrowDefs(id, edges)}<g>${clusters.join('')}</g><g>${edgeSvg.join('')}</g><g>${nodeSvg.join('')}</g></svg>`;
}

function shapeSvg(shape: FlowShape, x: number, y: number, w: number, h: number): string {
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

// The layout ends arrows on the bounding rectangle. For diamonds, recompute the intersection with the slanted edge, or the arrow floats in the air.
function clipEnds(points: readonly Point[], from: Box, fromShape: FlowShape | undefined, to: Box, toShape: FlowShape | undefined): Point[] {
  const pts = points.map((p) => ({ ...p }));
  if (fromShape === 'diamond' && pts.length > 1) pts[0] = diamondPoint(from, pts[1]);
  if (toShape === 'diamond' && pts.length > 1) pts[pts.length - 1] = diamondPoint(to, pts[pts.length - 2]);
  return pts;
}

function diamondPoint(node: Box, toward: Point): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  const k = Math.abs(dx) / (node.width / 2) + Math.abs(dy) / (node.height / 2);
  if (k === 0) return { x: node.x, y: node.y };
  return { x: node.x + dx / k, y: node.y + dy / k };
}

// Diff arrows get arrowheads in the same color, so add a marker for each kind in use.
function diffArrowDefs(id: string, edges: readonly FlowEdge[]): string {
  const kinds = [...new Set(edges.map((e) => e.diff).filter(Boolean))];
  if (!kinds.length) return '';
  return `<defs>${kinds.map((k) => `<marker id="${id}-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="am-arrow am-arrow--${k}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('')}</defs>`;
}

// If any diff mark is used, show a legend under the diagram with only the kinds in use.
function legend({ nodes, edges }: FlowModel): string {
  const used = new Set([...[...nodes.values()].map((n) => n.diff), ...edges.map((e) => e.diff)].filter(Boolean));
  if (!used.size) return '';
  const order: readonly FlowDiff[] = ['add', 'chg', 'del'];
  const items = order.filter((k) => used.has(k)).map((k) => `<span class="am-legend-item am-legend-item--${k}"><i></i>${DIFF_LABEL[k]}</span>`);
  return `<figcaption class="am-legend">${items.join('')}</figcaption>`;
}
