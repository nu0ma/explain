// --mp4: drives the local Chrome (headless, over the Chrome DevTools Protocol) to call the player's render(t) per frame and take screenshots,
// then encodes them to H.264 with ffmpeg together with the narration audio. Playwright and Puppeteer are not used.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { hasCommand } from './tts.ts';
import type { NetworkOptions } from '../network.ts';

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
  // Persistent events from every session. Optional for existing injected test clients.
  on?: (method: string, listener: (params: unknown, sessionId?: string) => void) => () => void;
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
  launch?: (chromePath: string, profileDir: string, options?: NetworkOptions) => Promise<Browser>;
  encoder?: (args: string[]) => EncoderProcess;
}

export interface ExportOptions extends NetworkOptions {
  wav?: Buffer | null;
  env?: NodeJS.ProcessEnv;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  // How many Chrome processes share the tabs. One Chrome takes about 40 ms per screenshot no matter how many tabs it has.
  browsers?: number;
  deps?: ExportDeps;
}

// What the player page reports after switching to export mode.
interface PlayerInfo {
  duration: number;
  fps: number;
  // Time ranges in which the frame can change (window.__amv.keyframes()). Without them, every frame is captured.
  keyframes?: [number, number][];
}

// Slack for floating-point rounding at the range bounds. Far smaller than one frame, so it adds a frame only at an exact bound.
const KEYFRAME_EPS = 1e-6;

// The frames that need a screenshot: frame 0, and each frame i whose time span (t(i-1), t(i)] touches a change range.
// This includes the first frame after each range ends, which shows the final state. Every other frame equals the frame before it.
export function changedFrames(keyframes: [number, number][] | undefined, frames: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    const prev = (i - 1) / fps;
    if (!keyframes || i === 0 || keyframes.some(([from, to]) => t >= from - KEYFRAME_EPS && prev < to + KEYFRAME_EPS)) out.push(i);
  }
  return out;
}

// Parameters and results of the CDP commands this module sends.
interface CdpCommands {
  'Emulation.setDeviceMetricsOverride': { params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }; result: unknown };
  'Page.enable': { params: Record<string, never>; result: unknown };
  'Page.navigate': { params: { url: string }; result: unknown };
  'Page.captureScreenshot': {
    params: { format: 'jpeg' | 'png'; quality?: number; optimizeForSpeed?: boolean; captureBeyondViewport?: boolean; clip: { x: number; y: number; width: number; height: number; scale: number } };
    result: { data: string };
  };
  'Runtime.evaluate': {
    params: { expression: string; awaitPromise: boolean; returnByValue: boolean; userGesture?: boolean };
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

// The socket API that connect uses. PipeSocket implements it, and tests can fake it.
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
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const custom = env.EXPLAIN_CHROME || env.CHROME_PATH;
  if (custom) return custom;
  const list = CHROME_PATHS[platform] ?? CHROME_PATHS.linux;
  return list.find((p) => (p.includes('/') ? existsSync(p) : hasCommand(p))) ?? null;
}

