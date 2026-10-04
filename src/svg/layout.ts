// Layered (Sugiyama-style) graph layout for flow diagrams.
// Steps: cycle removal, ranking, dummy nodes, crossing reduction, coordinates, clusters, edge routing, rankdir.
// The layout works in top-to-bottom coordinates and rotates or flips the result at the end.
// Every step breaks ties by input order, so the same input always gives the same output.
import type { Point } from './shapes.ts';

export type Rankdir = 'TB' | 'BT' | 'LR' | 'RL';
// x and y are the center of the box.
export type Box = { x: number; y: number; width: number; height: number };
export type Pad = { top: number; right: number; bottom: number; left: number };
export type LayoutNode = { id: string; width: number; height: number; cluster?: string };
// minWidth is the width of the box in the final orientation, for example to fit the cluster label.
export type LayoutCluster = { id: string; parent?: string; minWidth?: number };
export type LayoutEdge = { from: string; to: string; label?: { width: number; height: number } };
export type LayoutInput = {
  rankdir: Rankdir;
  nodesep: number;
  ranksep: number;
  edgesep: number;
  margin: number;
  // Padding between a cluster box and its contents, in the final orientation (the label sits at the top left).
  clusterPad: Pad;
  nodes: readonly LayoutNode[];
  clusters: readonly LayoutCluster[];
  edges: readonly LayoutEdge[];
};
export type LayoutResult = {
  width: number;
  height: number;
  nodes: Map<string, Box>;
  // A cluster without members has no box.
  clusters: Map<string, Box>;
  // Same order as the input edges. Points run from the source to the target.
  edges: { points: Point[]; label: Point | null }[];
};

type Kind = 'node' | 'dummy' | 'label' | 'slot';
// A vertex of the layered graph. left and right are the extents from x (a self-loop widens the right side).
type Vertex = { kind: Kind; w: number; h: number; left: number; right: number; cluster: number; rank: number; x: number; y: number };
type Segment = { up: number; down: number; weight: number };
type Cluster = { parent: number; depth: number; pad: Pad; minCross: number; minAlong: number; lo: number; hi: number };
type NsEdge = { t: number; h: number; len: number; w: number };

const LOOP = 20;

