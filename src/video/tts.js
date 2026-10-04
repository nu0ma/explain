// ナレーションの音声。優先順：ElevenLabs（ELEVENLABS_API_KEY があるとき）→ OS の読み上げ（macOS の say / Linux の espeak-ng）→ 字幕だけ。
// 1 文ごとの合成結果は 22050 Hz・モノラル・16 ビット PCM。文と声の組で EXPLAIN_HOME/cache/tts/ にキャッシュし、再描画では合成し直さない。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAMPLE_RATE = 22050;
// キャッシュの上限。22050 Hz・16 ビットで約 75 分ぶん。超えたら最後に使った時刻が古いものから消す。
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const VOICES = ['auto', 'elevenlabs', 'system', 'off'];
const ELEVEN_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const ELEVEN_MODEL = 'eleven_multilingual_v2';

export class TtsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TtsError';
  }
}

// 実際に使う音声を選ぶ。{ name, synth(text) → Int16Array } か null（字幕だけ）を返す。
export function pickProvider(choice, env, { platform = process.platform, which = hasCommand } = {}) {
  const eleven = () => elevenLabs(env);
  const system = () => systemVoice(platform, which);
  if (choice === 'off') return null;
  if (choice === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY) throw new TtsError('voice=elevenlabs には環境変数 ELEVENLABS_API_KEY が必要です');
    return eleven();
  }
  if (choice === 'system') {
    const p = system();
    if (!p) throw new TtsError('OS の読み上げ機能が見つかりません。macOS には say があります。Linux では espeak-ng を入れてください');
    return p;
  }
  if (env.ELEVENLABS_API_KEY) return eleven();
  return system();
}

function elevenLabs(env) {
  const voice = env.ELEVENLABS_VOICE_ID || ELEVEN_DEFAULT_VOICE;
  return {
    name: 'elevenlabs',
    id: `elevenlabs:${voice}:${ELEVEN_MODEL}`,
    concurrency: 2,
    async synth(text) {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_${SAMPLE_RATE}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
      });
      if (!res.ok) throw new TtsError(`ElevenLabs がエラーを返しました（${res.status}）：${(await res.text()).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)).slice();
    },
  };
}

function systemVoice(platform, which) {
  if (platform === 'darwin' && which('say')) {
    const voice = macVoice();
    return {
      name: 'say',
      id: `say:${voice ?? 'default'}`,
      concurrency: 4,
      synth: (text) => withTemp(async (file) => {
        await run('say', [...(voice ? ['-v', voice] : []), '-o', file, '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`, text]);
        return readWav(readFileSync(file));
      }),
    };
  }
  if (which('espeak-ng')) {
    return {
      name: 'espeak-ng',
      id: 'espeak-ng:ja',
      concurrency: 4,
      synth: (text) => withTemp(async (file) => {
        await run('espeak-ng', ['-v', 'ja', '-w', file, text]);
        return readWav(readFileSync(file));
      }),
    };
  }
  return null;
}

// macOS の日本語の声を選ぶ。ja_JP の声を MAC_JA_VOICES の順で探す。
export const MAC_JA_VOICES = Object.freeze(['Kyoko', 'Eddy', 'Flo', 'Reed']);

export function macVoice() {
  return pickMacVoice(spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout || '');
}

// say -v '?' の出力を解析する。名前が長いと、名前と言語コードの間が空白 1 つだけになることがある。
// 優先リストの声がなければ ja_JP の最初の声を使い、ja_JP の声がなければ undefined（OS の既定の声）を返す。
export function pickMacVoice(out) {
  const list = out.split('\n').map((l) => l.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/)).filter(Boolean).map((m) => ({ name: m[1].trim(), locale: m[2] }));
  const ja = list.filter((v) => v.locale === 'ja_JP');
  const base = (name) => name.replace(/\s*[(（].*$/, '');
  return (MAC_JA_VOICES.map((p) => ja.find((v) => base(v.name) === p)).find(Boolean) ?? ja[0])?.name;
}

export function hasCommand(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new TtsError(`${cmd} が失敗しました（${code}）：${err.slice(0, 200)}`))));
  }));
}

async function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'explain-tts-'));
  try {
    return await fn(join(dir, 'out.wav'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 16 ビット PCM の WAV を読む。多チャンネルなら最初のチャンネルを使う。
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new TtsError('WAV ファイルではありません');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new TtsError('16 ビット PCM の WAV だけに対応しています');
      const n = Math.floor(Math.min(size, buf.length - pos - 8) / 2 / fmt.channels);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(pos + 8 + i * 2 * fmt.channels);
      return fmt.rate === SAMPLE_RATE ? samples : resample({ rate: fmt.rate, samples });
    }
    pos += 8 + size + (size % 2);
  }
  throw new TtsError('WAV に data チャンクがありません');
}

