import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseVideo, estimateSeconds, buildTimeline, allBeats, TIMING } from '../src/video/script.ts';
import { renderVideo, captionHtml, videoMode, VIDEO_UI } from '../src/video/render.ts';
import type { RenderVideoOptions } from '../src/video/render.ts';
import { readWav, wav, mixTrack, trimSilence, synthAll, pickProvider, pickMacVoice, compressAudio, hasCommand, cacheStats, pruneCache, TtsError, SAMPLE_RATE } from '../src/video/tts.ts';
import type { TtsProvider } from '../src/video/tts.ts';
import { findChrome } from '../src/video/export.ts';
import { renderDoc } from '../src/render.ts';
import { ParseError } from '../src/parse.ts';
import { COMPONENTS } from '../src/components/index.ts';
import { main } from '../src/cli.ts';
import { SIMPLIFIED_ONLY } from './helpers/chinese.ts';

let dir: string;
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

// Fake voice: a sine wave of 0.1 seconds per character. Records each call.
function fakeProvider() {
  const calls: string[] = [];
  return {
    calls,
    name: 'fake',
    id: 'fake',
    concurrency: 2,
    async synth(text: string) {
      calls.push(text);
      const n = Math.round([...text].length * 0.1 * SAMPLE_RATE);
      return Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin(i / 8)));
    },
  };
}

