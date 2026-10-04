import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, ComponentError } from '../src/components/index.ts';
import type { Component, RenderContext } from '../src/components/index.ts';
import { niceScale } from '../src/components/limits.ts';

const ctx = (args = ''): RenderContext => ({ args, uid: () => 'u1' });
const component = (name: string): Component => {
  const c = COMPONENTS.get(name);
  if (!c) throw new Error(`unknown component: ${name}`);
  return c;
};
const render = (name: string, text: string, args?: string): string => component(name).render(text, ctx(args));
const throwsAt = (fn: () => unknown, line: number): void =>
  assert.throws(fn, (e) => e instanceof ComponentError && e.line === line);

const STE_TREE = `ASD-STE100 | Simplified Technical English
  Part 1: Writing rules
    \`Section 1\` Words
    \`Section 2\` Noun clusters
  *Part 2: Dictionary
    Approved words | 大文字の語、1 語 1 義
      子の項目`;

// ── tree ──
test('tree: 根 1 つ + 子 2〜4 個 → 組織図（根の枠 + 列 + 子のリスト）', () => {
  const html = render('tree', STE_TREE);
  assert.match(html, /am-tree-box am-tree-box--root"[^>]*>ASD-STE100<small>Simplified Technical English<\/small>/);
  assert.match(html, /am-tree-cols" style="--n: 2"/);
  assert.match(html, /<span class="am-tree-tag">Section 1<\/span> Words/);
  assert.match(html, /am-tree-sub">大文字の語、1 語 1 義/);
  assert.match(html, /<li[^>]*><span class="am-tree-label">子の項目<\/span><\/li>/, '3 段目は子のリスト');
});

test('tree: 先頭の * でノードを強調する', () => {
  assert.match(render('tree', STE_TREE), /am-tree-box am-tree-box--hi"[^>]*>Part 2: Dictionary/);
});

test('tree: 引数 list か子が 5 個以上ならリストで描く', () => {
  assert.match(render('tree', STE_TREE, 'list'), /am-tree-root--solo/);
  const wide = `根\n${['a', 'b', 'c', 'd', 'e'].map((x) => `  ${x}`).join('\n')}`;
  const html = render('tree', wide);
  assert.doesNotMatch(html, /am-tree-cols/);
  assert.match(html, /am-tree-list/);
});

test('tree: 根が複数なら横に並べ、根の枠を出さない', () => {
  const html = render('tree', '前\n  a\n後\n  b');
  assert.match(html, /am-tree-cols am-tree-cols--free" style="--n: 2"/);
  assert.doesNotMatch(html, /am-tree-box--root/);
});

test('tree: Tab の字下げは空白 2 つと同じ', () => {
  const html = render('tree', '根\n\t子1\n\t子2');
  assert.match(html, /--n: 2/);
});

test('tree: 中身が空ならエラー', () => {
  throwsAt(() => render('tree', '\n  \n'), 1);
});

// ── limits ──
test('niceScale: 目盛りの上限は切りのよい値で余裕を残し、目盛りは 7 個以下', () => {
  assert.deepEqual(niceScale(20), { max: 30, step: 5 });
  assert.deepEqual(niceScale(6), { max: 10, step: 2 });
  assert.deepEqual(niceScale(3), { max: 5, step: 1 });
  for (const v of [1, 7, 13, 99, 1234]) {
    const { max, step } = niceScale(v);
    assert.ok(max >= v * 1.2 && max / step <= 7, `v=${v} → ${max}/${step}`);
  }
});

test('limits: 値 / 上限 → 塗りの幅・上限の印・単位', () => {
  const html = render('limits', '手順の文 | 13 / 20 | words');
  assert.match(html, /am-lim-fill" style="width: 43.33%"/);
  assert.match(html, /am-lim-mark" style="left: 66.67%"/);
  assert.match(html, /am-lim-val">13 \/ max 20 words/);
});

test('limits: 上限だけなら上限まで塗る。max の前置きも使える', () => {
  const html = render('limits', '名詞の連続 | max 3 | words');
  assert.match(html, /am-lim-fill" style="width: 60%"/);
  assert.match(html, /am-lim-val">max 3 words/);
});

test('limits: 上限を超えると赤く、4 列目は備考', () => {
  const html = render('limits', '段落の文 | 8 / 6 | 文 | 例外：リスト');
  assert.match(html, /am-lim is-over/);
  assert.match(html, /am-lim-note">例外：リスト/);
});

test('limits: 目盛りに 0 と上限を含む', () => {
  const html = render('limits', 'x | 20');
  assert.match(html, /<span style="left: 0%">0<\/span>/);
  assert.match(html, /<span style="left: 100%">30<\/span>/);
});

test('limits: 数でない値や列の不足はエラー', () => {
  throwsAt(() => render('limits', 'a | 1 / 2\nb | たくさん'), 2);
  throwsAt(() => render('limits', 'ラベルだけ'), 1);
});

test('limits: 上限が 0 以下、現在値が負、大きすぎる数はエラー', () => {
  const big = '9'.repeat(400);
  for (const row of ['x | 0', 'x | 0 / 0', 'x | 1 / 0', 'x | -5', 'x | -1 / 10', `x | ${big}`, `x | 1 / ${big}`]) {
    throwsAt(() => render('limits', `a | 1 / 2\n${row}`), 2);
  }
});

test('limits: 微小な値でも目盛りを有限個にし、切りのよい値で描く', () => {
  const html = render('limits', 'x | 0.00001 / 0.00002\ny | 0.0001');
  const ticks = html.match(/<span style="left: [^"]*">/g) ?? [];
  assert.ok(ticks.length > 0 && ticks.length <= 16, `目盛り ${ticks.length} 個`);
  assert.match(html, /am-lim-fill" style="width: 33.33%"/);
  assert.match(html, />0.00003<\/span>/);
});

test('niceScale: 上限は常に正で、目盛りの数は 7 個以下', () => {
  for (const v of [1e-12, 0.00001, 0.0001, 0.3, 1e9]) {
    const { max, step } = niceScale(v);
    assert.ok(max > v && step > 0 && max / step <= 7, `v=${v} → ${max}/${step}`);
  }
});

test('niceScale: 整数の上限には整数の目盛りだけを使う', () => {
  assert.deepEqual(niceScale(1), { max: 2, step: 1 });
  assert.deepEqual(niceScale(2), { max: 3, step: 1 });
});

test('tree: ラベル全体がインラインコードならコードの見た目のまま', () => {
  assert.match(render('tree', '根\n  `bin/explain.js` | 入口\n  `src/`', 'list'), /<span class="am-tree-label"><code>bin\/explain.js<\/code><\/span>/);
});
