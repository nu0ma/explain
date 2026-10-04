// Narration audio, read aloud by macOS say. With --voice off, no audio is made and only captions are shown.
// Each sentence is synthesized as 22050 Hz mono 16-bit PCM and cached in EXPLAIN_HOME/cache/tts/ by sentence and voice,
// so re-rendering does not synthesize again.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SAMPLE_RATE = 22050;
// Cache size limit: about 75 minutes at 22050 Hz 16-bit. Above it, the least recently used files are removed.
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
// say: read aloud with macOS say (default). off: no audio, captions only.
export const VOICES = ['say', 'off'];

export interface TtsProvider {
  name: string;
  id: string;
  concurrency?: number;
  synth: (text: string) => Promise<Int16Array>;
  // Checks the installed voices again before new audio is synthesized. It may change id.
  refresh?: () => void;
}

export interface EncodedAudio {
  mime: string;
  data: Buffer;
}

export interface CacheFile {
  path: string;
  size: number;
  mtime: number;
}

interface WavFormat {
  channels: number;
  rate: number;
  bits: number;
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

// Picks the voice to use. Returns a provider, or null for captions only.
// Listing the voices (say -v '?') takes almost a second, so the choice is kept in voiceFile.
// The kept voice only names cached audio. Before any new audio is synthesized, synthAll calls refresh(), which lists the voices again,
// so a voice installed or removed since then is picked up before say runs.
export function pickProvider(
  choice: string,
  { platform = process.platform, which = hasCommand, voiceFile, listVoice = macVoice }: {
    platform?: NodeJS.Platform;
    which?: (cmd: string) => boolean;
    voiceFile?: string;
    listVoice?: () => string | undefined;
  } = {},
): TtsProvider | null {
  if (choice === 'off') return null;
  if (platform !== 'darwin' || !which('say')) {
    throw new TtsError('ナレーションの音声にはmacOSのsayが必要です');
  }
  let voice: string | undefined;
  let listed = false;
  const refresh = () => {
    if (listed) return;
    listed = true;
    voice = listVoice();
    if (voiceFile) {
      try {
        mkdirSync(dirname(voiceFile), { recursive: true });
        writeFileSync(voiceFile, `${JSON.stringify({ voice: voice ?? null })}\n`);
      } catch {
        // Without the file, the next run lists the voices again.
      }
    }
  };
  const kept = voiceFile ? readKeptVoice(voiceFile) : null;
  if (kept) voice = kept.voice;
  else refresh();
  return {
    name: 'say',
    get id() { return `say:${voice ?? 'default'}`; },
    // The speech service serializes much of the work, but more processes still help: 16 lines took 6.8 s with 4 and 5.5 s with 8.
    concurrency: Math.min(8, availableParallelism()),
    refresh,
    // Pass the text through a file, not an argument, so say does not parse text starting with "-" as an option.
    synth: (text) => withTemp(async (file) => {
      const input = file.replace(/\.wav$/, '.txt');
      writeFileSync(input, text);
      await run('say', [...(voice ? ['-v', voice] : []), '-o', file, '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`, '-f', input]);
      return readWav(readFileSync(file));
    }),
  };
}

// Reads the voice kept by pickProvider. Returns null when the file is missing or broken; voice is undefined for the OS default voice.
function readKeptVoice(file: string): { voice: string | undefined } | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null || !('voice' in data)) return null;
    if (data.voice === null) return { voice: undefined };
    return typeof data.voice === 'string' ? { voice: data.voice } : null;
  } catch {
    return null;
  }
}

// Picks a Japanese macOS voice, searching ja_JP voices in MAC_JA_VOICES order.
export const MAC_JA_VOICES = Object.freeze(['Kyoko', 'Eddy', 'Flo', 'Reed']);

export function macVoice(): string | undefined {
  return pickMacVoice(spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout || '');
}

