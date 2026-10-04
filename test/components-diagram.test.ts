import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, ComponentError } from '../src/components/index.ts';
import type { Component, RenderContext } from '../src/components/index.ts';
import { parseFlow } from '../src/components/flow.ts';
import { parseSequence } from '../src/components/sequence.ts';
import { smoothPath } from '../src/svg/shapes.ts';

const ctx = (args = ''): RenderContext => ({ args, uid: () => 'u1' });
const component = (name: string): Component => {
  const c = COMPONENTS.get(name);
  if (!c) throw new Error(`unknown component: ${name}`);
  return c;
};
const render = (name: string, text: string, args?: string): string => component(name).render(text, ctx(args));
const throwsAt = (fn: () => unknown, line: number): void =>
  assert.throws(fn, (e) => e instanceof ComponentError && e.line === line);
const viewBox = (svg: string): number[] => {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(m, 'viewBox がない');
  return m.slice(1).map(Number);
};

// ── shapes ──
test('smoothPath: 2 点なら直線、3 点以上ならなめらかな曲線', () => {
  assert.equal(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0,0 L10,0');
  assert.match(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), /^M0,0 L5,0 Q10,0 10,5 L10,10$/);
});

// ── sequence ──
test('parseSequence: 参加者は登場順。実線・点線・自分自身の呼び出し・注記', () => {
  const m = parseSequence('A -> B: リクエスト\nB --> A: レスポンス\nB -> B: 検証\nnote A, B: 接続を確立');
  assert.deepEqual(m.participants, ['A', 'B']);
  assert.deepEqual(m.steps.map((s) => s.kind), ['msg', 'msg', 'msg', 'note']);
  const [, reply, self, note] = m.steps;
  assert.ok(reply.kind === 'msg' && self.kind === 'msg' && note.kind === 'note');
  assert.equal(reply.dashed, true);
  assert.equal(self.from, self.to);
  assert.deepEqual(note.over, ['A', 'B']);
});

test('parseSequence: participants の行で並び順を固定する', () => {
  const m = parseSequence('participants: Server, Client\nClient -> Server: SYN');
  assert.deepEqual(m.participants, ['Server', 'Client']);
});

test('sequence: 参加者の枠・生存線・矢印のラベルを含む SVG を出す', () => {
  const svg = render('sequence', 'Client -> Server: SYN\nServer --> Client: SYN-ACK');
  assert.match(svg, /^<figure class="am-diagram am-seq">/);
  assert.match(svg, /aria-label="シーケンス図：Client、Server"/);
  assert.equal((svg.match(/class="am-actor"/g) || []).length, 2);
  assert.equal((svg.match(/class="am-lifeline"/g) || []).length, 2);
  assert.match(svg, />SYN<\/text>/);
  assert.match(svg, /am-edge am-edge--dashed/);
  assert.match(svg, /marker-end="url\(#u1-arrow\)"/);
});

test('sequence: 長いメッセージのラベルは参加者の間隔を広げる', () => {
  const short = viewBox(render('sequence', 'A -> B: x'))[0];
  const long = viewBox(render('sequence', 'A -> B: これはとても長いメッセージのラベルなので間隔を広げる必要がある'))[0];
  assert.ok(long > short + 100, `short=${short} long=${long}`);
});

test('sequence: 引数 num で番号をつける', () => {
  assert.match(render('sequence', 'A -> B: x', 'num'), /class="am-step"[^>]*>1<\/text>/);
});

test('sequence: 解析できない行は行番号を示す', () => {
  throwsAt(() => render('sequence', 'A -> B: ok\nA => B'), 2);
});

// ── flow ──
test('parseFlow: 連鎖・分岐・形の印・強調・矢印のラベル', () => {
  const m = parseFlow('(開始) -> 入力 -> {正しい?}\n正しい? -> 処理 & *[(DB)]: はい\n正しい? --> エラー: いいえ');
  const shape = Object.fromEntries([...m.nodes.values()].map((n) => [n.id, n.shape]));
  assert.deepEqual(shape, { 開始: 'round', 入力: 'rect', '正しい?': 'diamond', 処理: 'rect', DB: 'db', エラー: 'rect' });
  assert.equal(m.nodes.get('DB')?.hi, true);
  assert.equal(m.edges.length, 5);
  assert.deepEqual(m.edges.filter((e) => e.label === 'はい').map((e) => e.to), ['処理', 'DB']);
  assert.equal(m.edges.find((e) => e.to === 'エラー')?.dashed, true);
});

