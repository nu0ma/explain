import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, ParseError } from '../src/parse.js';

const SAMPLE = `---
template: sheet
theme: shadcn
title: TCP の 3 ウェイハンドシェイク   # 行末のコメント
cols: 2
---
最初の段落。

## A 接続の流れ {span=2 meta="RFC 793"}
\`\`\`sequence
Client -> Server: SYN
\`\`\`
## 状態の変化
| a | b |
|---|---|
| 1 | ok |
`;

test('frontmatter: キーと値を読み、行末のコメントを除き、数値の項目を数にする', () => {
  const doc = parseDoc(SAMPLE);
  assert.equal(doc.meta.template, 'sheet');
  assert.equal(doc.meta.theme, 'shadcn');
  assert.equal(doc.meta.title, 'TCP の 3 ウェイハンドシェイク');
  assert.equal(doc.meta.cols, 2);
  assert.equal(doc.meta.style, '80');
});

test('frontmatter がなければ既定値を使う', () => {
  const doc = parseDoc('## パネル 1 枚だけ\n本文');
  assert.deepEqual(
    { t: doc.meta.template, th: doc.meta.theme, s: doc.meta.style, c: doc.meta.cols },
    { t: 'sheet', th: 'blueprint', s: '80', c: 3 },
  );
});

test('パネルの分割：明示した ID・題名・属性・行番号', () => {
  const doc = parseDoc(SAMPLE);
  assert.equal(doc.panels.length, 2);
  const [a, b] = doc.panels;
  assert.equal(a.id, 'A');
  assert.equal(a.title, '接続の流れ');
  assert.deepEqual(a.attrs, { span: 2, meta: 'RFC 793' });
  assert.equal(a.line, 9);
  assert.equal(b.id, 'B', 'ID がなければ使われていない次の英字を振る');
  assert.equal(b.title, '状態の変化');
});

test('ブロックの分割：Markdown とコードブロックを分け、言語・引数・行番号を記録する', () => {
  const doc = parseDoc(SAMPLE);
  const blocks = doc.panels[0].blocks;
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: 'fence', lang: 'sequence', args: '', text: 'Client -> Server: SYN', line: 10,
  });
  assert.equal(doc.panels[1].blocks[0].type, 'md');
  assert.equal(doc.panels[1].blocks[0].line, 14);
  assert.equal(doc.intro[0].text.trim(), '最初の段落。');
});

test('コードブロックの引数：```flow LR を lang と args に分ける', () => {
  const doc = parseDoc('## X\n```flow LR\nA -> B\n```');
  const f = doc.panels[0].blocks[0];
  assert.equal(f.lang, 'flow');
  assert.equal(f.args, 'LR');
});

test('コードブロックの中の ## ではパネルを分けない', () => {
  const doc = parseDoc('## A\n```md\n## 見出しではない\n```\n## B\n本文');
  assert.equal(doc.panels.length, 2);
  assert.equal(doc.panels[0].blocks[0].text, '## 見出しではない');
});

test('frontmatter に題名がなければ、導入部の # 見出しを題名にする', () => {
  const doc = parseDoc('# 私の題名\n導入文\n## A\nx');
  assert.equal(doc.meta.title, '私の題名');
  assert.equal(doc.intro[0].text.trim(), '導入文');
});

test('自動の ID は明示で使われた英字を飛ばす', () => {
  const doc = parseDoc('## 一\nx\n## A 二\ny\n## 三\nz');
  assert.deepEqual(doc.panels.map((p) => p.id), ['B', 'A', 'C']);
});

test('エラー：閉じていないコードブロックは開始行を示す', () => {
  assert.throws(
    () => parseDoc('## A\n本文\n```flow\nA -> B'),
    (err) => err instanceof ParseError && err.line === 3 && /閉じていません/.test(err.message),
  );
});

test('エラー：閉じていない frontmatter', () => {
  assert.throws(() => parseDoc('---\ntitle: x\n## A'), (err) => err instanceof ParseError && err.line === 1);
});

test('エラー：不正なテンプレート・テーマ・厳しさ・static には選択肢を示す', () => {
  const cases = [
    { req: '---\ntemplate: grid\n---', wantErr: /template.*sheet.*doc/ },
    { req: '---\ntheme: neon\n---', wantErr: /theme.*blueprint.*shadcn/ },
    { req: '---\nstyle: 50\n---', wantErr: /style.*off.*80.*strict/ },
    { req: '---\nstatic: on\n---', wantErr: /static.*true.*false/ },
  ];
  for (const { req, wantErr } of cases) assert.throws(() => parseDoc(req), wantErr, req);
});

test('CRLF の改行でも正しく読む', () => {
  const doc = parseDoc('---\r\ntitle: T\r\n---\r\n## A\r\n本文\r\n');
  assert.equal(doc.meta.title, 'T');
  assert.equal(doc.panels[0].blocks[0].text.trim(), '本文');
});
