import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../src/svg/layout.ts';
import type { Box, LayoutInput, LayoutResult, Rankdir } from '../src/svg/layout.ts';
import type { Point } from '../src/svg/shapes.ts';

type Spec = {
  rankdir?: Rankdir;
  nodes: string[];
  edges: [string, string, string?][];
  clusters?: { id: string; parent?: string; members: string[] }[];
};

const input = ({ rankdir = 'TB', nodes, edges, clusters = [] }: Spec): LayoutInput => ({
  rankdir,
  nodesep: 36,
  ranksep: 46,
  edgesep: 12,
  margin: 14,
  clusterPad: { top: 26, right: 12, bottom: 12, left: 12 },
  nodes: nodes.map((id, i) => ({ id, width: 60 + (i % 3) * 20, height: 30 + (i % 2) * 14, cluster: clusters.findLast((c) => c.members.includes(id))?.id })),
  clusters: clusters.map(({ id, parent }) => ({ id, parent, minWidth: 40 })),
  edges: edges.map(([from, to, label]) => ({ from, to, label: label ? { width: label.length * 12 + 12, height: 18 } : undefined })),
});

const node = (r: LayoutResult, id: string): Box => {
  const b = r.nodes.get(id);
  assert.ok(b, `${id} の位置がない`);
  return b;
};
const edges = (spec: Spec): { from: string; to: string }[] => spec.edges.map(([from, to]) => ({ from, to }));
const left = (b: Box): number => b.x - b.width / 2;
const right = (b: Box): number => b.x + b.width / 2;
const top = (b: Box): number => b.y - b.height / 2;
const bottom = (b: Box): number => b.y + b.height / 2;
const overlaps = (a: Box, b: Box): boolean => left(a) < right(b) && left(b) < right(a) && top(a) < bottom(b) && top(b) < bottom(a);
const contains = (outer: Box, inner: Box): boolean => left(outer) <= left(inner) && right(inner) <= right(outer) && top(outer) <= top(inner) && bottom(inner) <= bottom(outer);
const onBorder = (p: Point, b: Box): boolean =>
  left(b) - 0.5 <= p.x && p.x <= right(b) + 0.5 && top(b) - 0.5 <= p.y && p.y <= bottom(b) + 0.5 &&
  Math.min(Math.abs(p.x - left(b)), Math.abs(p.x - right(b)), Math.abs(p.y - top(b)), Math.abs(p.y - bottom(b))) < 0.5;

// Whether the segment a-b enters the inside of the box (shrunk by 1px), by clipping the segment to the box.
function crosses(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [number, number][] = [[-dx, a.x - (left(box) + 1)], [dx, right(box) - 1 - a.x], [-dy, a.y - (top(box) + 1)], [dy, bottom(box) - 1 - a.y]];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

// Properties every layout must have. Returns the problems found.
function problems(spec: Spec, r: LayoutResult): string[] {
  const out: string[] = [];
  const ids = spec.nodes;
  for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) if (overlaps(node(r, a), node(r, b))) out.push(`${a} と ${b} が重なる`);
  for (const id of ids) {
    const b = node(r, id);
    if (left(b) < 0 || top(b) < 0 || right(b) > r.width || bottom(b) > r.height) out.push(`${id} が図の外に出る`);
  }
  edges(spec).forEach(({ from, to }, i) => {
    const { points, label } = r.edges[i];
    if (!onBorder(points[0], node(r, from))) out.push(`${from} -> ${to} が ${from} の縁から出ない`);
    if (!onBorder(points[points.length - 1], node(r, to))) out.push(`${from} -> ${to} が ${to} の縁に着かない`);
    for (const id of ids) {
      if (id === from || id === to) continue;
      for (let k = 1; k < points.length; k++) if (crosses(points[k - 1], points[k], node(r, id))) out.push(`${from} -> ${to} が ${id} を通る`);
    }
    if (label) for (const id of ids) if (overlaps({ ...label, width: 20, height: 18 }, node(r, id))) out.push(`${from} -> ${to} のラベルが ${id} に重なる`);
  });
  for (const c of spec.clusters ?? []) {
    const box = r.clusters.get(c.id);
    if (!box) {
      out.push(`グループ ${c.id} の枠がない`);
      continue;
    }
    const inside = new Set(spec.clusters?.filter((k) => k.id === c.id || isWithin(spec, k.id, c.id)).flatMap((k) => k.members));
    for (const id of ids) {
      const member = inside.has(id);
      if (member && !contains(box, node(r, id))) out.push(`グループ ${c.id} が ${id} を囲まない`);
      if (!member && overlaps(box, node(r, id))) out.push(`グループ ${c.id} に ${id} が入る`);
    }
  }
  return out;
}