export function layoutGraph(input: LayoutInput): LayoutResult {
  const { rankdir, nodes, edges } = input;
  const rotate = rankdir === 'LR' || rankdir === 'RL';
  const dims = (w: number, h: number): [number, number] => (rotate ? [h, w] : [w, h]);
  const pad = tbPad(input.clusterPad, rankdir);

  // ── Clusters ──
  const clusterIndex = new Map(input.clusters.map((c, i) => [c.id, i]));
  const clusters: Cluster[] = input.clusters.map((c) => ({
    parent: c.parent === undefined ? -1 : (clusterIndex.get(c.parent) ?? -1),
    depth: 0,
    pad,
    minCross: rotate ? 0 : (c.minWidth ?? 0),
    minAlong: rotate ? (c.minWidth ?? 0) : 0,
    lo: Infinity,
    hi: -Infinity,
  }));
  for (const c of clusters) {
    let p = c.parent;
    for (let guard = 0; p >= 0 && guard < clusters.length; guard++, p = clusters[p].parent) c.depth++;
  }
  const chain = (c: number): number[] => {
    const out: number[] = [];
    for (let p = c, guard = 0; p >= 0 && guard <= clusters.length; p = clusters[p].parent, guard++) out.unshift(p);
    return out;
  };

  // ── Real nodes ──
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const vs: Vertex[] = nodes.map((n) => {
    const [w, h] = dims(n.width, n.height);
    const cluster = n.cluster === undefined ? -1 : (clusterIndex.get(n.cluster) ?? -1);
    return { kind: 'node', w, h, left: w / 2, right: w / 2, cluster, rank: 0, x: 0, y: 0 };
  });
  const ends = edges.map((e) => {
    const from = nodeIndex.get(e.from);
    const to = nodeIndex.get(e.to);
    if (from === undefined || to === undefined) throw new Error(`layout: unknown node in edge ${e.from} -> ${e.to}`);
    return { from, to };
  });
  const labelDims = edges.map((e) => (e.label ? dims(e.label.width, e.label.height) : null));

  // Self-loops are drawn on the right side of their node, so reserve room there.
  ends.forEach(({ from, to }, i) => {
    if (from !== to) return;
    const lw = labelDims[i]?.[0] ?? 0;
    vs[from].right = Math.max(vs[from].right, vs[from].w / 2 + LOOP + (lw ? lw + 6 : 0) + 4);
  });

  // ── 1. Cycle removal: a depth-first search in input order reverses the edges that close a cycle ──
  const reversed = removeCycles(nodes.length, ends);

  // ── 2. Ranking ──
  // A label needs a middle layer, and parallel edges need dummies to stay apart,
  // so then every edge spans two ranks (and layers are half as far apart).
  const pairs = ends.filter(({ from, to }) => from !== to).map(({ from, to }) => (from < to ? `${from},${to}` : `${to},${from}`));
  const labeled = edges.some((e, i) => e.label && ends[i].from !== ends[i].to) || new Set(pairs).size < pairs.length;
  const minlen = labeled ? 2 : 1;
  const dag = ends.map(({ from, to }, i) => (reversed[i] ? { from: to, to: from } : { from, to })).filter(({ from, to }) => from !== to);
  const ranks = rankNodes(nodes.length, dag, minlen);
  ranks.forEach((r, i) => { vs[i].rank = r; });

  for (const [i, v] of vs.entries()) {
    if (v.cluster < 0) continue;
    for (const c of chain(v.cluster)) {
      clusters[c].lo = Math.min(clusters[c].lo, ranks[i]);
      clusters[c].hi = Math.max(clusters[c].hi, ranks[i]);
    }
  }

  // ── 3. Dummy nodes: split long edges, and put each label in its own vertex in a middle layer ──
  const segments: Segment[] = [];
  const paths: number[][] = [];
  const labelVertex: number[] = [];
  ends.forEach(({ from, to }, i) => {
    if (from === to) {
      paths.push([from]);
      labelVertex.push(-1);
      return;
    }
    const [u, v] = reversed[i] ? [to, from] : [from, to];
    const span = vs[v].rank - vs[u].rank;
    let mid = -1;
    if (labelDims[i]) {
      mid = vs[u].rank + Math.floor(span / 2);
      if (labeled && (mid - vs[u].rank) % 2 === 0) mid--;
    }
    const path = [u];
    let label = -1;
    for (let r = vs[u].rank + 1; r < vs[v].rank; r++) {
      const isLabel = r === mid;
      const [w, h] = isLabel ? (labelDims[i] ?? [0, 0]) : [0, 0];
      vs.push({ kind: isLabel ? 'label' : 'dummy', w, h, left: w / 2, right: w / 2, cluster: dummyCluster(vs[u].cluster, vs[v].cluster, r), rank: r, x: 0, y: 0 });
      if (isLabel) label = vs.length - 1;
      path.push(vs.length - 1);
    }
    path.push(v);
    for (let k = 1; k < path.length; k++) {
      const real = (vs[path[k - 1]].kind === 'node' ? 1 : 0) + (vs[path[k]].kind === 'node' ? 1 : 0);
      segments.push({ up: path[k - 1], down: path[k], weight: [8, 2, 1][real] });
    }
    paths.push(path);
    labelVertex.push(label);
  });

  function dummyCluster(a: number, b: number, r: number): number {
    let best = -1;
    for (const c of [...(b >= 0 ? chain(b) : []), ...(a >= 0 ? chain(a) : [])]) {
      if (clusters[c].lo <= r && r <= clusters[c].hi && (best < 0 || clusters[c].depth > clusters[best].depth)) best = c;
    }
    return best;
  }

  // A cluster must occupy a place in every layer it spans, even where it has no vertex, so other vertices stay outside its box.
  const maxRank = Math.max(0, ...vs.map((v) => v.rank));
  const present = new Set(vs.flatMap((v) => (v.cluster >= 0 ? chain(v.cluster).map((c) => `${c}:${v.rank}`) : [])));
  clusters.forEach((c, ci) => {
    for (let r = c.lo; r <= c.hi; r++) {
      if (present.has(`${ci}:${r}`)) continue;
      vs.push({ kind: 'slot', w: 0, h: 0, left: 0, right: 0, cluster: ci, rank: r, x: 0, y: 0 });
      for (const p of chain(ci)) present.add(`${p}:${r}`);
    }
  });

  // ── 4. Crossing reduction ──
  const layers = orderLayers(vs, segments, maxRank, chain, clusters.length);

  // ── 5 and 6. Coordinates and cluster boxes ──
  const cross = assignX(vs, layers, segments, clusters, chain, input);
  const { layerY, band, box } = assignY(vs, layers, clusters, cross, labeled ? input.ranksep / 2 : input.ranksep);

  // ── 7. Edge routing ──
  const routed = ends.map(({ from, to }, i) => {
    if (from === to) return selfLoop(vs[from], labelDims[i]);
    const path = paths[i];
    const pts = route(path.map((k) => vs[k]), layerY, band);
    if (reversed[i]) pts.reverse();
    const lv = labelVertex[i];
    return { points: pts, label: lv >= 0 ? { x: vs[lv].x, y: vs[lv].y } : null };
  });

  // ── 8. Normalize into the margin, then rotate or flip for rankdir ──
  const boxes: Box[] = [];
  vs.forEach((v) => { if (v.kind === 'node' || v.kind === 'label') boxes.push({ x: v.x, y: v.y, width: v.w, height: v.h }); });
  box.forEach((b) => { if (b) boxes.push(b); });
  routed.forEach((e, i) => {
    if (e.label && ends[i].from === ends[i].to) {
      const [w, h] = labelDims[i] ?? [0, 0];
      boxes.push({ x: e.label.x, y: e.label.y, width: w, height: h });
    }
  });
  const xs = [...boxes.flatMap((b) => [b.x - b.width / 2, b.x + b.width / 2]), ...routed.flatMap((e) => e.points.map((p) => p.x))];
  const ys = [...boxes.flatMap((b) => [b.y - b.height / 2, b.y + b.height / 2]), ...routed.flatMap((e) => e.points.map((p) => p.y))];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const tbW = Math.max(...xs) - minX + 2 * input.margin;
  const tbH = Math.max(...ys) - minY + 2 * input.margin;
  const width = rotate ? tbH : tbW;
  const height = rotate ? tbW : tbH;
  const point = (p: Point): Point => {
    const x = p.x - minX + input.margin;
    const y = p.y - minY + input.margin;
    const [fx, fy] = rotate ? [y, x] : [x, y];
    return { x: rankdir === 'RL' ? width - fx : fx, y: rankdir === 'BT' ? height - fy : fy };
  };
  const toBox = (b: Box): Box => {
    const c = point(b);
    const [w, h] = rotate ? [b.height, b.width] : [b.width, b.height];
    return { x: c.x, y: c.y, width: w, height: h };
  };

  return {
    width,
    height,
    nodes: new Map(nodes.map((n, i) => [n.id, toBox({ x: vs[i].x, y: vs[i].y, width: vs[i].w, height: vs[i].h })])),
    clusters: new Map(input.clusters.flatMap((c, i) => {
      const b = box[i];
      return b ? [[c.id, toBox(b)] as const] : [];
    })),
    edges: routed.map((e) => ({ points: e.points.map(point), label: e.label && point(e.label) })),
  };
}

