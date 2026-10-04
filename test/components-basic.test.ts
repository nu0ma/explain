import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, ComponentError } from '../src/components/index.ts';

const ctx = (args = '') => ({ args, uid: (() => { let n = 0; return () => `u${++n}`; })() });
const render = (name, text, args) => COMPONENTS.get(name).render(text, ctx(args));
const throwsAt = (fn, line) =>
  assert.throws(fn, (e) => e instanceof ComponentError && e.line === line);

test('どの部品にも name / summary / syntax / example があり、example を描画できる', () => {
  assert.ok(COMPONENTS.size >= 4);
  for (const [name, c] of COMPONENTS) {
    for (const key of ['summary', 'syntax', 'example']) assert.ok(c[key], `${name}.${key}`);
    const m = c.example.match(/^```(\S+)\s*(.*)\n([\s\S]*?)\n```$/);
    assert.ok(m, `${name}.example は 1 つの完全なコードブロックであること`);
    assert.equal(m[1], name);
    assert.ok(c.render(m[3], ctx(m[2])).length > 0);
  }
});

// ── callout ──
test('callout: 種類 + 見出し + Markdown の本文', () => {
  const html = render('callout', '先に **バルブ** を閉じる。', 'warn 注意');
  assert.match(html, /am-callout am-callout--warn/);
  assert.match(html, /am-callout-title">注意/);
  assert.match(html, /<strong>バルブ<\/strong>/);
});

test('callout: 最初の引数が種類でなければ全体を見出しにし、種類は info', () => {
  const html = render('callout', '本文', '結論');
  assert.match(html, /am-callout--info/);
  assert.match(html, /結論/);
});

test('callout: 見出しも本文も空ならエラー', () => {
  throwsAt(() => render('callout', '  ', ''), 1);
});

// ── kv ──
test('kv: キーと値、最初のコロンで分ける、全角コロン、* の幅広セル、cols 引数', () => {
  const html = render('kv', '* Title: STE: overview\nOwner：ASD\nSheet: 1 of 1', 'cols=3');
  assert.match(html, /--kv-cols: 3/);
  assert.match(html, /am-kv-cell--wide"><dt>Title<\/dt><dd>STE: overview<\/dd>/);
  assert.match(html, /<dt>Owner<\/dt><dd>ASD<\/dd>/);
});

test('kv: コロンのない行は相対行番号を示す', () => {
  throwsAt(() => render('kv', 'a: 1\n\nコロンなし'), 3);
});

// ── timeline ──
test('timeline: 既定は横向き。* で強調し、3 列目は説明', () => {
  const html = render('timeline', '4/1 | 着手 | 設計レビュー\n*4/15 | リリース');
  assert.match(html, /am-timeline--h" style="--n: 2"/);
  assert.match(html, /am-tl-item--hi/);
  assert.match(html, /am-tl-when">4\/15/);
  assert.match(html, /am-tl-text">設計レビュー/);
});

test('timeline: 7 項目以上か引数 v なら縦向き', () => {
  const many = Array.from({ length: 7 }, (_, i) => `${2000 + i} | 出来事${i}`).join('\n');
  assert.match(render('timeline', many), /am-timeline--v/);
  assert.match(render('timeline', 'a | b', 'v'), /am-timeline--v/);
});

test('timeline: | がなければエラー', () => {
  throwsAt(() => render('timeline', 'a | b\n1 列だけ'), 2);
});

// ── annot ──
test('annot: [文字]{注釈} を下線と注釈にし、! で誤りの表示にする', () => {
  const html = render('annot', '# 1 手順の文 | 13 字\nMake sure [the pump]{Technical name} is [on]{!Not "activated"}.\n> 説明');
  assert.match(html, /am-annot-head"><span>1 手順の文<\/span><span class="am-annot-meta">13 字/);
  assert.match(html, /<span class="am-seg"><span class="am-seg-t">the pump<\/span><span class="am-seg-n" style="--row: 0">Technical name<\/span><\/span>/);
  assert.match(html, /am-seg am-seg--err/);
  assert.match(html, /am-annot-caption">説明/);
});

test('annot: 重なる注釈は自動で段をずらす', () => {
  const html = render('annot', '[a]{a long annotation text here} [b]{another long one}');
  assert.match(html, /--row: 1/);
  assert.match(html, /--rows: 2/);
});

test('annot: 本文の HTML をエスケープする', () => {
  const html = render('annot', 'if [a < b]{比較} then');
  assert.match(html, /a &lt; b/);
});

test('annot: 閉じていない注釈はエラー', () => {
  throwsAt(() => render('annot', 'ok line\nbad [seg]{note'), 2);
});

test('annot: 注釈の文字がない {!} だけの文は折り返してよい', () => {
  const html = render('annot', 'It is [imperative]{!} that you [ensure]{!} it.');
  assert.match(html, /am-annot-line am-annot-line--wrap" style="--rows: 0"/);
});
