import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVideo, estimateSeconds, buildTimeline, allBeats, TIMING } from '../src/video/script.js';
import { renderVideo, captionHtml, videoMode, VIDEO_UI } from '../src/video/render.js';
import { readWav, wav, mixTrack, trimSilence, synthAll, pickProvider, pickMacVoice, compressAudio, hasCommand, cacheStats, pruneCache, TtsError, SAMPLE_RATE } from '../src/video/tts.js';
import { findChrome } from '../src/video/export.js';
import { renderDoc } from '../src/render.js';
import { ParseError } from '../src/parse.js';
import { COMPONENTS } from '../src/components/index.js';
import { main } from '../src/cli.js';
import { SIMPLIFIED_ONLY } from './helpers/chinese.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'explain-video-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

const SRC = `---
title: ハンドシェイク
---
> タイトルのナレーション。

## 第一幕
\`\`\`sequence
A -> B: SYN
B -> A: ACK
\`\`\`
> A が先に SYN を送る。
> [B] が ACK を返す。

## 第二幕
- 要点その一
> 1 文だけ。
`;

// 偽の音声：1 字 0.1 秒の正弦波。呼ばれた回数を記録する。
function fakeProvider() {
  const calls = [];
  return {
    calls,
    name: 'fake',
    id: 'fake',
    concurrency: 2,
    async synth(text) {
      calls.push(text);
      const n = Math.round([...text].length * 0.1 * SAMPLE_RATE);
      return Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin(i / 8)));
    },
  };
}

// ── 原稿の解析 ──
test('parseVideo: 場面・ナレーションの拍・カメラの対象・タイトルのナレーション', () => {
  const v = parseVideo(SRC);
  assert.equal(v.meta.title, 'ハンドシェイク');
  assert.deepEqual(v.introBeats.map((b) => b.text), ['タイトルのナレーション。']);
  assert.equal(v.scenes.length, 2);
  assert.deepEqual(v.scenes[0].beats.map((b) => b.text), ['A が先に SYN を送る。', 'B が ACK を返す。']);
  assert.equal(v.scenes[0].beats[1].focus, 'B');
  assert.equal(v.scenes[0].blocks[0].lang, 'sequence');
  assert.equal(v.scenes[1].blocks[0].type, 'md', 'ナレーション以外の Markdown は画面に残す');
  assert.equal(allBeats(v).length, 4);
});

test('parseVideo: 場面にナレーションがないとき、原稿に場面がないときはエラー', () => {
  assert.throws(() => parseVideo('## 空の場面\n- 画面だけ\n'), (e) => e instanceof ParseError && /ナレーションがありません/.test(e.message));
  assert.throws(() => parseVideo('> ナレーションだけ\n'), (e) => e instanceof ParseError && /場面（## 場面の題名）が 1 つ以上必要/.test(e.message));
});

test('estimateSeconds: 日本語は 1 秒 5 字、英単語は 1 秒 2.6 語で見積もり、下限がある', () => {
  assert.ok(Math.abs(estimateSeconds('あいうえおかきくけこさしすせそたちつてとな') - (21 / 5 + 0.3)) < 1e-9);
  assert.ok(estimateSeconds('one two three four five six seven eight nine ten') > 3.5);
  assert.equal(estimateSeconds('はい'), 1.6);
});

test('buildTimeline: タイトル → 場面の切り替え → ナレーションの順に並び、時刻は単調に増える', () => {
  const v = parseVideo(SRC);
  const tl = buildTimeline(v, [2, 1, 1, 1]);
  assert.equal(tl.title.beats[0].start, 0);
  assert.equal(tl.scenes[0].start, tl.title.end);
  assert.equal(tl.scenes[0].beats[0].start, tl.scenes[0].start + TIMING.transition);
  assert.equal(tl.scenes[0].beats[1].start, tl.scenes[0].beats[0].end + TIMING.gap);
  assert.equal(tl.scenes[1].start, tl.scenes[0].end);
  assert.equal(tl.duration, tl.scenes[1].end + TIMING.outro);
  const noIntro = buildTimeline({ ...v, introBeats: [] }, [1, 1, 1]);
  assert.equal(noIntro.scenes[0].start, TIMING.title, 'タイトルのナレーションがなければ決まった時間だけ表示する');
});

test('captionHtml: HTML をエスケープし、[名前] を強調語にする', () => {
  assert.equal(captionHtml('[Server] が <ACK> を返す'), '<b>Server</b> が &lt;ACK&gt; を返す');
});

// ── 音声 ──
test('wav と readWav で往復できる。mixTrack は開始時刻どおりに置く', () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767]);
  assert.deepEqual([...readWav(wav(samples))], [...samples]);
  const track = readWav(mixTrack([Int16Array.from([5, 6])], [1], 2));
  assert.equal(track.length, 2 * SAMPLE_RATE);
  assert.equal(track[SAMPLE_RATE], 5);
  assert.equal(track[SAMPLE_RATE - 1], 0);
});