// Convert padding given in the final orientation into top-to-bottom coordinates.
function tbPad(p: Pad, rankdir: Rankdir): Pad {
  if (rankdir === 'BT') return { top: p.bottom, right: p.right, bottom: p.top, left: p.left };
  if (rankdir === 'LR') return { top: p.left, right: p.bottom, bottom: p.right, left: p.top };
  if (rankdir === 'RL') return { top: p.right, right: p.bottom, bottom: p.left, left: p.top };
  return p;
}

// Returns, for each edge, whether it must be reversed to make the graph acyclic.
function removeCycles(n: number, ends: readonly { from: number; to: number }[]): boolean[] {
  const out: number[][] = Array.from({ length: n }, () => []);
  ends.forEach(({ from, to }, i) => { if (from !== to) out[from].push(i); });
  const reversed = ends.map(() => false);
  const state = Array.from({ length: n }, () => 0); // 0 unvisited, 1 on the stack, 2 done
  for (let s = 0; s < n; s++) {
    if (state[s]) continue;
    const stack: { v: number; k: number }[] = [{ v: s, k: 0 }];
    state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.k === out[top.v].length) {
        state[top.v] = 2;
        stack.pop();
        continue;
      }
      const e = out[top.v][top.k++];
      const w = ends[e].to;
      if (state[w] === 1) reversed[e] = true;
      else if (state[w] === 0) {
        state[w] = 1;
        stack.push({ v: w, k: 0 });
      }
    }
  }
  return reversed;
}

// Network simplex keeps edges short; each connected component then starts at rank 0.
function rankNodes(n: number, dag: readonly { from: number; to: number }[], minlen: number): number[] {
  const merged = new Map<string, NsEdge>();
  for (const { from, to } of dag) {
    const key = `${from},${to}`;
    const e = merged.get(key);
    if (e) e.w++;
    else merged.set(key, { t: from, h: to, len: minlen, w: 1 });
  }
  const rank = networkSimplex(n, [...merged.values()]);
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (v: number): number => {
    while (root[v] !== v) v = root[v] = root[root[v]];
    return v;
  };
  for (const { from, to } of dag) root[find(from)] = find(to);
  const low = new Map<number, number>();
  rank.forEach((r, v) => low.set(find(v), Math.min(low.get(find(v)) ?? Infinity, r)));
  return rank.map((r, v) => r - (low.get(find(v)) ?? 0));
}