function isWithin(spec: Spec, child: string, ancestor: string): boolean {
  for (let p = spec.clusters?.find((c) => c.id === child)?.parent; p; p = spec.clusters?.find((c) => c.id === p)?.parent) if (p === ancestor) return true;
  return false;
}

const SPECS: { name: string; req: Spec }[] = [
  { name: '循環', req: { nodes: ['A', 'B', 'C'], edges: [['A', 'B'], ['B', 'C'], ['C', 'A']] } },
  { name: '長い辺', req: { nodes: ['A', 'B', 'C', 'D', 'X'], edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D'], ['X', 'C']] } },
  { name: '同じ組の複数の辺', req: { nodes: ['A', 'B'], edges: [['A', 'B'], ['A', 'B'], ['B', 'A']] } },
  { name: 'ラベル付きの辺', req: { nodes: ['A', 'B', 'C'], edges: [['A', 'B', 'はい'], ['A', 'C', 'いいえ'], ['B', 'C']] } },
  { name: '自己ループ', req: { nodes: ['A', 'B'], edges: [['A', 'A', '再試行'], ['A', 'B']] } },
  {
    name: '入れ子のグループ',
    req: {
      nodes: ['入口', 'A', 'B', 'C', '出口'],
      edges: [['入口', 'A'], ['A', 'B'], ['B', 'C'], ['C', '出口'], ['入口', '出口']],
      clusters: [{ id: '外', members: ['A', 'C'] }, { id: '内', parent: '外', members: ['B'] }],
    },
  },
  {
    name: '隣り合うグループ',
    req: {
      rankdir: 'LR',
      nodes: ['LB', 'W1', 'W2', 'キャッシュ', 'DB', '監視'],
      edges: [['LB', 'W1'], ['LB', 'W2'], ['W1', 'キャッシュ'], ['W2', 'DB'], ['W1', 'DB'], ['監視', 'W2']],
      clusters: [{ id: 'web', members: ['W1', 'W2'] }, { id: 'store', members: ['キャッシュ', 'DB'] }],
    },
  },
  {
    name: '離れた段にまたがるグループ',
    req: {
      nodes: ['A', 'B', 'C', 'D'],
      edges: [['A', 'B'], ['B', 'C'], ['A', 'D'], ['D', 'C']],
      clusters: [{ id: 'g', members: ['A', 'C'] }],
    },
  },
];

test('layoutGraph: どの向きでもノードが重ならず、辺はノードの縁を結び、ほかのノードを通らない', () => {
  for (const rankdir of ['TB', 'BT', 'LR', 'RL'] as const) {
    for (const { name, req } of SPECS) {
      const spec = { ...req, rankdir };
      const got = problems(spec, layoutGraph(input(spec)));
      assert.deepEqual(got, [], `${name}（${rankdir}）`);
    }
  }
});

test('layoutGraph: 乱数で作ったグループ付きの図でも、ノードとグループの枠が重ならない', () => {
  for (let seed = 1; seed <= 30; seed++) {
    let s = seed;
    const rnd = (k: number): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return Math.floor((s / 2147483648) * k);
    };
    const nodes = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const spec: Spec = {
      rankdir: (['TB', 'LR'] as const)[seed % 2],
      nodes,
      edges: Array.from({ length: 18 }, () => [nodes[rnd(12)], nodes[rnd(12)], rnd(4) ? undefined : 'ラベル'] as [string, string, string?]),
      clusters: [{ id: 'g0', members: ['n1', 'n2', 'n3'] }, { id: 'g1', members: ['n5', 'n6'] }, { id: 'g2', parent: 'g1', members: ['n7', 'n8'] }],
    };
    assert.deepEqual(problems(spec, layoutGraph(input(spec))), [], `seed ${seed}`);
  }
});

test('layoutGraph: 同じ入力からは同じ配置を出す', () => {
  for (const { name, req } of SPECS) {
    assert.deepEqual(layoutGraph(input(req)), layoutGraph(input(req)), name);
    assert.deepEqual(layoutGraph(structuredClone(input(req))), layoutGraph(input(req)), name);
  }
});

test('layoutGraph: rankdir の向きに矢印の先が並ぶ', () => {
  const cases: { req: Rankdir; want: (a: Box, b: Box) => boolean }[] = [
    { req: 'TB', want: (a, b) => b.y > a.y && a.x === b.x },
    { req: 'BT', want: (a, b) => b.y < a.y && a.x === b.x },
    { req: 'LR', want: (a, b) => b.x > a.x && a.y === b.y },
    { req: 'RL', want: (a, b) => b.x < a.x && a.y === b.y },
  ];
  for (const { req, want } of cases) {
    const r = layoutGraph(input({ rankdir: req, nodes: ['A', 'B'], edges: [['A', 'B']] }));
    assert.ok(want(node(r, 'A'), node(r, 'B')), req);
  }
});

test('layoutGraph: 循環を閉じる辺も元の向きに描く', () => {
  const spec: Spec = { nodes: ['A', 'B', 'C'], edges: [['A', 'B'], ['B', 'C'], ['C', 'A']] };
  const r = layoutGraph(input(spec));
  const back = r.edges[2].points;
  assert.ok(onBorder(back[0], node(r, 'C')));
  assert.ok(onBorder(back[back.length - 1], node(r, 'A')));
  assert.ok(node(r, 'A').y < node(r, 'B').y && node(r, 'B').y < node(r, 'C').y);
});

test('layoutGraph: 同じ組の複数の辺は別の道を通り、ラベルは辺ごとに離れて置く', () => {
  const cases = [
    { req: { nodes: ['A', 'B'], edges: [['A', 'B'], ['A', 'B']] } satisfies Spec, want: 2 },
    { req: { nodes: ['A', 'B'], edges: [['A', 'B', '1回目'], ['A', 'B', '2回目'], ['A', 'B', '3回目']] } satisfies Spec, want: 3 },
  ];
  for (const { req, want } of cases) {
    const r = layoutGraph(input(req as Spec));
    const paths = new Set(r.edges.map((e) => JSON.stringify(e.points)));
    assert.equal(paths.size, want);
    const labels = r.edges.flatMap((e) => (e.label ? [{ ...e.label, width: 60, height: 18 }] : []));
    for (const [i, a] of labels.entries()) for (const b of labels.slice(i + 1)) assert.ok(!overlaps(a, b), 'ラベルが重なる');
  }
});

test('layoutGraph: 長い辺は途中の段を通り、ラベルは辺の上に置く', () => {
  const r = layoutGraph(input({ nodes: ['A', 'B', 'C', 'D'], edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D', '近道']] }));
  const { points, label } = r.edges[3];
  assert.ok(points.length > 4, `点の数：${points.length}`);
  assert.ok(label);
  assert.ok(points.some((p) => Math.abs(p.x - label.x) < 0.5 && p.y <= label.y) && points.some((p) => Math.abs(p.x - label.x) < 0.5 && p.y >= label.y));
});

test('layoutGraph: 入れ子のグループは内側の枠を外側の枠が囲む', () => {
  const spec = SPECS.find((s) => s.name === '入れ子のグループ')?.req;
  assert.ok(spec);
  const r = layoutGraph(input(spec));
  const outer = r.clusters.get('外');
  const inner = r.clusters.get('内');
  assert.ok(outer && inner);
  assert.ok(contains(outer, inner) && outer.width > inner.width && outer.height > inner.height);
});

test('layoutGraph: 隣り合うグループの枠は重ならない', () => {
  const spec = SPECS.find((s) => s.name === '隣り合うグループ')?.req;
  assert.ok(spec);
  for (const rankdir of ['TB', 'LR'] as const) {
    const r = layoutGraph(input({ ...spec, rankdir }));
    const [a, b] = [r.clusters.get('web'), r.clusters.get('store')];
    assert.ok(a && b);
    assert.ok(!overlaps(a, b), rankdir);
  }
});

test('layoutGraph: グループの枠は最小の幅を保つ', () => {
  const cases: { req: Rankdir; want: number }[] = [{ req: 'TB', want: 300 }, { req: 'LR', want: 300 }];
  for (const { req, want } of cases) {
    const spec = input({ rankdir: req, nodes: ['A'], edges: [], clusters: [{ id: 'g', members: ['A'] }] });
    const r = layoutGraph({ ...spec, clusters: [{ id: 'g', minWidth: want }] });
    assert.ok((r.clusters.get('g')?.width ?? 0) >= want - 0.5, req);
  }
});