// 線形補間で SAMPLE_RATE にリサンプリングする。
function resample(input) {
  if (input instanceof Int16Array) return input;
  const { rate, samples } = input;
  const n = Math.floor((samples.length * SAMPLE_RATE) / rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / SAMPLE_RATE;
    const a = Math.floor(x);
    const b = Math.min(a + 1, samples.length - 1);
    out[i] = Math.round(samples[a] + (samples[b] - samples[a]) * (x - a));
  }
  return out;
}

// すべてのナレーションを合成する（キャッシュと並列数の上限つき）。texts と同じ長さの Int16Array の配列を返す。
/**
 * @param {string[]} texts
 * @param {{ id: string, concurrency?: number, synth: (text: string) => Promise<Int16Array> }} provider
 * @param {{ cacheDir?: string }} [options]
 */
export async function synthAll(texts, provider, { cacheDir } = {}) {
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const results = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      const file = cacheDir && join(cacheDir, `${createHash('sha1').update(`${provider.id}\n${texts[i]}`).digest('hex')}.pcm`);
      if (file && existsSync(file)) {
        const buf = readFileSync(file);
        const now = new Date();
        utimesSync(file, now, now); // 最後に使った時刻を残し、上限を超えたときに消す順を決める。
        results[i] = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2).slice();
        continue;
      }
      results[i] = trimSilence(await provider.synth(texts[i]));
      if (file) writeFileSync(file, Buffer.from(results[i].buffer, results[i].byteOffset, results[i].byteLength));
    }
  };
  await Promise.all(Array.from({ length: Math.min(provider.concurrency ?? 2, texts.length) }, worker));
  if (cacheDir) pruneCache(cacheDir);
  return results;
}

// キャッシュの音声ファイルの一覧（古い順）と合計のバイト数。
export function cacheStats(cacheDir) {
  if (!existsSync(cacheDir)) return { files: [], bytes: 0 };
  const files = readdirSync(cacheDir)
    .filter((name) => name.endsWith('.pcm'))
    .map((name) => {
      const path = join(cacheDir, name);
      const st = statSync(path);
      return { path, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
  return { files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

// 合計が maxBytes を超えていたら、最後に使った時刻が古いものから消す。消したファイルの数を返す。
export function pruneCache(cacheDir, maxBytes = CACHE_MAX_BYTES) {
  let { files, bytes } = cacheStats(cacheDir);
  let removed = 0;
  for (const f of files) {
    if (bytes <= maxBytes) break;
    rmSync(f.path, { force: true });
    bytes -= f.size;
    removed++;
  }
  return removed;
}

// 前後の無音を削り、画面のテンポを実際の音声だけで決める。
export function trimSilence(samples, threshold = 300) {
  let a = 0;
  let b = samples.length;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b - 1]) < threshold) b--;
  const pad = Math.floor(SAMPLE_RATE * 0.04);
  return samples.slice(Math.max(0, a - pad), Math.min(samples.length, b + pad));
}

// 各文の音声をタイムラインどおりに 1 本の音声トラックへ置き、WAV にする。
export function mixTrack(clips, starts, duration) {
  const total = Math.ceil(duration * SAMPLE_RATE);
  const track = new Int16Array(total);
  clips.forEach((clip, i) => {
    const s0 = Math.round(starts[i] * SAMPLE_RATE);
    for (let j = 0; j < clip.length && s0 + j < total; j++) track[s0 + j] = clip[j];
  });
  return wav(track);
}

// 埋め込む音声を AAC（m4a）に圧縮する。WAV のままだと 1 秒あたり約 44 KB になる。
// ffmpeg がないときや失敗したときは null を返し、呼び出し側は WAV のまま使う。
export async function compressAudio(wavBuf, { has = hasCommand } = {}) {
  if (!has('ffmpeg')) return null;
  return withTemp(async (file) => {
    const src = file.replace(/\.wav$/, '-in.wav');
    const out = file.replace(/\.wav$/, '.m4a');
    writeFileSync(src, wavBuf);
    try {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
    } catch {
      return null;
    }
    return { mime: 'audio/mp4', data: readFileSync(out) };
  });
}

export function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 44);
  return buf;
}
