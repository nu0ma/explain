import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDoc, RenderError, UI } from '../src/render.js';
import { SIMPLIFIED_ONLY } from './helpers/chinese.js';
import { ParseError } from '../src/parse.js';

const SRC = `---
title: テストページ
subtitle: 副題
source: example.org
---
導入文の **太字**。

## A 表 {span=2 meta="Section 3"}
| 書き方 | 状態 |
|---|---|
| 命令形 | ok 承認済み |
| 進行形 | no |

## 生のブロック
\`\`\`html
<div class="raw-x">raw</div>
\`\`\`
\`\`\`python
print("<x>")
\`\`\`
`;

test('render: 1 ファイルの完全な HTML を出す。lang は ja で、テーマ属性と viewport を持つ', () => {
  const { html, meta } = renderDoc(SRC);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="ja" data-theme="blueprint" data-mode="auto">/);
  assert.match(html, /name="viewport"/);
  assert.equal(meta.template, 'sheet');
});

test('render: 外部依存なし。http(s) のスクリプト・スタイル・フォントを参照しない', () => {
  const { html } = renderDoc(SRC);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/);
});

test('render: パネルの ID・題名・meta・span が効く', () => {
  const { html } = renderDoc(SRC);
  assert.match(html, /id="panel-A" style="grid-column: span 2"/);
  assert.match(html, /<span class="am-panel-meta">Section 3<\/span>/);
  assert.match(html, /<h2>生のブロック<\/h2>/);
});