// Barycenter sweeps over the layers, keeping each cluster contiguous, followed by swaps of adjacent vertices.
function orderLayers(vs: readonly Vertex[], segments: readonly Segment[], maxRank: number, chain: (c: number) => number[], clusterCount: number): number[][] {
  const up: number[][] = vs.map(() => []);
  const down: number[][] = vs.map(() => []);
  for (const s of segments) {
    down[s.up].push(s.down);
    up[s.down].push(s.up);
  }
  // Initial order: depth-first from the real nodes in input order.
  let layers: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  const seen = new Set<number>();
  const visit = (start: number): void => {
    const stack = [start];
    while (stack.length) {
      const v = stack.pop() as number;
      if (seen.has(v)) continue;
      seen.add(v);
      layers[vs[v].rank].push(v);
      for (let k = down[v].length - 1; k >= 0; k--) stack.push(down[v][k]);
    }
  };
  vs.forEach((v, i) => { if (v.kind === 'node') visit(i); });
  vs.forEach((v, i) => { if (!seen.has(i)) layers[v.rank].push(i); });

  // Sibling clusters must keep one left-to-right order in every layer, or their boxes would overlap.
  // The order is the mean relative position of their members, recomputed before each sweep.
  const clusterOrder = (ls: readonly number[][]): number[] => {
    const sum = Array.from({ length: clusterCount }, () => 0);
    const cnt = Array.from({ length: clusterCount }, () => 0);
    for (const layer of ls) {
      layer.forEach((v, i) => {
        if (vs[v].cluster < 0) return;
        for (const c of chain(vs[v].cluster)) {
          sum[c] += (i + 0.5) / layer.length;
          cnt[c]++;
        }
      });
    }
    const key = sum.map((s, c) => (cnt[c] ? s / cnt[c] : 0));
    const order = Array.from({ length: clusterCount }, () => 0);
    key.map((_, c) => c).sort((a, b) => key[a] - key[b]).forEach((c, k) => { order[c] = k; });
    return order;
  };
  let corder = clusterOrder(layers);
  layers = layers.map((layer) => arrange(layer, (v) => layer.indexOf(v), vs, chain, corder));

  const pos = new Map<number, number>();
  const index = (ls: readonly number[][]): void => ls.forEach((layer) => layer.forEach((v, i) => pos.set(v, i)));
  const count = (ls: readonly number[][]): number => {
    index(ls);
    return crossings(vs, segments, pos);
  };
  const bary = (nbrs: number[][]) => (v: number): number | undefined => {
    const ns = nbrs[v];
    return ns.length ? ns.reduce((s, u) => s + (pos.get(u) ?? 0), 0) / ns.length : undefined;
  };

  let best = layers.map((l) => [...l]);
  let bestCount = count(best);
  for (let iter = 0, stale = 0; iter < 24 && stale < 4 && bestCount > 0; iter++) {
    index(layers);
    corder = clusterOrder(layers);
    if (iter % 2 === 0) {
      for (let r = 1; r <= maxRank; r++) {
        layers[r] = arrange(layers[r], bary(up), vs, chain, corder);
        index(layers);
      }
    } else {
      for (let r = maxRank - 1; r >= 0; r--) {
        layers[r] = arrange(layers[r], bary(down), vs, chain, corder);
        index(layers);
      }
    }
    const c = count(layers);
    if (c < bestCount) {
      best = layers.map((l) => [...l]);
      bestCount = c;
      stale = 0;
    } else stale++;
  }
  layers = best;

  // Swap adjacent vertices of the same cluster while that removes crossings.
  index(layers);
  const cost = (a: number, b: number): number => {
    let c = 0;
    for (const nbrs of [up, down]) for (const pa of nbrs[a]) for (const pb of nbrs[b]) if ((pos.get(pa) ?? 0) > (pos.get(pb) ?? 0)) c++;
    return c;
  };
  for (let pass = 0, changed = true; changed && pass < 10; pass++) {
    changed = false;
    for (const layer of layers) {
      for (let i = 0; i + 1 < layer.length; i++) {
        const a = layer[i];
        const b = layer[i + 1];
        if (vs[a].cluster !== vs[b].cluster || cost(b, a) >= cost(a, b)) continue;
        layer[i] = b;
        layer[i + 1] = a;
        pos.set(b, i);
        pos.set(a, i + 1);
        changed = true;
      }
    }
  }
  return layers;
}

function crossings(vs: readonly Vertex[], segments: readonly Segment[], pos: ReadonlyMap<number, number>): number {
  const byRank = new Map<number, [number, number][]>();
  for (const s of segments) {
    const list = byRank.get(vs[s.up].rank) ?? [];
    list.push([pos.get(s.up) ?? 0, pos.get(s.down) ?? 0]);
    byRank.set(vs[s.up].rank, list);
  }
  let total = 0;
  for (const list of byRank.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) if ((list[i][0] - list[j][0]) * (list[i][1] - list[j][1]) < 0) total++;
    }
  }
  return total;
}

