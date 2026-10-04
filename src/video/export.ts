// --mp4: drives the local Chrome (headless, over the Chrome DevTools Protocol) to call the player's render(t) per frame and take screenshots,
// then encodes them to H.264 with ffmpeg together with the narration audio. Playwright and Puppeteer are not used.
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { hasCommand } from './tts.ts';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export type CdpParams = Record<string, unknown>;

export interface CdpClient {
  send(method: string, params?: CdpParams, sessionId?: string): Promise<unknown>;
  once(method: string, sessionId?: string): Promise<unknown>;
  close(): void;
}

export interface Browser {
  cdp: CdpClient;
  stop: () => Promise<void>;
}

// The subset of a child process that the encoder needs. A real ffmpeg process satisfies it, and tests can fake it.
export interface EncoderProcess {
  stdin: Writable;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ExportDeps {
  has?: (cmd: string) => boolean;
  find?: (env: NodeJS.ProcessEnv) => string | null;
  launch?: (chromePath: string, profileDir: string) => Promise<Browser>;
  encoder?: (args: string[]) => EncoderProcess;
}

export interface ExportOptions {
  wav?: Buffer | null;
  env?: NodeJS.ProcessEnv;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  deps?: ExportDeps;
}

// What the player page reports after switching to export mode.
interface PlayerInfo {
  duration: number;
  fps: number;
}

// Parameters and results of the CDP commands this module sends.
interface CdpCommands {
  'Emulation.setDeviceMetricsOverride': { params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }; result: unknown };
  'Page.enable': { params: Record<string, never>; result: unknown };
  'Page.navigate': { params: { url: string }; result: unknown };
  'Page.captureScreenshot': {
    params: { format: 'jpeg' | 'png'; quality?: number; captureBeyondViewport?: boolean; clip: { x: number; y: number; width: number; height: number; scale: number } };
    result: { data: string };
  };
  'Runtime.evaluate': {
    params: { expression: string; awaitPromise: boolean; returnByValue: boolean };
    result: { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  };
}

export interface Page {
  send<M extends keyof CdpCommands>(method: M, params?: CdpCommands[M]['params']): Promise<CdpCommands[M]['result']>;
  evaluate(expression: string): Promise<unknown>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

interface Pending {
  ok: (value: unknown) => void;
  fail: (err: Error) => void;
}

// The socket API that connect uses. The global WebSocket satisfies it.
export interface CdpSocket {
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (ev: Event) => void): void;
  send(data: string): void;
  close(): void;
}

const CHROME_PATHS: { [P in NodeJS.Platform]?: string[] } & { linux: string[] } = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const custom = env.EXPLAIN_CHROME || env.CHROME_PATH;
  if (custom) return custom;
  const list = CHROME_PATHS[platform] ?? CHROME_PATHS.linux;
  return list.find((p) => (p.includes('/') || p.includes('\\') ? existsSync(p) : hasCommand(p))) ?? null;
}

// render(t) is deterministic, so the same page is opened in `concurrency` tabs and frames are split between them.
// deps replaces the browser and ffmpeg launchers (for tests).
export async function exportMp4(
  htmlFile: string,
  mp4File: string,
  { wav, env = process.env, onProgress = () => {}, concurrency = Math.min(4, availableParallelism()), deps = {} }: ExportOptions = {},
): Promise<{ frames: number; duration: number }> {
  const { has = hasCommand, find = findChrome, launch = launchChrome, encoder = spawnFfmpeg } = deps;
  if (!has('ffmpeg')) throw new ExportError('MP4 の書き出しには ffmpeg が必要です。macOS は brew install ffmpeg、Linux はパッケージマネージャーで入れてください');
  const chromePath = find(env);
  if (!chromePath) throw new ExportError('Chrome / Chromium / Edge が見つかりません。環境変数 EXPLAIN_CHROME でブラウザのパスを指定できます');

  const tmp = mkdtempSync(join(tmpdir(), 'explain-export-'));
  let browser: Browser | null = null;
  let ffmpeg: EncoderProcess | null = null;
  let encoded = false;
  try {
    browser = await launch(chromePath, join(tmp, 'profile'));
    const { cdp } = browser;
    const pages = await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => openPage(cdp, htmlFile)));
    const infos = await Promise.all(pages.map((p) => p.evaluate('document.fonts.ready.then(() => { window.__amv.exportMode(); return { duration: window.__amv.duration, fps: window.__amv.fps }; })')));
    // The expression above returns this shape from the player page.
    const info = infos[0] as PlayerInfo;

    const wavFile = wav ? join(tmp, 'voice.wav') : null;
    if (wav && wavFile) writeFileSync(wavFile, wav);
    const proc = ffmpeg = encoder([
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-',
      ...(wavFile ? ['-i', wavFile] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
      ...(wavFile ? ['-c:a', 'aac', '-b:a', '160k', '-shortest'] : []),
      '-movflags', '+faststart', mp4File,
    ]);
    let ffErr = '';
    proc.stderr.on('data', (d) => { ffErr += d; });
    // If ffmpeg dies midway, treat it as a failure even while frames are still being written.
    const done = new Promise<void>((resolve, reject) => {
      proc.on('error', (e) => reject(new ExportError(`ffmpeg を起動できません：${e.message}`)));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new ExportError(`ffmpeg が失敗しました（${code}）：${ffErr.slice(0, 300)}`))));
    });
    done.catch(() => {});
    const write = (buf: Buffer) => (proc.stdin.write(buf) ? null : Promise.race([new Promise((r) => proc.stdin.once('drain', r)), done]));

    const frames = Math.ceil(info.duration * info.fps);
    const capture = async (p: Page, i: number) => {
      await p.evaluate(`render(${i / info.fps})`);
      const { data } = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
      return Buffer.from(data, 'base64');
    };
    // Capture one frame per tab at a time and pass them to ffmpeg in frame order. Small batches keep buffered frames in memory low.
    let reported = -1;
    for (let i = 0; i < frames; i += pages.length) {
      const batch = await Promise.all(pages.slice(0, frames - i).map((p, k) => capture(p, i + k)));
      for (const buf of batch) await write(buf);
      const n = i + batch.length;
      if (Math.floor((n - 1) / 30) > reported || n === frames) {
        reported = Math.floor((n - 1) / 30);
        onProgress(n, frames);
      }
    }
    proc.stdin.end();
    await done;
    encoded = true;
    return { frames, duration: info.duration };
  } finally {
    // On failure, stop ffmpeg as well. Otherwise its stdin stays open and the CLI never exits.
    if (ffmpeg && !encoded) {
      ffmpeg.stdin.destroy();
      ffmpeg.kill('SIGKILL');
    }
    if (browser) await browser.stop();
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Failing to remove the temp directory does not affect the finished video.
    }
  }
}