// render(t) is deterministic, so the same page is opened in `concurrency` tabs and frames are split between them.
// The tabs are spread over `browsers` Chrome processes, because screenshots in one Chrome do not run in parallel.
// deps replaces the browser and ffmpeg launchers (for tests).
export async function exportMp4(
  htmlFile: string,
  mp4File: string,
  { wav, env = process.env, onProgress = () => {}, concurrency = Math.min(8, availableParallelism()), browsers = Math.ceil(concurrency / 2), deps = {}, allowNetwork = false }: ExportOptions = {},
): Promise<{ frames: number; duration: number }> {
  const { has = hasCommand, find = findChrome, launch = launchChrome, encoder = spawnFfmpeg } = deps;
  if (!has('ffmpeg')) throw new ExportError('MP4 の書き出しには ffmpeg が必要です。macOS は brew install ffmpeg、Linux はパッケージマネージャーで入れてください');
  const chromePath = find(env);
  if (!chromePath) throw new ExportError('Chrome / Chromium / Edge が見つかりません。環境変数 EXPLAIN_CHROME でブラウザのパスを指定できます');

  const tmp = mkdtempSync(join(tmpdir(), 'explain-export-'));
  const launched: Browser[] = [];
  let ffmpeg: EncoderProcess | null = null;
  let encoded = false;
  try {
    const tabs = Math.max(1, concurrency);
    await Promise.all(Array.from({ length: Math.min(tabs, Math.max(1, browsers)) }, async (_, i) => {
      launched.push(await launch(chromePath, join(tmp, `profile-${i}`), { allowNetwork }));
    }));
    const pages = await Promise.all(Array.from({ length: tabs }, (_, i) => openPage(launched[i % launched.length].cdp, htmlFile, { allowNetwork })));
    const infos = await Promise.all(pages.map((p) => p.evaluate('document.fonts.ready.then(() => { window.__amv.exportMode(); return { duration: window.__amv.duration, fps: window.__amv.fps, keyframes: window.__amv.keyframes() }; })')));
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
    // Only frames that can change are captured; each screenshot is sent again for the unchanged frames that follow it.
    // Each tab takes the next screenshot as soon as it is free. Finished screenshots wait in `ready` until the ones
    // before them are written, so ffmpeg gets frames in order. A tab stops `ahead` screenshots past the oldest unwritten one,
    // which keeps buffered frames in memory low.
    const shots = changedFrames(info.keyframes, frames, info.fps);
    const ahead = pages.length * 2;
    const ready = new Map<number, Buffer>();
    const waiting: (() => void)[] = [];
    let next = 0;
    let written = 0;
    let reported = -1;
    const drain = async () => {
      while (ready.has(written)) {
        const buf = ready.get(written) as Buffer;
        ready.delete(written);
        const n = shots[written + 1] ?? frames;
        for (let f = shots[written]; f < n; f++) await write(buf);
        written++;
        for (const wake of waiting.splice(0)) wake();
        if (Math.floor((n - 1) / 30) > reported || n === frames) {
          reported = Math.floor((n - 1) / 30);
          onProgress(n, frames);
        }
      }
    };
    let writing = Promise.resolve();
    const worker = async (page: Page) => {
      while (next < shots.length) {
        const j = next++;
        // done settles only when ffmpeg exits, so a failed ffmpeg also ends the wait.
        while (j >= written + ahead) await Promise.race([new Promise<void>((r) => waiting.push(r)), done]);
        ready.set(j, await capture(page, shots[j]));
        writing = writing.then(drain);
        writing.catch(() => {}); // Rejections are rethrown by the await below.
      }
    };
    await Promise.all(pages.map(worker));
    await writing;
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
    await Promise.all(launched.map((b) => b.stop()));
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Failing to remove the temp directory does not affect the finished video.
    }
  }
}

// Opens a page in a new tab and waits for it to load. send and evaluate target that tab.
export async function openPage(cdp: CdpClient, htmlFile: string, { width = 1920, height = 1080, allowNetwork = false }: { width?: number; height?: number } & NetworkOptions = {}): Promise<Page> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  // The result shapes come from the CDP specification for each command.
  const send = <M extends keyof CdpCommands>(method: M, params?: CdpCommands[M]['params']) =>
    cdp.send(method, params, sessionId) as Promise<CdpCommands[M]['result']>;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  // Set the export boundary before parsing any author content, independent of its CSP.
  if (!allowNetwork) await blockPageNetwork(cdp, sessionId);
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

async function blockPageNetwork(cdp: CdpClient, sessionId: string): Promise<void> {
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*'] }, sessionId);
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

// Install at the browser target before opening author content. Pausing new targets also
// holds window.open's initial navigation until its session has the network restrictions.
// This complements the document CSP; it is not an OS-level network or hostile-code sandbox.
export async function guardBrowserNetwork(cdp: CdpClient, onFailure: (error: Error) => void): Promise<() => void> {
  if (!cdp.on) throw new ExportError('The browser cannot enforce network restrictions: CDP events are unavailable');
  let disposed = false;
  const seen = new Set<string>();
  const off = cdp.on('Target.attachedToTarget', (params) => {
    if (disposed) return;
    const { sessionId } = params as { sessionId: string };
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const configure = async () => {
      await blockPageNetwork(cdp, sessionId);
      // Auto-attachment is not recursive; keep descendants paused until protected too.
      await cdp.send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
      if (!disposed) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    };
    void configure().catch((error: unknown) => {
      if (disposed) return;
      disposed = true;
      off();
      // Never resume a target after a failed security command. The launcher closes the
      // connection and stops Chrome, making in-flight exports fail rather than hang.
      onFailure(error instanceof Error ? error : new ExportError(String(error)));
    });
  });
  const dispose = () => { disposed = true; off(); };
  try {
    await cdp.send('Target.setAutoAttach', AUTO_ATTACH);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

// Launches headless Chrome and talks CDP over a pipe (fds 3 and 4), so no DevTools port is opened for other local processes.
// stop() terminates Chrome and waits up to 3 seconds for it to exit, then kills it outright.
export async function launchChrome(chromePath: string, profileDir: string, { allowNetwork = false }: NetworkOptions = {}): Promise<Browser> {
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1920,1080', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const stop = () => new Promise<void>((r) => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return r();
    const timer = setTimeout(() => { chrome.kill('SIGKILL'); r(); }, 3000);
    chrome.once('exit', () => { clearTimeout(timer); r(); });
    chrome.kill();
  });
  // Chrome reads commands from fd 3 and writes responses to fd 4.
  const socket = new PipeSocket(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
  chrome.once('error', (e) => socket.fail(new ExportError(`Chrome を起動できません：${e.message}`)));
  chrome.once('exit', () => socket.fail(new ExportError('Chrome が終了しました')));
  let cdp: CdpClient;
  let unguard: (() => void) | undefined;
  try {
    cdp = await connect(socket);
    // The first command also checks that Chrome started.
    await cdp.send('Target.getTargets');
    if (!allowNetwork) {
      unguard = await guardBrowserNetwork(cdp, (error) => {
        socket.fail(error);
        void stop();
      });
    }
  } catch (e) {
    unguard?.();
    await stop();
    throw e;
  }
  return { cdp, stop: async () => { unguard?.(); cdp.close(); await stop(); } };
}

// An 'error' event that carries the cause. Node 22 has no global ErrorEvent.
class SocketErrorEvent extends Event {
  error: Error;
  constructor(error: Error) {
    super('error');
    this.error = error;
  }
}

// CdpSocket over Chrome's --remote-debugging-pipe: each message is JSON terminated by a NUL byte.
class PipeSocket extends EventTarget implements CdpSocket {
  #out: Writable;
  #failed = false;
  constructor(out: Writable, input: Readable) {
    super();
    this.#out = out;
    let buf = '';
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\0')) !== -1) {
        this.dispatchEvent(new MessageEvent('message', { data: buf.slice(0, end) }));
        buf = buf.slice(end + 1);
      }
    });
    input.on('close', () => this.fail(new ExportError('Chrome DevTools との接続が切れました')));
    input.on('error', () => this.fail(new ExportError('Chrome DevTools との接続でエラーが起きました')));
    out.on('error', () => this.fail(new ExportError('Chrome DevTools との接続でエラーが起きました')));
    setImmediate(() => this.dispatchEvent(new Event('open')));
  }

  send(data: string): void {
    this.#out.write(`${data}\0`);
  }

  close(): void {
    this.#out.end();
  }

  fail(err: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.dispatchEvent(new SocketErrorEvent(err));
  }
}