// Sort one layer by barycenter. Each cluster moves as one block (at the mean of its members),
// sibling clusters follow `corder`, and vertices without neighbors keep their places.
function arrange(layer: readonly number[], bary: (v: number) => number | undefined, vs: readonly Vertex[], chain: (c: number) => number[], corder: readonly number[]): number[] {
  type Item = { verts: number[]; sum: number; n: number; c: number };
  const build = (verts: readonly number[], depth: number): Item => {
    const groups = new Map<string, number[]>();
    for (const v of verts) {
      const path = vs[v].cluster >= 0 ? chain(vs[v].cluster) : [];
      const key = depth < path.length ? `c${path[depth]}` : `v${v}`;
      const list = groups.get(key) ?? [];
      list.push(v);
      groups.set(key, list);
    }
    const items = [...groups].map(([key, members]): Item => {
      if (key.startsWith('c')) return { ...build(members, depth + 1), c: Number(key.slice(1)) };
      const b = bary(members[0]);
      return { verts: members, sum: b ?? 0, n: b === undefined ? 0 : 1, c: -1 };
    });
    const slots = items.flatMap((it, i) => (it.n ? [i] : []));
    const sorted = slots.map((i) => items[i]).sort((a, b) => a.sum / a.n - b.sum / b.n);
    slots.forEach((slot, k) => { items[slot] = sorted[k]; });
    const blocks = items.flatMap((it, i) => (it.c >= 0 ? [i] : []));
    const ordered = blocks.map((i) => items[i]).sort((a, b) => corder[a.c] - corder[b.c]);
    blocks.forEach((slot, k) => { items[slot] = ordered[k]; });
    return {
      verts: items.flatMap((it) => it.verts),
      sum: items.reduce((s, it) => s + it.sum, 0),
      n: items.reduce((s, it) => s + it.n, 0),
      c: -1,
    };
  };
  return build(layer, 0).verts;
}