test('trimSilence: 前後の無音を削り、40ms の余白を残す', () => {
  const pad = Math.floor(SAMPLE_RATE * 0.04);
  const s = new Int16Array(SAMPLE_RATE);
  s.fill(5000, 10000, 11000);
  const out = trimSilence(s);
  assert.equal(out.length, 1000 + pad * 2);
});

test('synthAll: 並列に合成してキャッシュし、2 回目は TTS を呼ばない', async () => {
  const p = fakeProvider();
  const cacheDir = join(dir, 'cache');
  const a = await synthAll(['一文', '二つ目の文'], p, { cacheDir });
  assert.equal(p.calls.length, 2);
  const b = await synthAll(['一文', '二つ目の文'], p, { cacheDir });
  assert.equal(p.calls.length, 2, 'キャッシュに当たる');
  assert.deepEqual([...b[1]], [...a[1]]);
});

test('pickProvider: offは字幕だけ。sayはmacOSでsayがあるときだけ使え、なければエラー', () => {
  const cases = [
    { name: 'off', req: ['off', { platform: 'linux', which: () => false }], want: null },
    { name: 'macOSでsayがない', req: ['say', { platform: 'darwin', which: () => false }], wantErr: /macOSのsayが必要です/ },
    { name: 'macOS以外', req: ['say', { platform: 'linux', which: () => true }], wantErr: /macOSのsayが必要です/ },
  ];
  for (const { name, req, want, wantErr } of cases) {
    if (wantErr) {
      assert.throws(() => pickProvider(...req), (e) => e instanceof TtsError && wantErr.test(e.message), name);
      continue;
    }
    assert.equal(pickProvider(...req), want, name);
  }
});

test('pickMacVoice: ja_JP の声を Kyoko → Eddy → Flo → Reed の順で選ぶ', () => {
  const line = (name, locale) => `${name.padEnd(20)}${locale}    # x`;
  const cases = [
    { name: 'Kyoko がいる', req: [line('Reed (日本語（日本）)', 'ja_JP'), line('Kyoko', 'ja_JP'), line('Samantha', 'en_US')], want: 'Kyoko' },
    { name: 'Kyoko がいない', req: [line('Reed (日本語（日本）)', 'ja_JP'), line('Flo (日本語（日本）)', 'ja_JP'), line('Eddy (日本語（日本）)', 'ja_JP')], want: 'Eddy (日本語（日本）)' },
    { name: '名前が長く空白 1 つ', req: ['Reed (日本語（日本）) ja_JP    # x', 'Flo (日本語（日本）) ja_JP    # x'], want: 'Flo (日本語（日本）)' },
    { name: '優先リスト外の ja_JP だけ', req: [line('Grandma (日本語（日本）)', 'ja_JP')], want: 'Grandma (日本語（日本）)' },
    { name: 'ja_JP がない', req: [line('Kyoko', 'en_US'), line('Samantha', 'en_US')], want: undefined },
  ];
  for (const { name, req, want } of cases) assert.equal(pickMacVoice(req.join('\n')), want, name);
});