test('render: ページ上部に題名・副題・追加の meta・導入文が出る', () => {
  const { html } = renderDoc(SRC);
  assert.match(html, /<h1>テストページ<\/h1>/);
  assert.match(html, /am-sub">副題/);
  assert.match(html, /<b>source<\/b>example.org/);
  assert.match(html, /<strong>太字<\/strong>/);
});

test('render: 表の状態語をバッジにする', () => {
  const { html } = renderDoc(SRC);
  assert.match(html, /am-status--ok"><span class="am-status-icon" aria-hidden="true">✓<\/span>承認済み/);
  assert.match(html, /am-status--no/);
  assert.match(html, /am-table-wrap/);
});

test('render: html ブロックはそのまま埋め込み、未知の言語はエスケープしたコードブロックにする', () => {
  const { html } = renderDoc(SRC);
  assert.match(html, /<div class="raw-x">raw<\/div>/);
  assert.match(html, /<pre class="am-code"><code data-lang="python">print\(&quot;&lt;x&gt;&quot;\)<\/code><\/pre>/);
});

test('render: 原稿をエスケープして隠し textarea に埋め込み、元どおりに取り出せる', () => {
  const src = '## A\n```html\n<script>x</script></textarea>\n```';
  const { html } = renderDoc(src);
  const embedded = html.match(/<textarea id="am-source" hidden readonly aria-hidden="true">([\s\S]*?)<\/textarea>/)[1];
  assert.doesNotMatch(embedded, /<\/?(script|textarea)/);
  const unescaped = embedded.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(unescaped, src);
});

test('render: フッターに版と生成日時を出す', () => {
  assert.match(renderDoc('## A\nx').html, /<footer class="am-colophon">explain \d+\.\d+\.\d+ で生成 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/footer>/);
});

test('render: コマンドラインの上書きが効き、値を検証する', () => {
  const { html } = renderDoc(SRC, { theme: 'shadcn', template: 'doc' });
  assert.match(html, /data-theme="shadcn"/);
  assert.match(html, /class="am-doc"/);
  assert.throws(() => renderDoc(SRC, { theme: 'x' }), ParseError);
});

test('render: doc テンプレートはパネルが 3 枚以上なら目次を出す', () => {
  const { html } = renderDoc('---\ntemplate: doc\n---\n## 一\na\n## 二\nb\n## 三\nc');
  assert.match(html, /<nav class="am-toc" aria-label="目次"/);
  assert.match(html, /href="#panel-C">C · 三/);
});

test('render: ボタンは日本語。英語だけの原稿でも lang は ja', () => {
  const { html } = renderDoc('# Hello world\n## A Overview\nThis is a plain English page.');
  assert.match(html, /<html lang="ja"/);
  for (const label of ['テーマ：図面', '配色：システムに合わせる', '原稿をコピー', 'コピーしました ✓']) assert.ok(html.includes(label), label);
  assert.deepEqual(UI.theme, { blueprint: 'テーマ：図面', shadcn: 'テーマ：カード' });
  assert.deepEqual(UI.mode, { auto: '配色：システムに合わせる', light: '配色：ライト', dark: '配色：ダーク' });
});

test('render: 生成した HTML に簡体字の文言が出ない', () => {
  const { html } = renderDoc(SRC.replace('## 生のブロック', '## 図 {span=2}\n```flow\nA -> B\n```\n```sequence\nA -> B: x\n```\n## 生のブロック'), { template: 'doc' });
  const found = [...html].filter((c) => SIMPLIFIED_ONLY.has(c));
  assert.deepEqual(found, []);
  assert.match(html, /aria-label="フロー図：A、B"/);
  assert.match(html, /aria-label="シーケンス図：A、B"/);
});

test('render --static: script・ボタン・原稿の埋め込みを出さず、配色は OS の設定に従う', () => {
  const cases = [
    { name: '--static', req: { src: SRC, overrides: { static: true, mode: 'dark' } } },
    { name: 'frontmatter', req: { src: SRC.replace('---\n導入文', 'static: true\n---\n導入文'), overrides: {} } },
  ];
  for (const { name, req } of cases) {
    const { html, static: isStatic } = renderDoc(req.src, req.overrides);
    assert.equal(isStatic, true, name);
    assert.doesNotMatch(html, /<script/i, name);
    assert.doesNotMatch(html, /am-toolbar"|data-am=|am-source/, name);
    assert.match(html, /<html lang="ja" data-theme="blueprint" data-mode="auto" data-static>/, name);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/, name);
    assert.doesNotMatch(html, /<b>static<\/b>/, `${name}: static はメタ情報行に出さない`);
  }
});

test('render --static: 原稿に JavaScript があればエラーにする', () => {
  const cases = [
    '## A\n```html\n<script>alert(1)</script>\n```',
    '## A\n```html\n<img src="x" onerror="alert(1)">\n```',
    '## A\n[リンク](javascript:alert(1))',
  ];
  for (const src of cases) assert.throws(() => renderDoc(src, { static: true }), ParseError, src);
  assert.doesNotThrow(() => renderDoc(cases[0]), 'static でなければそのまま埋め込む');
});

test('render: frontmatter の static は true / false だけ', () => {
  assert.throws(() => renderDoc('---\nstatic: yes\n---\n## A\nx'), /static.*true.*false/);
  assert.equal(renderDoc('---\nstatic: false\n---\n## A\nx').static, false);
});

test('render: パネルと部品の数を集計する', () => {
  const { stats } = renderDoc(SRC);
  assert.equal(stats.panels, 2);
});

test('RenderError に行番号を持たせられる', () => {
  assert.equal(new RenderError('x', { line: 3 }).line, 3);
});

test('render: rows で縦にまたがり、bare でパネルの見出しを消す', () => {
  const { html } = renderDoc('## A 高いパネル {rows=2 span=2}\nx\n## B {bare}\ny');
  assert.match(html, /id="panel-A" style="grid-column: span 2; grid-row: span 2"/);
  assert.match(html, /<section class="am-panel am-panel--bare" id="panel-B">\n<div class="am-panel-body">/);
});

test('sheet: 次のパネルが入らないときは今の行を埋め、空きを残さない', async () => {
  const { fillRows } = await import('../src/templates/sheet.js');
  const P = (span) => ({ attrs: span ? { span } : {} });
  // cols=2：A(2) | B(1) C(2) → B の後ろに C が入らないので B を 2 に広げる
  assert.deepEqual(fillRows([P(2), P(), P(2), P()], 2), [2, 2, 2, 2]);
  // cols=3：A(1) B(1) C(2) → A と B で 2 列。C が入らないので B を 2 に広げる。C(2) は最後の行なので 3 まで広げる
  assert.deepEqual(fillRows([P(), P(), P(2)], 3), [1, 2, 3]);
  // ちょうど埋まるときは変えない
  assert.deepEqual(fillRows([P(), P(2), P(3)], 3), [1, 2, 3]);
  // rows を使うときは調整せず、作者の配置を残す
  assert.deepEqual(fillRows([{ attrs: { rows: 2 } }, P(), P(2)], 3), [1, 1, 2]);
});

test('sheet: 自動で広げた結果が出力に反映される', () => {
  const { html } = renderDoc('---\ncols: 2\n---\n## A {span=2}\nx\n## B\ny\n## C {span=2}\nz');
  assert.match(html, /id="panel-B" style="grid-column: span 2"/);
});