// Horizontal placement: network simplex on an auxiliary graph (Gansner et al.) pulls connected vertices into line
// while keeping the separation within each layer and the cluster borders. Vertices are then centered between their neighbors.
function assignX(
  vs: Vertex[],
  layers: readonly number[][],
  segments: readonly Segment[],
  clusters: readonly Cluster[],
  chain: (c: number) => number[],
  { nodesep, edgesep }: LayoutInput,
): { lo: number[]; hi: number[] } {
  const n = vs.length;
  const L = (c: number): number => n + 2 * c;
  const R = (c: number): number => n + 2 * c + 1;
  const constraints = new Map<string, NsEdge>();
  const add = (t: number, h: number, len: number, w: number): void => {
    const key = `${t},${h}`;
    const l = Math.ceil(len - 1e-6);
    const e = constraints.get(key);
    if (e) {
      e.len = Math.max(e.len, l);
      e.w += w;
    } else constraints.set(key, { t, h, len: l, w });
  };
  const sep = (v: number): number => (vs[v].kind === 'node' ? nodesep : edgesep) / 2;
  const clusterAt = (v: number, depth: number): number => (vs[v].cluster >= 0 ? (chain(vs[v].cluster)[depth] ?? -1) : -1);
  // Walk one layer as nested runs: the vertices and clusters directly inside `owner`, in order.
  const level = (verts: readonly number[], depth: number, owner: number): void => {
    const elements: { v: number; c: number }[] = [];
    for (const v of verts) {
      const c = clusterAt(v, depth);
      if (c >= 0 && elements[elements.length - 1]?.c === c) continue;
      elements.push({ v, c });
    }
    elements.forEach((el, i) => {
      if (el.c >= 0) level(verts.filter((v) => clusterAt(v, depth) === el.c), depth + 1, el.c);
      if (owner >= 0) {
        const p = clusters[owner].pad;
        if (el.c >= 0) {
          add(L(owner), L(el.c), p.left, 0);
          add(R(el.c), R(owner), p.right, 0);
        } else {
          add(L(owner), el.v, p.left + vs[el.v].left, 0);
          add(el.v, R(owner), vs[el.v].right + p.right, 0);
        }
      }
      if (i === 0) return;
      const a = elements[i - 1];
      const [t, tOff] = a.c >= 0 ? [R(a.c), nodesep / 2] : [a.v, vs[a.v].right + sep(a.v)];
      const [h, hOff] = el.c >= 0 ? [L(el.c), nodesep / 2] : [el.v, vs[el.v].left + sep(el.v)];
      add(t, h, tOff + hOff, 0);
    });
  };
  for (const layer of layers) level(layer, 0, -1);
  clusters.forEach((c, i) => { if (c.lo <= c.hi) add(L(i), R(i), c.minCross, 1); });
  const separation = [...constraints.values()];
  let next = n + 2 * clusters.length;
  for (const s of segments) {
    add(next, s.up, 0, s.weight);
    add(next, s.down, 0, s.weight);
    next++;
  }
  const x = networkSimplex(next, [...constraints.values()]);

  // Center each vertex within the range where moving it does not lengthen its edges (a label between its two ends, a node over its children).
  const into: NsEdge[][] = x.map(() => []);
  const from: NsEdge[][] = x.map(() => []);
  for (const e of separation) {
    into[e.h].push(e);
    from[e.t].push(e);
  }
  const nbrs: { v: number; w: number }[][] = vs.map(() => []);
  for (const s of segments) {
    nbrs[s.up].push({ v: s.down, w: s.weight });
    nbrs[s.down].push({ v: s.up, w: s.weight });
  }
  for (const layer of layers) {
    for (const v of layer) {
      if (vs[v].kind === 'slot' || !nbrs[v].length) continue;
      const lo = Math.max(...into[v].map((e) => x[e.t] + e.len));
      const hi = Math.min(...from[v].map((e) => x[e.h] - e.len));
      const [m1, m2] = weightedMedian(nbrs[v].map((nb) => ({ x: x[nb.v], w: nb.w })));
      const a = Math.max(lo, m1);
      const b = Math.min(hi, m2);
      if (a <= b && Number.isFinite(a) && Number.isFinite(b)) x[v] = (a + b) / 2;
    }
  }
  vs.forEach((v, i) => { v.x = x[i]; });

  // Shrink each cluster to its contents (inner clusters first), keeping the minimum width.
  const lo = clusters.map(() => NaN);
  const hi = clusters.map(() => NaN);
  const order = clusters.map((_, i) => i).sort((a, b) => clusters[b].depth - clusters[a].depth);
  for (const c of order) {
    const { pad, minCross } = clusters[c];
    let l = Infinity;
    let r = -Infinity;
    for (const v of vs) {
      if (v.cluster !== c || v.kind === 'slot') continue;
      l = Math.min(l, v.x - v.left - pad.left);
      r = Math.max(r, v.x + v.right + pad.right);
    }
    clusters.forEach((child, i) => {
      if (child.parent !== c || Number.isNaN(lo[i])) return;
      l = Math.min(l, lo[i] - pad.left);
      r = Math.max(r, hi[i] + pad.right);
    });
    if (!Number.isFinite(l)) continue;
    if (r - l < minCross) {
      r = Math.min(x[R(c)], l + minCross);
      l = r - minCross;
    }
    lo[c] = l;
    hi[c] = r;
  }
  return { lo, hi };
}

// The interval of x that minimizes the weighted sum of distances to the given points.
function weightedMedian(points: readonly { x: number; w: number }[]): [number, number] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].w;
    if (acc * 2 > total) return [sorted[i].x, sorted[i].x];
    if (acc * 2 === total) return [sorted[i].x, sorted[i + 1]?.x ?? sorted[i].x];
  }
  return [-Infinity, Infinity];
}

