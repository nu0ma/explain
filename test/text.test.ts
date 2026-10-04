import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, wrap, esc, isCJK } from '../src/svg/text.ts';

test('esc: HTML の特殊文字をエスケープする', () => {
  assert.equal(esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(undefined), '');
});

test('isCJK: 漢字・かな・全角記号を全角文字とみなす', () => {
  const cases = [
    { req: '漢', want: true },
    { req: 'か', want: true },
    { req: 'カ', want: true },
    { req: '、', want: true },
    { req: 'a', want: false },
  ];
  for (const { req, want } of cases) assert.equal(isCJK(req), want, req);
});

test('measure: 全角文字の幅は文字サイズとほぼ同じで、英字はずっと狭い', () => {
  assert.equal(measure('日本', 10), 20);
  const latin = measure('ab', 10);
  assert.ok(latin > 8 && latin < 14, `latin=${latin}`);
  assert.ok(measure('WWW', 10) > measure('iii', 10));
});

test('measure: 等幅ではラテン文字 1 字を 0.6em とする', () => {
  assert.equal(measure('abcd', 10, { mono: true }), 24);
  assert.equal(measure('日', 10, { mono: true }), 10);
});

test('wrap: 英語は単語単位で折り返し、単語を割らない', () => {
  const lines = wrap('the quick brown fox jumps', 60, 10);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(' '), 'the quick brown fox jumps');
  for (const l of lines) assert.ok(!l.startsWith(' ') && !l.endsWith(' '));
});

test('wrap: 日本語は 1 字単位で折り返し、各行が幅を超えない', () => {
  assert.deepEqual(wrap('あいうえおかきくけこ', 40, 10), ['あいうえ', 'おかきく', 'けこ']);
});

test('wrap: 長すぎる単語は 1 行を占め、字を落とさない', () => {
  const lines = wrap('supercalifragilistic ok', 50, 10);
  assert.equal(lines[0], 'supercalifragilistic');
  assert.equal(lines[1], 'ok');
});

test('wrap: 空文字列なら空の 1 行を返す', () => {
  assert.deepEqual(wrap('', 50, 10), ['']);
});