// ── Script parsing ──
test('parseVideo: 場面・ナレーションの拍・カメラの対象・タイトルのナレーション', () => {
  const v = parseVideo(SRC);
  assert.equal(v.meta.title, 'ハンドシェイク');
  assert.deepEqual(v.introBeats.map((b) => b.text), ['タイトルのナレーション。']);
  assert.equal(v.scenes.length, 2);
  assert.deepEqual(v.scenes[0].beats.map((b) => b.text), ['A が先に SYN を送る。', 'B が ACK を返す。']);
  assert.equal(v.scenes[0].beats[1].focus, 'B');
  const first = v.scenes[0].blocks[0];
  assert.equal(first.type === 'fence' ? first.lang : undefined, 'sequence');
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

test('parseVideo: (pause Ns) は次の拍の前の間になり、場面の最後なら場面の後ろの間になる。(+N) は出す手順の数', () => {
  const v = parseVideo('> (pause 1s)\n> タイトル。\n> (間 0.5秒)\n## 場面\n```flow\nA -> B\n```\n> (pause 1.5s)\n> (+2) [A] が送る。\n> 次の文。\n> (pause 2s)\n> (pause 1s)\n');
  assert.deepEqual(v.introBeats.map((b) => [b.text, b.before]), [['タイトル。', 1]]);
  assert.equal(v.introAfter, 0.5);
  assert.deepEqual(v.scenes[0].beats.map((b) => [b.raw, b.before, b.reveal, b.focus]), [['[A] が送る。', 1.5, 2, 'A'], ['次の文。', 0, null, null]]);
  assert.equal(v.scenes[0].after, 3);
});

test('parseVideo: 間の長さが範囲の外、(+N) のあとに文がないときはエラー', () => {
  assert.throws(() => parseVideo('## 場面\n> (pause 0s)\n> 文。\n'), (e) => e instanceof ParseError && /0 より長く 30 秒以下/.test(e.message));
  assert.throws(() => parseVideo('## 場面\n> (pause 31s)\n> 文。\n'), (e) => e instanceof ParseError && /0 より長く 30 秒以下/.test(e.message));
  assert.throws(() => parseVideo('## 場面\n> (+2)\n'), (e) => e instanceof ParseError && /\(\+N\) のあとにナレーションの文/.test(e.message));
});

test('buildTimeline: 書いた間の分だけ拍と場面の終わりが後ろにずれ、reveal を拍に渡す', () => {
  const v = parseVideo('## 場面\n> (pause 1s)\n> (+2) 一つ目。\n> (pause 2s)\n> 二つ目。\n> (pause 0.5s)\n');
  const tl = buildTimeline(v, [1, 1]);
  const [a, b] = tl.scenes[0].beats;
  // title 2.4 + transition 0.9 + pause 1 = 4.3; 5.3 + gap 0.35 + pause 2 = 7.65; 8.65 + tail 0.8 + pause 0.5 = 9.95
  assert.deepEqual([a.start, b.start, tl.scenes[0].end], [4.3, 7.65, 9.95]);
  assert.deepEqual([a.reveal, b.reveal], [2, null]);
});

test('captionHtml: HTML をエスケープし、[名前] を強調語にする', () => {
  assert.equal(captionHtml('[Server] が <ACK> を返す'), '<b>Server</b> が &lt;ACK&gt; を返す');
});

// ── Audio ──
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
  const cases: { name: string; req: Parameters<typeof pickProvider>; want?: null; wantErr?: RegExp }[] = [
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

test('pickProvider: 選んだ声をファイルに残し、次からは声の一覧を取らない。refresh で一覧を 1 回だけ取り直す', () => {
  const cases = [
    { name: 'ファイルなし', file: null, want: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' }, wantRefreshed: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' } },
    { name: '残した声', file: '{"voice":"Eddy"}', want: { id: 'say:Eddy', lists: 0, kept: 'Eddy' }, wantRefreshed: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' } },
    { name: 'OS の既定の声', file: '{"voice":null}', want: { id: 'say:default', lists: 0, kept: null }, wantRefreshed: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' } },
    { name: '壊れたファイル', file: '{"voice":', want: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' }, wantRefreshed: { id: 'say:Kyoko', lists: 1, kept: 'Kyoko' } },
  ];
  for (const { name, file, want, wantRefreshed } of cases) {
    const voiceFile = join(mkdtempSync(join(dir, 'voice-')), 'tts', 'voice.json');
    if (file !== null) {
      mkdirSync(dirname(voiceFile), { recursive: true });
      writeFileSync(voiceFile, file);
    }
    let lists = 0;
    const p = pickProvider('say', { platform: 'darwin', which: () => true, voiceFile, listVoice: () => { lists++; return 'Kyoko'; } });
    assert.ok(p);
    const state = () => ({ id: p.id, lists, kept: JSON.parse(readFileSync(voiceFile, 'utf8')).voice });
    assert.deepEqual(state(), want, name);
    p.refresh?.();
    p.refresh?.();
    assert.deepEqual(state(), wantRefreshed, `${name}: refresh`);
  }
});

test('synthAll: 合成する文があるときだけ先に refresh を呼び、そのあとの id でキャッシュを引く', async () => {
  const cases = [
    { name: 'すべてキャッシュにある', texts: ['一文'], wantRefresh: 0, wantCalls: [] },
    { name: '新しい文がある', texts: ['一文', '新しい文'], wantRefresh: 1, wantCalls: ['一文', '新しい文'] },
  ];
  for (const { name, texts, wantRefresh, wantCalls } of cases) {
    const cacheDir = mkdtempSync(join(dir, 'refresh-'));
    await synthAll(['一文'], fakeProvider(), { cacheDir });
    let refreshed = 0;
    const p = { ...fakeProvider(), refresh() { refreshed++; this.id = 'fake2'; } };
    await synthAll(texts, p, { cacheDir });
    assert.equal(refreshed, wantRefresh, name);
    assert.deepEqual(p.calls, wantCalls, name);
  }
});

test('pickMacVoice: ja_JP の声を Kyoko → Eddy → Flo → Reed の順で選ぶ', () => {
  const line = (name: string, locale: string) => `${name.padEnd(20)}${locale}    # x`;
  const cases = [
    { name: 'Kyoko がいる', req: [line('Reed (日本語（日本）)', 'ja_JP'), line('Kyoko', 'ja_JP'), line('Samantha', 'en_US')], want: 'Kyoko' },
    { name: 'Kyoko がいない', req: [line('Reed (日本語（日本）)', 'ja_JP'), line('Flo (日本語（日本）)', 'ja_JP'), line('Eddy (日本語（日本）)', 'ja_JP')], want: 'Eddy (日本語（日本）)' },
    { name: '名前が長く空白 1 つ', req: ['Reed (日本語（日本）) ja_JP    # x', 'Flo (日本語（日本）) ja_JP    # x'], want: 'Flo (日本語（日本）)' },
    { name: '優先リスト外の ja_JP だけ', req: [line('Grandma (日本語（日本）)', 'ja_JP')], want: 'Grandma (日本語（日本）)' },
    { name: 'ja_JP がない', req: [line('Kyoko', 'en_US'), line('Samantha', 'en_US')], want: undefined },
  ];
  for (const { name, req, want } of cases) assert.equal(pickMacVoice(req.join('\n')), want, name);
});

// ── Rendering ──
test('renderVideo: 音声なしでは見積もりの長さで再生ページを作り、場面とデータがそろう', async () => {
  const r = await renderVideo(SRC);
  assert.equal(r.wav, null);
  assert.equal(r.beats, 4);
  assert.equal((r.html.match(/<section class="amv-scene/g) || []).length, 3, 'タイトル + 場面 2 つ');
  const data = JSON.parse(/id="amv-data">(.*?)<\/script>/.exec(r.html)?.[1] ?? '');
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
  const data = JSON.parse(/id="amv-data">(.*?)<\/script>/.exec(r.html)?.[1] ?? '');
  const first = data.segments[0].beats[0];
  assert.ok(Math.abs(first.end - first.start - [...'タイトルのナレーション。'].length * 0.1) < 0.01);
  assert.ok(r.wav);
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

// ── Component step markers ──
test('部品の手順の印：flow はソースの行、sequence はメッセージ、tree はノードごと', () => {
  const ctx = { args: '', uid: () => 'u' };
  const component = (name: string) => {
    const c = COMPONENTS.get(name);
    if (!c) throw new Error(`unknown component ${name}`);
    return c;
  };
  const flow = component('flow').render('A -> B\nB -> C: ラベル', ctx);
  assert.match(flow, /data-key="A" data-step="0"/);
  assert.match(flow, /data-key="C" data-step="1"/);
  assert.equal((flow.match(/<g data-step="/g) || []).length, 2, '矢印 1 本に手順のグループ 1 つ');
  const seq = component('sequence').render('A -> B: x\nB --> A: y', ctx);
  assert.match(seq, /<g data-key="A">/);
  assert.match(seq, /<g data-step="1">/);
  const tree = component('tree').render('根\n  子その一\n  子その二', ctx);
  assert.match(tree, /data-key="子その二" data-step="2"/);
});

// ── CLI ──
function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

async function run(
  args: string[],
  { stdin = '', env = {}, ttsProvider = null, encodeAudio = null }: {
    stdin?: string;
    env?: Record<string, string>;
    ttsProvider?: TtsProvider | null;
    encodeAudio?: RenderVideoOptions['encodeAudio'];
  } = {},
) {
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

// ── End to end: real OS speech + Chrome + ffmpeg. Slow, so it runs only with EXPLAIN_E2E=1. ──
const E2E = process.env.EXPLAIN_E2E === '1';

test('e2e: macOSのsayで実際の音声を合成する', { skip: !E2E }, async () => {
  const p = pickProvider('say');
  assert.ok(p);
  const [clip] = await synthAll(['こんにちは、世界。'], p, {});
  assert.ok(clip.length / SAMPLE_RATE > 0.4);
});

test('e2e: --mp4 で 1080p30・音声つきの動画を書き出す', { skip: !E2E, timeout: 120000 }, async () => {
  const short = '---\ntitle: 書き出しテスト\n---\n## 場面\n```flow\nA -> B\n```\n> A が B につながる。\n';
  const r = await run(['video', '-', '-o', 'e2e.html', '--mp4'], { stdin: short, ttsProvider: fakeProvider() });
  assert.equal(r.code, 0, r.err);
  const { execFileSync } = await import('node:child_process');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:format=duration', '-of', 'csv=p=0', join(dir, 'e2e.mp4')], { encoding: 'utf8' });
  assert.match(probe, /video,1920,1080,30\/1/);
  assert.match(probe, /audio/);
  const want = Number(r.out.match(/([\d.]+) 秒/)?.[1]);
  const got = Number(probe.trim().split('\n').at(-1));
  assert.ok(Math.abs(got - want) < 0.2, `MP4 の長さ ${got} 秒が再生ページの ${want} 秒と合わない`);
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
    assert.ok(r.wav);
  assert.equal(readWav(r.wav).length, Math.ceil(r.duration * SAMPLE_RATE), name);
  }
});

test('compressAudio: ffmpeg がなければ null。あれば AAC（m4a）にして小さくする', { skip: !hasCommand('ffmpeg') && 'ffmpeg がない' }, async () => {
  assert.equal(await compressAudio(wav(new Int16Array(10)), { has: () => false }), null);
  const samples = Int16Array.from({ length: SAMPLE_RATE * 2 }, (_, i) => Math.round(Math.sin(i / 10) * 8000));
  const src = wav(samples);
  const got = await compressAudio(src);
  assert.ok(got);
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
  await synthAll(['一'], p, { cacheDir: cache }); // reuse "一" to make it the most recent
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

test('e2e: sayは「-」で始まる文もオプションではなく読み上げる文として扱う', { skip: !E2E }, async () => {
  const out = join(dir, 'injected.aiff');
  const p = pickProvider('say');
  assert.ok(p);
  const [clip] = await synthAll([`--output-file=${out} こんにちは`], p, {});
  assert.ok(clip.length > 0);
  assert.equal(existsSync(out), false, '文で指定した場所にファイルを書かない');
});

test('renderVideo: flow IDs survive renamed labels across scenes and distinguish duplicate labels', async () => {
  const src = '## Before\n```flow\n@api[Old API] -> @peer[Old API]\n```\n> [api] sends a request.\n## After\n```flow\n@api[New API] -> @peer[New API]\n```\n> [api] sends another request.\n';
  const { html } = await renderVideo(src);
  const scenes = [...html.matchAll(/<section class="amv-scene[\s\S]*?<\/section>/g)].map((m) => m[0]);
  assert.equal(scenes.length, 3);
  for (const [i, label] of ['Old API', 'New API'].entries()) {
    assert.deepEqual([...scenes[i + 1].matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]), ['api', 'peer']);
    assert.equal((scenes[i + 1].match(new RegExp(`>${label}</text>`, 'g')) || []).length, 2);
    assert.doesNotMatch(scenes[i + 1], /data-key="(?:Old|New) API"/);
  }
  const data = JSON.parse(/id="amv-data">(.*?)<\/script>/.exec(html)?.[1] ?? '');
  assert.equal(data.segments[1].beats[0].focus, 'api');
  assert.equal(data.segments[2].beats[0].focus, 'api');
});