// Long enough for a slow page load or font loading; short enough that a page stuck in a script loop does not hang the CLI.
export const CDP_TIMEOUT_MS = 30000;

// Minimal CDP client: requests and responses are matched by id, and events are awaited once per (session, method) pair.
// When the connection drops (for example, when Chrome crashes), all pending requests and event waits fail.
// A request or event wait that gets no answer within timeoutMs fails, which also covers a page whose script never returns.
export function connect(socket: CdpSocket, { timeoutMs = CDP_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const pending = new Map<number, Pending>();
    const waiters = new Map<string, Pending>();
    const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
    let id = 0;
    let closed: Error | null = null;
    const failAll = (err: Error) => {
      if (closed) return;
      closed = err;
      for (const { fail } of pending.values()) fail(err);
      for (const { fail } of waiters.values()) fail(err);
      pending.clear();
      waiters.clear();
      listeners.clear();
      reject(err);
    };
    // Registers a request or event wait that fails after timeoutMs.
    const track = <K>(map: Map<K, Pending>, key: K, what: string) => new Promise<unknown>((ok, fail) => {
      const timer = setTimeout(() => {
        map.delete(key);
        fail(new ExportError(`Chrome が ${timeoutMs / 1000} 秒以内に応答しません（${what}）`));
      }, timeoutMs);
      map.set(key, {
        ok: (v) => { clearTimeout(timer); ok(v); },
        fail: (e) => { clearTimeout(timer); fail(e); },
      });
    });
    socket.addEventListener('error', (ev) => {
      failAll(ev instanceof SocketErrorEvent ? ev.error : new ExportError('Chrome DevTools との接続でエラーが起きました'));
    });
    socket.addEventListener('close', () => failAll(new ExportError('Chrome DevTools との接続が切れました')));
    socket.addEventListener('message', (ev) => {
      const msg: CdpMessage = JSON.parse((ev as MessageEvent<string>).data);
      const request = msg.id ? pending.get(msg.id) : undefined;
      if (msg.id && request) {
        pending.delete(msg.id);
        if (msg.error) request.fail(new ExportError(`CDP ${msg.error.message}`));
        else request.ok(msg.result);
      } else if (msg.method) {
        const key = `${msg.sessionId ?? ''}:${msg.method}`;
        waiters.get(key)?.ok(msg.params);
        waiters.delete(key);
        for (const listener of listeners.get(msg.method) ?? []) listener(msg.params, msg.sessionId);
      }
    });
    socket.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        if (closed) return Promise.reject(closed);
        const result = track(pending, ++id, method);
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return result;
      },
      once(method, sessionId) {
        if (closed) return Promise.reject(closed);
        return track(waiters, `${sessionId ?? ''}:${method}`, method);
      },
      on(method, listener) {
        if (closed) throw closed;
        let handlers = listeners.get(method);
        if (!handlers) listeners.set(method, handlers = new Set());
        handlers.add(listener);
        return () => { handlers.delete(listener); };
      },
      close: () => socket.close(),
    }));
  });
}
