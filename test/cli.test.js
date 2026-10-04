import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { main, shouldOpen } from '../src/cli.js';
import { findSimplified } from './helpers/chinese.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'explain-test-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

async function run(args, { stdin = '', env = {} } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(args, {
    stdout: out.stream, stderr: err.stream, stdin: Readable.from([stdin]),
    env: { EXPLAIN_NO_OPEN: '1', EXPLAIN_HOME: dir, ...env }, cwd: dir,
  });
  return { code, out: out.text, err: err.text };
}

const GOOD = '---\ntitle: CLI テスト\n---\n## A 流れ\n```flow\nA -> B\n```\n';

test('cli: --version と --help', async () => {
  assert.match((await run(['--version'])).out, /^\d+\.\d+\.\d+/);
  const help = (await run([])).out;
  assert.match(help, /^explain \d+\.\d+\.\d+ — /);
  assert.match(help, /使い方:\n {2}explain render/);
  assert.match(help, /--static/);
});

test('cli render: 標準入力から読み、EXPLAIN_HOME/pages に書いて、パスと集計を出す', async () => {
  const r = await run(['render', '-'], { stdin: GOOD });
  assert.equal(r.code, 0, r.err);
  const file = r.out.match(/✓ (.+\.html)/)[1];
  assert.ok(file.startsWith(join(dir, 'pages', 'CLI-テスト-')));
  assert.match(readFileSync(file, 'utf8'), /<h1>CLI テスト<\/h1>/);
  assert.match(r.out, /sheet · blueprint · パネル 1 枚 · flow×1/);
  assert.match(r.out, /STE ✓ 警告 0 件/);
});

test('cli render: ファイル引数・-o・テーマの上書き', async () => {
  writeFileSync(join(dir, 'in.md'), GOOD);
  const r = await run(['render', 'in.md', '-o', 'out/x.html', '--theme', 'shadcn']);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(dir, 'out/x.html'), 'utf8'), /data-theme="shadcn"/);
});

test('cli render --static: script なしの HTML を出し、集計に静的と出す', async () => {
  const r = await run(['render', '-', '-o', 'static.html', '--static'], { stdin: GOOD });
  assert.equal(r.code, 0, r.err);
  const html = readFileSync(join(dir, 'static.html'), 'utf8');
  assert.doesNotMatch(html, /<script/i);
  assert.match(r.out, /静的（script なし）/);
});

test('cli video --static: 動画では使えないのでエラー（終了コード 2）', async () => {
  const r = await run(['video', '-', '--static'], { stdin: '## 場面\n> ナレーション。\n' });
  assert.equal(r.code, 2);
  assert.match(r.err, /explain video では --static を使えません/);
});