test('parseFlow: 角括号でコロンを含むノードの文字を守る', () => {
  const m = parseFlow('[Part 1: rules] -> [Part 2: dict]: 参照');
  assert.ok(m.nodes.has('Part 1: rules'));
  assert.equal(m.edges[0].label, '参照');
});

test('parseFlow: group でグループを宣言する', () => {
  const m = parseFlow('ゲートウェイ -> 認証\nゲートウェイ -> 業務\ngroup バックエンド: 認証, 業務');
  assert.deepEqual(m.groups, [{ name: 'バックエンド', members: ['認証', '業務'], line: 3 }]);
});

test('flow: ノード・矢印・ラベル・グループがそろった SVG を出す', () => {
  const svg = render('flow', 'ユーザー -> ゲートウェイ: HTTPS\nゲートウェイ -> 認証\nゲートウェイ -> 業務\ngroup バックエンド: 認証, 業務');
  assert.match(svg, /^<figure class="am-diagram am-flow">/);
  assert.equal((svg.match(/class="am-node /g) || []).length, 4);
  assert.equal((svg.match(/class="am-edge"/g) || []).length, 3);
  assert.match(svg, /class="am-edge-label".*>HTTPS<\/text>/s);
  assert.match(svg, /class="am-cluster"/);
  assert.match(svg, />バックエンド<\/text>/);
  assert.match(svg, /aria-label="フロー図：ユーザー、ゲートウェイ、認証、業務"/);
});

test('flow: LR は横長、TB は縦長になる', () => {
  const src = 'A -> B -> C -> D';
  const [wTB, hTB] = viewBox(render('flow', src));
  const [wLR, hLR] = viewBox(render('flow', src, 'LR'));
  assert.ok(hTB > wTB && wLR > hLR);
});

test('flow: ひし形は polygon、データベースは円柱で描く', () => {
  const svg = render('flow', '{判定?} -> [(DB)]');
  assert.match(svg, /<polygon class="am-node-shape"/);
  assert.match(svg, /am-node--db/);
});

test('flow: 存在しないノードを参照する group と、空の図はエラー', () => {
  throwsAt(() => render('flow', 'A -> B\ngroup G: A, X'), 2);
  throwsAt(() => render('flow', '  '), 1);
});

test('flow: 閉じていない形の括弧はエラー', () => {
  throwsAt(() => render('flow', 'A -> B\n(閉じない -> C'), 2);
});

test('flow: 差分の印で追加・変更・削除のノードと矢印を色分けし、使った種類だけ凡例を出す', () => {
  const cases = [
    {
      name: 'ノードの印と矢印の印',
      src: 'API -> ~検索 +-> +[(Redis)]\n検索 x-> -旧キャッシュ',
      want: ['am-node--chg', 'am-node--add', 'am-node--del', 'am-edge--add', 'am-edge--del', '-arrow-add', '-arrow-del', 'am-legend-item--add', 'am-legend-item--chg', 'am-legend-item--del'],
      notWant: [],
    },
    {
      name: '追加だけなら凡例は追加だけ',
      src: 'A -> +B',
      want: ['am-node--add', 'am-legend-item--add'],
      notWant: ['am-legend-item--chg', 'am-legend-item--del', '-arrow-add'],
    },
    {
      name: '印がなければ凡例を出さない',
      src: 'A -> B',
      want: [],
      notWant: ['am-legend', 'am-node--add'],
    },
    {
      name: '末尾が x のノード名は削除の矢印と区別する',
      src: 'Redix -> B',
      want: [],
      notWant: ['am-edge--del'],
    },
  ];
  for (const c of cases) {
    const svg = render('flow', c.src);
    for (const w of c.want) if (!svg.includes(w)) assert.fail(`${c.name}: ${w} がない`);
    for (const w of c.notWant) if (svg.includes(w)) assert.fail(`${c.name}: ${w} がある`);
  }
  const model = parseFlow('API -> ~検索 +-> +[(Redis)]');
  if (model.nodes.get('Redis')?.shape !== 'db') assert.fail('印と形の括弧を併用できない');
  if (model.nodes.get('検索')?.diff !== 'chg') assert.fail('~ が変更として解析されない');
});