// Parses the output of say -v '?'. A long name may be separated from the locale by a single space.
// Falls back to the first ja_JP voice when no preferred voice exists, and to undefined (the OS default voice) when no ja_JP voice exists.
export function pickMacVoice(out: string): string | undefined {
  const list = out.split('\n').map((l) => l.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/)).filter((m): m is RegExpMatchArray => m !== null).map((m) => ({ name: m[1].trim(), locale: m[2] }));
  const ja = list.filter((v) => v.locale === 'ja_JP');
  const base = (name: string) => name.replace(/\s*[(（].*$/, '');
  return (MAC_JA_VOICES.map((p) => ja.find((v) => base(v.name) === p)).find(Boolean) ?? ja[0])?.name;
}

export function hasCommand(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new TtsError(`${cmd} が失敗しました（${code}）：${err.slice(0, 200)}`))));
  });
}

async function withTemp<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'explain-tts-'));
  try {
    return await fn(join(dir, 'out.wav'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reads a 16-bit PCM WAV. For multichannel audio, uses the first channel.
export function readWav(buf: Buffer): Int16Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new TtsError('WAV ファイルではありません');
  let pos = 12;
  let fmt: WavFormat | null = null;
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

// Resamples to SAMPLE_RATE with linear interpolation.
function resample(input: Int16Array | { rate: number; samples: Int16Array }): Int16Array {
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

// Synthesizes all narration, with caching and a concurrency limit. Returns one Int16Array per text.
export async function synthAll(
  texts: readonly string[],
  provider: Pick<TtsProvider, 'id' | 'concurrency' | 'synth' | 'refresh'>,
  { cacheDir }: { cacheDir?: string } = {},
): Promise<Int16Array[]> {
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const cacheFile = (text: string) => cacheDir && join(cacheDir, `${createHash('sha1').update(`${provider.id}\n${text}`).digest('hex')}.pcm`);
  // Something needs synthesis, so let the provider check its voice first. The cache keys use the id after that.
  if (provider.refresh && texts.some((t) => { const f = cacheFile(t); return !f || !existsSync(f); })) provider.refresh();
  const results: Int16Array[] = [];
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      const file = cacheFile(texts[i]);
      if (file && existsSync(file)) {
        const buf = readFileSync(file);
        const now = new Date();
        utimesSync(file, now, now); // Record the last use, which decides the removal order when over the limit.
        results[i] = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2).slice();
        continue;
      }
      const clip = trimSilence(await provider.synth(texts[i]));
      results[i] = clip;
      if (file) writeFileSync(file, Buffer.from(clip.buffer, clip.byteOffset, clip.byteLength));
    }
  };
  await Promise.all(Array.from({ length: Math.min(provider.concurrency ?? 2, texts.length) }, worker));
  if (cacheDir) pruneCache(cacheDir);
  return results;
}

// Lists cached audio files (oldest first) with their total size in bytes.
export function cacheStats(cacheDir: string): { files: CacheFile[]; bytes: number } {
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

// While the total exceeds maxBytes, removes the least recently used files. Returns the number removed.
export function pruneCache(cacheDir: string, maxBytes = CACHE_MAX_BYTES): number {
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

// Trims leading and trailing silence so that only actual speech sets the pace of the screen.
export function trimSilence(samples: Int16Array, threshold = 300): Int16Array {
  let a = 0;
  let b = samples.length;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b - 1]) < threshold) b--;
  const pad = Math.floor(SAMPLE_RATE * 0.04);
  return samples.slice(Math.max(0, a - pad), Math.min(samples.length, b + pad));
}

// Places each sentence's audio on one track by the timeline and returns it as WAV.
export function mixTrack(clips: readonly Int16Array[], starts: readonly number[], duration: number): Buffer {
  const total = Math.ceil(duration * SAMPLE_RATE);
  const track = new Int16Array(total);
  clips.forEach((clip, i) => {
    const s0 = Math.round(starts[i] * SAMPLE_RATE);
    for (let j = 0; j < clip.length && s0 + j < total; j++) track[s0 + j] = clip[j];
  });
  return wav(track);
}

// Compresses the embedded audio to AAC (m4a). Plain WAV takes about 44 KB per second.
// Returns null when ffmpeg is missing or fails, and the caller then keeps the WAV.
export async function compressAudio(wavBuf: Buffer, { has = hasCommand }: { has?: (cmd: string) => boolean } = {}): Promise<EncodedAudio | null> {
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

export function wav(samples: Int16Array): Buffer {
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