test('cli render: 部品の構文エラー → 原稿の行番号・部品名・正しい例、終了コード 1', async () => {
  const r = await run(['render', '-'], { stdin: '## A\n本文\n```flow\nA -> B\n(閉じない -> C\n```' });
  assert.equal(r.code, 1);
  assert.match(r.err, /✗ L5 \[flow\] flow の形の括弧が閉じていません/);
  assert.match(r.err, /正しい例：\n {4}```flow/);
  assert.match(r.err, /書き方の詳細：explain help flow/);
});

test('cli render: 解析エラーに行番号を出す', async () => {
  const r = await run(['render', '-'], { stdin: '## A\n```flow\nA -> B' });
  assert.equal(r.code, 1);
  assert.match(r.err, /✗ L2 原稿を解析できません：コードブロック/);
});

test('cli render: style 80 は警告を出して生成し、strict は生成しない', async () => {
  const bad = '## A\n設定の確認を行う。';
  const soft = await run(['render', '-'], { stdin: bad });
  assert.equal(soft.code, 0);
  assert.match(soft.out, /STE 警告 1 件[\s\S]*L2 \[verbose\] 冗長な表現「確認を行う」（を行う） → 確認する/);

  const before = readdirSync(join(dir, 'pages')).length;
  const strict = await run(['render', '-', '--style', 'strict'], { stdin: bad });
  assert.equal(strict.code, 1);
  assert.match(strict.err, /STE 検査で警告が 1 件あります/);
  assert.equal(readdirSync(join(dir, 'pages')).length, before, 'strict で失敗したらファイルを書かない');
});

test('cli lint: 検査だけ。strict で警告があれば 1、off なら飛ばす', async () => {
  const bad = '## A\n設定の確認を行う。';
  const cases = [
    { req: ['lint', '-'], wantCode: 0 },
    { req: ['lint', '-', '--style', 'strict'], wantCode: 1 },
    { req: ['lint', '-', '--style', 'off'], wantCode: 0 },
    { req: ['lint', '-', '--style', 'x'], wantCode: 2 },
  ];
  for (const { req, wantCode } of cases) assert.equal((await run(req, { stdin: bad })).code, wantCode, req.join(' '));
  assert.match((await run(['lint', '-', '--style', 'off'], { stdin: bad })).out, /STE 検査はオフです/);
});

test('cli lint: AI っぽさのスコアを出す。参考の指摘だけなら strict でも 0', async () => {
  const cases = [
    { name: 'AI の文章に多い語', stdin: '## A\n手触りと腹落ちを確かめる。', wantCode: 1, wantScore: 90 },
    { name: '参考の指摘だけ', stdin: '## A\n速さではなく正しさを選ぶ。', wantCode: 0, wantScore: 98 },
  ];
  for (const { name, stdin, wantCode, wantScore } of cases) {
    const r = await run(['lint', '-', '--style', 'strict'], { stdin });
    assert.equal(r.code, wantCode, name);
    assert.match(r.out, new RegExp(`AI っぽさのスコア ${wantScore}/100`), name);
  }
  assert.doesNotMatch((await run(['lint', '-', '--style', 'off'], { stdin: '## A\n手触り。' })).out, /スコア/);
});

test('cli list / help', async () => {
  assert.match((await run(['list'])).out, /flow\s+フロー図/);
  const h = await run(['help', 'sequence']);
  assert.match(h.out, /sequence — シーケンス図[\s\S]*例：\n```sequence/);
  assert.match((await run(['help', 'format'])).out, /template: sheet/);
  const nope = await run(['help', 'nope']);
  assert.equal(nope.code, 2);
  assert.match(nope.err, /"nope" という部品はありません/);
});

test('cli: 引数の誤りと不足', async () => {
  const cases = [
    { req: { args: ['bogus'] }, wantCode: 2 },
    { req: { args: ['render'] }, wantCode: 2 },
    { req: { args: ['render', 'missing.md'] }, wantCode: 2 },
    { req: { args: ['render', '-'], stdin: '   ' }, wantCode: 2 },
    { req: { args: ['render', '--wat'] }, wantCode: 2 },
  ];
  for (const { req, wantCode } of cases) assert.equal((await run(req.args, { stdin: req.stdin })).code, wantCode, req.args.join(' '));
});

test('cli config: 全項目・現在値・設定ファイルのパスを出す。always はない', async () => {
  const r = await run(['config']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`設定ファイル：${join(dir, 'config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const key of ['open', 'theme', 'mode', 'style', 'voice']) assert.match(r.out, new RegExp(`\\b${key}\\b`));
  assert.doesNotMatch(r.out, /\balways\b/);
});

test('cli config: set / get / reset。変更した値には * がつく', async () => {
  assert.equal((await run(['config', 'set', 'theme', 'shadcn'])).code, 0);
  assert.equal((await run(['config', 'get', 'theme'])).out.trim(), 'shadcn');
  assert.match((await run(['config'])).out, /\* theme\s+shadcn/);
  const rendered = await run(['render', '-', '-o', 'cfg.html'], { stdin: '## A\nx' });
  assert.match(readFileSync(join(dir, 'cfg.html'), 'utf8'), /data-theme="shadcn"/, 'render は設定の既定テーマを読む');
  assert.equal(rendered.code, 0);
  assert.equal((await run(['config', 'reset', 'theme'])).code, 0);
  assert.equal((await run(['config', 'get', 'theme'])).out.trim(), 'blueprint');
});

test('cli config: 真偽値は on/off で出す。不正なキーや値は 2', async () => {
  await run(['config', 'set', 'open', 'off']);
  assert.equal((await run(['config', 'get', 'open'])).out.trim(), 'off');
  await run(['config', 'reset']);
  const bad = await run(['config', 'set', 'theme', 'neon']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /theme の値 "neon" は使えません。選択肢：blueprint \| shadcn/);
  const cases = [['config', 'set', 'nope', '1'], ['config', 'set', 'always', 'on'], ['config', 'frob']];
  for (const req of cases) assert.equal((await run(req)).code, 2, req.join(' '));
});

test('cli: 出力の文言に簡体字が出ない', async () => {
  const outputs = await Promise.all([
    run([]), run(['list']), run(['config']), run(['help', 'format']), run(['help', 'video']),
    ...['callout', 'kv', 'timeline', 'annot', 'tree', 'limits', 'sequence', 'flow'].map((c) => run(['help', c])),
    run(['render', '-'], { stdin: '## A\n```flow\nA -> (B\n```' }),
    run(['lint', '-'], { stdin: '## A\n設定の確認を行う。とても速い。原因はキャッシュかもしれない。' }),
    run(['video', '-'], { stdin: '## 場面\n画面だけ\n' }),
  ]);
  for (const r of outputs) assert.deepEqual(findSimplified(r.out + r.err), []);
});

test('shouldOpen: --no-open > EXPLAIN_NO_OPEN > 設定 open。--open は必ず開く', () => {
  const cases = [
    { req: [{}, {}, { open: true }], want: true },
    { req: [{}, {}, { open: false }], want: false },
    { req: [{ 'no-open': true }, {}, { open: true }], want: false },
    { req: [{}, { EXPLAIN_NO_OPEN: '1' }, { open: true }], want: false },
    { req: [{}, { EXPLAIN_NO_OPEN: '0' }, { open: true }], want: true },
    { req: [{}, { CI: 'true' }, { open: true }], want: false },
    { req: [{ open: true }, { EXPLAIN_NO_OPEN: '1' }, { open: false }], want: true },
  ];
  for (const { req, want } of cases) assert.equal(shouldOpen(...req), want, JSON.stringify(req));
});

test('cli render --watch: 標準入力や原稿なしでは使えない', async () => {
  const cases = [
    { name: '標準入力', req: ['render', '-', '--watch'] },
    { name: '原稿なし', req: ['render', '--watch'] },
  ];
  for (const { name, req } of cases) {
    const r = await run(req);
    assert.equal(r.code, 2, name);
    assert.match(r.err, /--watch には原稿のファイルを指定してください/, name);
  }
});

// 条件を満たすまで少しずつ待つ。
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`待ちきれません：${label}`);
}

test('cli render --watch: 配信し、保存すると作り直して再読み込みを知らせる。エラーでは前のページを残す', async () => {
  const file = join(dir, 'watch.md');
  const outFile = join(dir, 'watch-out.html');
  writeFileSync(file, GOOD);
  const out = sink();
  const err = sink();
  const ac = new AbortController();
  const done = main(['render', file, '--watch', '-o', outFile], {
    stdout: out.stream, stderr: err.stream, env: { EXPLAIN_NO_OPEN: '1', EXPLAIN_HOME: dir }, cwd: dir, signal: ac.signal,
  });
  try {
    const url = await until(() => out.text.match(/✓ (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1], 'URL');
    const first = await (await fetch(url)).text();
    assert.match(first, /<h1>CLI テスト<\/h1>/);
    assert.match(first, /new EventSource\('\/__explain\/events'\)/);
    assert.doesNotMatch(readFileSync(outFile, 'utf8'), /EventSource/, '-o のファイルには再読み込みのスクリプトを入れない');
    const hosts = [
      { host: new URL(url).host, wantCode: 200 },
      { host: `localhost:${new URL(url).port}`, wantCode: 200 },
      { host: `evil.example:${new URL(url).port}`, wantCode: 403 },
    ];
    for (const { host, wantCode } of hosts) {
      const code = await new Promise((resolve, reject) => {
        get(url, { headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
      });
      assert.equal(code, wantCode, host);
    }

    const events = await fetch(`${url}__explain/events`);
    const reader = events.body.getReader();
    await reader.read(); // 接続の確認
    writeFileSync(file, GOOD.replace('CLI テスト', '書き換えた題名'));
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /data: reload/);
    assert.match(await (await fetch(url)).text(), /<h1>書き換えた題名<\/h1>/);
    assert.match(readFileSync(outFile, 'utf8'), /<h1>書き換えた題名<\/h1>/);
    reader.cancel();

    writeFileSync(file, '---\ntitle: 壊れた\n---\n## A\n```flow\n(閉じない -> C\n```\n');
    await until(() => /\[flow\]/.test(err.text), 'エラーの表示');
    assert.match(await (await fetch(url)).text(), /<h1>書き換えた題名<\/h1>/, 'エラーのときは前のページを配信し続ける');
  } finally {
    ac.abort();
  }
  assert.equal(await done, 0);
});