// Vertical placement: layers are `gap` apart, with more room where a cluster box starts or ends.
function assignY(
  vs: Vertex[],
  layers: readonly number[][],
  clusters: readonly Cluster[],
  cross: { lo: number[]; hi: number[] },
  gap: number,
): { layerY: number[]; band: number[]; box: (Box | null)[] } {
  const band = layers.map((layer) => Math.max(0, ...layer.map((v) => vs[v].h)));
  const extra = clusters.map(() => 0);
  const alive = clusters.map((_, i) => !Number.isNaN(cross.lo[i]));
  const children = clusters.map((_, i) => clusters.flatMap((c, k) => (c.parent === i && alive[k] ? [k] : [])));
  const order = clusters.map((_, i) => i).sort((a, b) => clusters[b].depth - clusters[a].depth);
  const stackB = (c: number): number => clusters[c].pad.bottom + extra[c] + Math.max(0, ...children[c].filter((k) => clusters[k].hi === clusters[c].hi).map(stackB));
  const stackT = (c: number): number => clusters[c].pad.top + Math.max(0, ...children[c].filter((k) => clusters[k].lo === clusters[c].lo).map(stackT));
  let layerY: number[] = [];
  let box: (Box | null)[] = [];
  for (let round = 0; round <= clusters.length + 1; round++) {
    layerY = [band[0] / 2];
    for (let r = 1; r < layers.length; r++) {
      const e = Math.max(0, ...clusters.flatMap((c, i) => (alive[i] && c.hi === r - 1 ? [stackB(i)] : [])));
      const s = Math.max(0, ...clusters.flatMap((c, i) => (alive[i] && c.lo === r ? [stackT(i)] : [])));
      const g = Math.max(gap, e + s + (e || s ? 12 : 0));
      layerY.push(layerY[r - 1] + band[r - 1] / 2 + g + band[r] / 2);
    }
    for (const v of vs) v.y = layerY[v.rank];
    let changed = false;
    const top = clusters.map(() => NaN);
    const bottom = clusters.map(() => NaN);
    for (const c of order) {
      if (!alive[c]) continue;
      const { pad, minAlong } = clusters[c];
      let t = Infinity;
      let b = -Infinity;
      for (const v of vs) {
        if (v.cluster !== c || v.kind === 'slot') continue;
        t = Math.min(t, v.y - v.h / 2);
        b = Math.max(b, v.y + v.h / 2);
      }
      for (const k of children[c]) {
        t = Math.min(t, top[k]);
        b = Math.max(b, bottom[k]);
      }
      t -= pad.top;
      b += pad.bottom + extra[c];
      if (b - t < minAlong - 1e-6) {
        extra[c] += minAlong - (b - t);
        changed = true;
      }
      top[c] = t;
      bottom[c] = b;
    }
    box = clusters.map((_, c) => (alive[c] ? { x: (cross.lo[c] + cross.hi[c]) / 2, y: (top[c] + bottom[c]) / 2, width: cross.hi[c] - cross.lo[c], height: bottom[c] - top[c] } : null));
    if (!changed) break;
  }
  return { layerY, band, box };
}

// Points of an edge from the upper vertex to the lower one. Inside a layer the edge runs vertically,
// so it never cuts through another vertex of that layer; it bends only in the gaps between layers.
function route(path: readonly Vertex[], layerY: readonly number[], band: readonly number[]): Point[] {
  const u = path[0];
  const v = path[path.length - 1];
  const inner: Point[] = [];
  for (const d of path.slice(1, -1)) {
    const y = layerY[d.rank];
    const h = band[d.rank];
    if (h > 0) inner.push({ x: d.x, y: y - h / 2 }, { x: d.x, y: y + h / 2 });
    else inner.push({ x: d.x, y });
  }
  const sx = faceX(u, inner[0] ?? v);
  const ex = faceX(v, inner[inner.length - 1] ?? u);
  const pts: Point[] = [{ x: sx, y: u.y + u.h / 2 }];
  const below = layerY[u.rank] + band[u.rank] / 2;
  if (below > u.y + u.h / 2 + 0.5) pts.push({ x: sx, y: below });
  pts.push(...inner);
  const above = layerY[v.rank] - band[v.rank] / 2;
  if (above < v.y - v.h / 2 - 0.5) pts.push({ x: ex, y: above });
  pts.push({ x: ex, y: v.y - v.h / 2 });
  return pts;
}

// Where an edge leaves the top or bottom face of a vertex: the face point toward the next point, kept off the corners.
function faceX(n: Vertex, toward: Point): number {
  const dx = toward.x - n.x;
  const dy = Math.abs(toward.y - n.y);
  const limit = Math.max(0, n.w / 2 - Math.min(8, n.w / 4));
  const off = dy < 1e-6 ? Math.sign(dx) * limit : (dx * n.h) / 2 / dy;
  return n.x + Math.max(-limit, Math.min(limit, off));
}

function selfLoop(v: Vertex, label: [number, number] | null): { points: Point[]; label: Point | null } {
  const r = v.x + v.w / 2;
  const top = v.y - v.h / 4;
  const bottom = v.y + v.h / 4;
  const points = [{ x: r, y: top }, { x: r + LOOP, y: top }, { x: r + LOOP, y: bottom }, { x: r, y: bottom }];
  return { points, label: label ? { x: r + LOOP + 6 + label[0] / 2, y: v.y } : null };
}