// ── 描画 ──
test('renderVideo: 音声なしでは見積もりの長さで再生ページを作り、場面とデータがそろう', async () => {
  const r = await renderVideo(SRC);
  assert.equal(r.wav, null);
  assert.equal(r.beats, 4);
  assert.equal((r.html.match(/<section class="amv-scene/g) || []).length, 3, 'タイトル + 場面 2 つ');
  const data = JSON.parse(r.html.match(/id="amv-data">(.*?)<\/script>/)[1]);
  assert.equal(data.segments.length, 3);
  assert.equal(data.segments[1].beats[1].html, '<b>B</b> が ACK を返す。');
  assert.equal(data.duration, r.duration);
  assert.doesNotMatch(r.html, /<audio/);
  assert.match(r.html, /window\.render = render/);
  assert.match(r.html, /<html lang="ja"/);
});

test('renderVideo: 音声ありでは長さを音声から取り、WAV を埋め込む', async () => {
  const p = fakeProvider();
  const r = await renderVideo(SRC, { provider: p });
  assert.equal(p.calls.length, 4);
  assert.match(r.html, /<audio id="amv-audio" preload="auto" src="data:audio\/wav;base64,/);
  const data = JSON.parse(r.html.match(/id="amv-data">(.*?)<\/script>/)[1]);
  const first = data.segments[0].beats[0];
  assert.ok(Math.abs(first.end - first.start - [...'タイトルのナレーション。'].length * 0.1) < 0.01);
  assert.equal(readWav(r.wav).length, Math.ceil(r.duration * SAMPLE_RATE));
});

test('renderVideo: ナレーションが何行続いても長い段落とみなさない。strict ではほかの問題で止める', async () => {
  const many = `## 場面\n- 画面\n${Array.from({ length: 8 }, (_, i) => `> ${i + 1} 文目。`).join('\n')}\n`;
  const r = await renderVideo(many);
  assert.equal(r.warnings.filter((w) => w.rule === 'paragraph-length').length, 0);
  await assert.rejects(renderVideo(`---\nstyle: strict\n---\n## 場面\n> システムの最適化を行う。\n`), /STE/);
});

test('renderVideo: ボタンなどの文言は日本語で、簡体字が出ない', async () => {
  const { html } = await renderVideo(SRC);
  for (const label of [VIDEO_UI.play, VIDEO_UI.pause, VIDEO_UI.chapters]) assert.ok(html.includes(`"${label}"`), label);
  assert.deepEqual({ play: VIDEO_UI.play, pause: VIDEO_UI.pause, chapters: VIDEO_UI.chapters }, { play: '再生', pause: '一時停止', chapters: 'チャプター' });
  assert.deepEqual([...html].filter((c) => SIMPLIFIED_ONLY.has(c)), []);
});

test('renderVideo: static: true はエラー（動画には JavaScript が必要）', async () => {
  await assert.rejects(renderVideo(`---\nstatic: true\n---\n## 場面\n> 文。\n`), (e) => e instanceof ParseError && /static: true は使えません/.test(e.message));
});

test('動画のテーマ：既定は blueprint で配色は OS に従う。原稿で 3b1b を選べ、コマンドラインの引数が優先する', async () => {
  const def = await renderVideo(SRC);
  assert.match(def.html, /data-theme="blueprint" data-mode="auto" data-video/);
  assert.match(def.html, /class="amv-sheet"/, '図面の外枠');
  assert.match(def.html, /SHEET 01 \/ 02/);
  const dark = await renderVideo(`---\ntheme: 3b1b\n---\n${SRC.split('---\n').slice(2).join('---\n')}`);
  assert.match(dark.html, /data-theme="3b1b" data-mode="dark"/);
  const cli = await renderVideo(SRC, { overrides: { theme: 'shadcn', mode: 'dark' } });
  assert.match(cli.html, /data-theme="shadcn" data-mode="dark"/);
  await assert.rejects(renderVideo(SRC, { overrides: { theme: 'neon' } }), /theme の値 "neon" は使えません/);
  assert.match(def.html, /@media \(prefers-color-scheme: dark\) \{\s*html\[data-video\]\[data-theme="blueprint"\]\[data-mode="auto"\]/, 'auto の図面の背景も OS に従う');
  assert.throws(() => renderDoc('---\ntheme: 3b1b\n---\n## A\n文字\n'), ParseError, 'ページでは 3b1b を使えない');
});

test('renderDoc: template video なら explain video を使うよう案内する', () => {
  assert.throws(() => renderDoc('---\ntemplate: video\n---\n## A\n文字\n'), (e) => e instanceof ParseError && /explain video/.test(e.message));
});

// ── 部品の手順の印 ──
test('部品の手順の印：flow はソースの行、sequence はメッセージ、tree はノードごと', () => {
  const ctx = { args: '', uid: () => 'u' };
  const flow = COMPONENTS.get('flow').render('A -> B\nB -> C: ラベル', ctx);
  assert.match(flow, /data-key="A" data-step="0"/);
  assert.match(flow, /data-key="C" data-step="1"/);
  assert.equal((flow.match(/<g data-step="/g) || []).length, 2, '矢印 1 本に手順のグループ 1 つ');
  const seq = COMPONENTS.get('sequence').render('A -> B: x\nB --> A: y', ctx);
  assert.match(seq, /<g data-key="A">/);
  assert.match(seq, /<g data-step="1">/);
  const tree = COMPONENTS.get('tree').render('根\n  子その一\n  子その二', ctx);
  assert.match(tree, /data-key="子その二" data-step="2"/);
});

// ── CLI ──
function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

async function run(args, { stdin = '', env = {}, ttsProvider = null, encodeAudio = null } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(args, {
    stdout: out.stream, stderr: err.stream, stdin: Readable.from([stdin]),
    env: { EXPLAIN_NO_OPEN: '1', EXPLAIN_HOME: dir, ...env }, cwd: dir, ttsProvider, encodeAudio,
  });
  return { code, out: out.text, err: err.text };
}

test('cli video: EXPLAIN_HOME/videos に書き、場面・ナレーション・長さ・音声を出す', async () => {
  const r = await run(['video', '-'], { stdin: SRC });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /✓ .+videos\/ハンドシェイク-.+\.html/);
  assert.match(r.out, /場面 2 個 · ナレーション 4 文 · [\d.]+ 秒 · 音声：なし（字幕のみ）/);
  assert.equal(readdirSync(join(dir, 'videos')).length, 1);
});

test('cli video: 使った音声を出す。不正な voice はエラー', async () => {
  const r = await run(['video', '-', '-o', 'v.html'], { stdin: SRC, ttsProvider: fakeProvider() });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /音声：fake/);
  assert.match(readFileSync(join(dir, 'v.html'), 'utf8'), /data:audio\/wav/);
  const bad = await run(['video', '-', '--voice', 'robot'], { stdin: SRC });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /voice の値 "robot" は使えません/);
});

test('cli help video / config voice', async () => {
  assert.match((await run(['help', 'video'])).out, /動画の原稿の書式/);
  const set = await run(['config', 'set', 'voice', 'off']);
  assert.equal(set.code, 0, set.err);
  assert.match((await run(['config', 'get', 'voice'])).out, /^off/);
});

test('findChrome: EXPLAIN_CHROME を優先する', () => {
  assert.equal(findChrome({ EXPLAIN_CHROME: '/x/chrome' }), '/x/chrome');
});

// ── 端から端まで：実際の OS の読み上げ + Chrome + ffmpeg。遅いので EXPLAIN_E2E=1 のときだけ動かす。──
const E2E = process.env.EXPLAIN_E2E === '1';

test('e2e: macOSのsayで実際の音声を合成する', { skip: !E2E }, async () => {
  const p = pickProvider('say');
  const [clip] = await synthAll(['こんにちは、世界。'], p, {});
  assert.ok(clip.length / SAMPLE_RATE > 0.4);
});

test('e2e: --mp4 で 1080p30・音声つきの動画を書き出す', { skip: !E2E, timeout: 120000 }, async () => {
  const short = '---\ntitle: 書き出しテスト\n---\n## 場面\n```flow\nA -> B\n```\n> A が B につながる。\n';
  const r = await run(['video', '-', '-o', 'e2e.html', '--mp4'], { stdin: short, ttsProvider: fakeProvider() });
  assert.equal(r.code, 0, r.err);
  const { execFileSync } = await import('node:child_process');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', join(dir, 'e2e.mp4')], { encoding: 'utf8' });
  assert.match(probe, /video,1920,1080/);
  assert.match(probe, /audio/);
});

test('videoMode: light と dark はそのまま、それ以外は auto。3b1b は常に dark', () => {
  const cases = [
    { req: { theme: 'blueprint', mode: 'light' }, want: 'light' },
    { req: { theme: 'shadcn', mode: 'dark' }, want: 'dark' },
    { req: { theme: 'blueprint', mode: 'auto' }, want: 'auto' },
    { req: { theme: '3b1b', mode: 'light' }, want: 'dark' },
  ];
  for (const { req, want } of cases) assert.equal(videoMode(req), want, JSON.stringify(req));
});

test('renderVideo: encodeAudio が返した形式で埋め込み、null なら WAV のまま。MP4 用の wav は常に WAV', async () => {
  const cases = [
    { name: '圧縮する', encodeAudio: async () => ({ mime: 'audio/mp4', data: Buffer.from('m4a') }), want: `data:audio/mp4;base64,${Buffer.from('m4a').toString('base64')}"` },
    { name: '圧縮できない', encodeAudio: async () => null, want: 'data:audio/wav;base64,' },
  ];
  for (const { name, encodeAudio, want } of cases) {
    const r = await renderVideo(SRC, { provider: fakeProvider(), encodeAudio });
    assert.ok(r.html.includes(want), name);
    assert.equal(readWav(r.wav).length, Math.ceil(r.duration * SAMPLE_RATE), name);
  }
});

test('compressAudio: ffmpeg がなければ null。あれば AAC（m4a）にして小さくする', { skip: !hasCommand('ffmpeg') && 'ffmpeg がない' }, async () => {
  assert.equal(await compressAudio(wav(new Int16Array(10)), { has: () => false }), null);
  const samples = Int16Array.from({ length: SAMPLE_RATE * 2 }, (_, i) => Math.round(Math.sin(i / 10) * 8000));
  const src = wav(samples);
  const got = await compressAudio(src);
  assert.equal(got.mime, 'audio/mp4');
  assert.equal(got.data.toString('ascii', 4, 8), 'ftyp');
  assert.ok(got.data.length < src.length / 3, `${got.data.length} < ${src.length / 3}`);
});

test('cli video: 圧縮した音声を埋め込む', async () => {
  const r = await run(['video', '-', '-o', 'v-aac.html'], { stdin: SRC, ttsProvider: fakeProvider(), encodeAudio: async () => ({ mime: 'audio/mp4', data: Buffer.from('m4a') }) });
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(dir, 'v-aac.html'), 'utf8'), /data:audio\/mp4;base64,/);
});

test('pruneCache: 上限を超えたら最後に使った時刻が古いものから消す。キャッシュを使うと時刻を更新する', async () => {
  const cache = mkdtempSync(join(dir, 'cache-'));
  const p = fakeProvider();
  await synthAll(['一', '二', '三'], p, { cacheDir: cache });
  const files = cacheStats(cache).files;
  assert.equal(files.length, 3);
  const old = new Date(Date.now() - 60_000);
  for (const f of files) utimesSync(f.path, old, old);
  await synthAll(['一'], p, { cacheDir: cache }); // 「一」を使い直して新しくする
  const size = files[0].size;
  const cases = [
    { name: '上限内', max: size * 3, wantRemoved: 0, wantLeft: 3 },
    { name: '1 件ぶん超える', max: size * 2, wantRemoved: 1, wantLeft: 2 },
    { name: '使い直したものは残る', max: size, wantRemoved: 1, wantLeft: 1 },
  ];
  for (const { name, max, wantRemoved, wantLeft } of cases) {
    assert.equal(pruneCache(cache, max), wantRemoved, name);
    assert.equal(cacheStats(cache).files.length, wantLeft, name);
  }
  assert.equal(p.calls.length, 3, '「一」はキャッシュから読む');
  const again = fakeProvider();
  await synthAll(['一'], again, { cacheDir: cache });
  assert.equal(again.calls.length, 0, '最後に使った「一」が残っている');
});

test('cli cache: 場所と大きさを出し、clear で消す。知らない操作は 2', async () => {
  await run(['video', '-', '-o', 'v-cache.html'], { stdin: SRC, ttsProvider: fakeProvider() });
  const show = await run(['cache']);
  assert.equal(show.code, 0);
  assert.match(show.out, /音声のキャッシュ：.+cache\/tts\n {2}\d+ 件、[\d.]+ MB（上限 200\.0 MB/);
  const clear = await run(['cache', 'clear']);
  assert.match(clear.out, /✓ 音声のキャッシュを消しました/);
  assert.match((await run(['cache'])).out, / {2}0 件、0\.0 MB/);
  assert.equal((await run(['cache', 'drop'])).code, 2);
});