// Opens a page in a new tab and waits for it to load. send and evaluate target that tab.
export async function openPage(cdp: CdpClient, htmlFile: string, { width = 1920, height = 1080 }: { width?: number; height?: number } = {}): Promise<Page> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  // The result shapes come from the CDP specification for each command.
  const send = <M extends keyof CdpCommands>(method: M, params?: CdpCommands[M]['params']) =>
    cdp.send(method, params, sessionId) as Promise<CdpCommands[M]['result']>;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  loaded.catch(() => {}); // Do not leave an unhandled rejection when something fails before the load.
  await send('Page.navigate', { url: pathToFileURL(htmlFile).href });
  await loaded;
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new ExportError(`ページのスクリプトでエラーが起きました：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { send, evaluate };
}

function spawnFfmpeg(args: string[]): EncoderProcess {
  return spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

// Launches headless Chrome and connects over CDP. stop() terminates Chrome and waits up to 3 seconds for it to exit.
export async function launchChrome(chromePath: string, profileDir: string): Promise<Browser> {
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', '--window-size=1920,1080', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = () => new Promise<void>((r) => {
    if (chrome.exitCode !== null) return r();
    const timer = setTimeout(r, 3000);
    chrome.once('exit', () => { clearTimeout(timer); r(); });
    chrome.kill();
  });
  let cdp: CdpClient;
  try {
    cdp = await connect(await devtoolsUrl(chrome));
  } catch (e) {
    await stop();
    throw e;
  }
  return { cdp, stop: async () => { cdp.close(); await stop(); } };
}

function devtoolsUrl(chrome: ChildProcessByStdio<null, null, Readable>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new ExportError('Chrome の起動がタイムアウトしました')), 20000);
    chrome.on('error', (e) => { clearTimeout(timer); reject(new ExportError(`Chrome を起動できません：${e.message}`)); });
    chrome.stderr.on('data', (d: Buffer) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
}

// Minimal CDP client: requests and responses are matched by id, and events are awaited once per (session, method) pair.
// When the connection drops (for example, when Chrome crashes), all pending requests and event waits fail.
export function connect(url: string, { WebSocketImpl = globalThis.WebSocket }: { WebSocketImpl?: new (url: string) => CdpSocket } = {}): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const pending = new Map<number, Pending>();
    const waiters = new Map<string, Pending>();
    let id = 0;
    let closed: Error | null = null;
    const failAll = (err: Error) => {
      if (closed) return;
      closed = err;
      for (const { fail } of pending.values()) fail(err);
      for (const { fail } of waiters.values()) fail(err);
      pending.clear();
      waiters.clear();
      reject(err);
    };
    ws.addEventListener('error', () => failAll(new ExportError('Chrome DevTools との接続でエラーが起きました')));
    ws.addEventListener('close', () => failAll(new ExportError('Chrome DevTools との接続が切れました')));
    ws.addEventListener('message', (ev) => {
      const msg: CdpMessage = JSON.parse((ev as MessageEvent<string>).data);
      const request = msg.id ? pending.get(msg.id) : undefined;
      if (msg.id && request) {
        pending.delete(msg.id);
        if (msg.error) request.fail(new ExportError(`CDP ${msg.error.message}`));
        else request.ok(msg.result);
      } else if (msg.method && waiters.has(`${msg.sessionId ?? ''}:${msg.method}`)) {
        const key = `${msg.sessionId ?? ''}:${msg.method}`;
        waiters.get(key)?.ok(msg.params);
        waiters.delete(key);
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        if (closed) return Promise.reject(closed);
        return new Promise((ok, fail) => {
          pending.set(++id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      once(method, sessionId) {
        if (closed) return Promise.reject(closed);
        return new Promise((ok, fail) => waiters.set(`${sessionId ?? ''}:${method}`, { ok, fail }));
      },
      close: () => ws.close(),
    }));
  });
}