// Network simplex (Gansner et al. 1993): integer values x[v] that satisfy x[h] - x[t] >= len for every edge
// and minimize the sum of w * (x[h] - x[t]). The edges must form a DAG. A virtual root ties the components together.
function networkSimplex(n: number, input: readonly NsEdge[]): number[] {
  const root = n;
  const size = n + 1;
  const edges: NsEdge[] = [...input, ...Array.from({ length: n }, (_, v) => ({ t: root, h: v, len: 0, w: 0 }))];
  const adj: number[][] = Array.from({ length: size }, () => []);
  const netOut = Array.from({ length: size }, () => 0);
  edges.forEach((e, i) => {
    adj[e.t].push(i);
    adj[e.h].push(i);
    netOut[e.t] += e.w;
    netOut[e.h] -= e.w;
  });

  // Feasible start: longest path from the root.
  const rank = Array.from({ length: size }, () => 0);
  const indeg = Array.from({ length: size }, () => 0);
  for (const e of edges) indeg[e.h]++;
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    for (const i of adj[v]) {
      const e = edges[i];
      if (e.t !== v) continue;
      rank[e.h] = Math.max(rank[e.h], rank[v] + e.len);
      if (--indeg[e.h] === 0) queue.push(e.h);
    }
  }
  if (queue.length < size) throw new Error('layout: the constraint graph has a cycle');
  const slack = (e: NsEdge): number => rank[e.h] - rank[e.t] - e.len;

  // Tight spanning tree: grow along tight edges, and shift the tree to make the nearest edge tight.
  const inTree = new Uint8Array(size);
  const tree = new Uint8Array(edges.length);
  const members = [root];
  inTree[root] = 1;
  const grow = (): void => {
    const stack = [...members];
    while (stack.length) {
      const v = stack.pop() as number;
      for (const i of adj[v]) {
        const e = edges[i];
        const w = e.t === v ? e.h : e.t;
        if (tree[i] || inTree[w] || slack(e) !== 0) continue;
        tree[i] = 1;
        inTree[w] = 1;
        members.push(w);
        stack.push(w);
      }
    }
  };
  grow();
  while (members.length < size) {
    let best = -1;
    edges.forEach((e, i) => {
      if (inTree[e.t] !== inTree[e.h] && (best < 0 || slack(e) < slack(edges[best]))) best = i;
    });
    const e = edges[best];
    const delta = inTree[e.t] ? slack(e) : -slack(e);
    for (const v of members) rank[v] += delta;
    grow();
  }

  // Postorder low/lim numbering of the tree, ranks along the tree, and the cut value of each tree edge.
  // The cut value of the edge above v is the net weight leaving v's subtree, negated when the edge points into v.
  const parent = new Int32Array(size);
  const low = new Int32Array(size);
  const lim = new Int32Array(size);
  const cut = new Float64Array(size);
  const treeAdj: number[][] = Array.from({ length: size }, () => []);
  edges.forEach((e, i) => {
    if (!tree[i]) return;
    treeAdj[e.t].push(i);
    treeAdj[e.h].push(i);
  });
  const refresh = (): void => {
    const post: number[] = [];
    const stack: { v: number; k: number; low: number }[] = [{ v: root, k: 0, low: 0 }];
    const seen = new Uint8Array(size);
    seen[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.k === treeAdj[top.v].length) {
        lim[top.v] = post.length;
        low[top.v] = top.low;
        post.push(top.v);
        stack.pop();
        continue;
      }
      const i = treeAdj[top.v][top.k++];
      const e = edges[i];
      const w = e.t === top.v ? e.h : e.t;
      if (seen[w]) continue;
      seen[w] = 1;
      parent[w] = i;
      rank[w] = e.t === w ? rank[top.v] - e.len : rank[top.v] + e.len;
      stack.push({ v: w, k: 0, low: post.length });
    }
    const sub = new Float64Array(size);
    for (const v of post) {
      sub[v] += netOut[v];
      if (v === root) continue;
      const e = edges[parent[v]];
      cut[v] = e.t === v ? sub[v] : -sub[v];
      sub[e.t === v ? e.h : e.t] += sub[v];
    }
  };
  refresh();

  // Replace a tree edge with a negative cut value by the tightest edge that crosses the same cut the other way.
  let cursor = 0;
  for (let iter = 0; iter < 5000; iter++) {
    let c = -1;
    for (let k = 0; k < size; k++) {
      const v = (cursor + k) % size;
      if (v !== root && cut[v] < 0) {
        c = v;
        break;
      }
    }
    if (c < 0) break;
    cursor = c + 1;
    const leaving = parent[c];
    const tailInside = edges[leaving].t === c;
    const inside = (v: number): boolean => low[c] <= lim[v] && lim[v] <= lim[c];
    let entering = -1;
    edges.forEach((f, i) => {
      if (tree[i] || inside(f.t) === tailInside || inside(f.h) !== tailInside) return;
      if (entering < 0 || slack(f) < slack(edges[entering])) entering = i;
    });
    if (entering < 0) break;
    tree[leaving] = 0;
    tree[entering] = 1;
    for (const v of [edges[leaving].t, edges[leaving].h]) treeAdj[v] = treeAdj[v].filter((i) => i !== leaving);
    treeAdj[edges[entering].t].push(entering);
    treeAdj[edges[entering].h].push(entering);
    refresh();
  }
  return rank.slice(0, n);
}
