// --mp4：手元の Chrome（ヘッドレス、Chrome DevTools Protocol 経由）で再生ページの render(t) をフレームごとに呼んでスクリーンショットを撮り、
// ffmpeg で H.264 にエンコードしてナレーションの音声と合わせる。Playwright や Puppeteer は使わない。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasCommand } from './tts.js';

export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

const CHROME_PATHS = {
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

export function findChrome(env = process.env, platform = process.platform) {
  const custom = env.EXPLAIN_CHROME || env.CHROME_PATH;
  if (custom) return custom;
  const list = CHROME_PATHS[platform] ?? CHROME_PATHS.linux;
  return list.find((p) => (p.includes('/') || p.includes('\\') ? existsSync(p) : hasCommand(p))) ?? null;
}

// render(t) は決定的なので、同じページを concurrency 枚のタブで開き、フレームを分けて並列に撮る。
// deps でブラウザと ffmpeg の起動を差し替えられる（テスト用）。
export async function exportMp4(htmlFile, mp4File, { wav, env = process.env, onProgress = () => {}, concurrency = Math.min(4, availableParallelism()), deps = {} } = {}) {
  const { has = hasCommand, find = findChrome, launch = launchChrome, encoder = spawnFfmpeg } = deps;
  if (!has('ffmpeg')) throw new ExportError('MP4 の書き出しには ffmpeg が必要です。macOS は brew install ffmpeg、Linux はパッケージマネージャーで入れてください');
  const chromePath = find(env);
  if (!chromePath) throw new ExportError('Chrome / Chromium / Edge が見つかりません。環境変数 EXPLAIN_CHROME でブラウザのパスを指定できます');

  const tmp = mkdtempSync(join(tmpdir(), 'explain-export-'));
  let browser = null;
  let ffmpeg = null;
  let encoded = false;
  try {
    browser = await launch(chromePath, join(tmp, 'profile'));
    const pages = await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => openPage(browser.cdp, htmlFile)));
    const infos = await Promise.all(pages.map((p) => p.evaluate('document.fonts.ready.then(() => { window.__amv.exportMode(); return { duration: window.__amv.duration, fps: window.__amv.fps }; })')));
    const info = infos[0];

    const wavFile = wav ? join(tmp, 'voice.wav') : null;
    if (wav) writeFileSync(wavFile, wav);
    ffmpeg = encoder([
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-',
      ...(wavFile ? ['-i', wavFile] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
      ...(wavFile ? ['-c:a', 'aac', '-b:a', '160k', '-shortest'] : []),
      '-movflags', '+faststart', mp4File,
    ]);
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => { ffErr += d; });
    // ffmpeg が途中で落ちたら、フレームを書き込んでいる最中でも失敗として扱う。
    const done = new Promise((resolve, reject) => {
      ffmpeg.on('error', (e) => reject(new ExportError(`ffmpeg を起動できません：${e.message}`)));
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new ExportError(`ffmpeg が失敗しました（${code}）：${ffErr.slice(0, 300)}`))));
    });
    done.catch(() => {});
    const write = (buf) => (ffmpeg.stdin.write(buf) ? null : Promise.race([new Promise((r) => ffmpeg.stdin.once('drain', r)), done]));

    const frames = Math.ceil(info.duration * info.fps);
    const capture = async (p, i) => {
      await p.evaluate(`render(${i / info.fps})`);
      const { data } = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
      return Buffer.from(data, 'base64');
    };
    // タブの数ずつまとめて撮り、フレームの順に ffmpeg へ渡す。まとめる数を抑えて、メモリに貯めるフレームを増やさない。
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
    ffmpeg.stdin.end();
    await done;
    encoded = true;
    return { frames, duration: info.duration };
  } finally {
    // 途中で失敗したら ffmpeg も止める。止めないと標準入力が開いたまま残り、CLI が終了しない。
    if (ffmpeg && !encoded) {
      ffmpeg.stdin.destroy();
      ffmpeg.kill('SIGKILL');
    }
    if (browser) await browser.stop();
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // 一時ディレクトリを消せなくても、できた動画には影響しない。
    }
  }
}

// 新しいタブで再生ページを開き、読み込みを待つ。send と evaluate はそのタブに向けて送る。
async function openPage(cdp, htmlFile) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  loaded.catch(() => {}); // 読み込みの前に失敗したときに、未処理の reject として残さない。
  await send('Page.navigate', { url: pathToFileURL(htmlFile).href });
  await loaded;
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new ExportError(`再生ページのスクリプトでエラーが起きました：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { send, evaluate };
}

function spawnFfmpeg(args) {
  return spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

// ヘッドレスの Chrome を起動して CDP でつなぐ。stop() は Chrome を終了させ、終了を最大 3 秒待つ。
async function launchChrome(chromePath, profileDir) {
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', '--window-size=1920,1080', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = () => new Promise((r) => {
    if (chrome.exitCode !== null) return r();
    const timer = setTimeout(r, 3000);
    chrome.once('exit', () => { clearTimeout(timer); r(); });
    chrome.kill();
  });
  let cdp;
  try {
    cdp = await connect(await devtoolsUrl(chrome));
  } catch (e) {
    await stop();
    throw e;
  }
  return { cdp, stop: async () => { cdp.close(); await stop(); } };
}

function devtoolsUrl(chrome) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new ExportError('Chrome の起動がタイムアウトしました')), 20000);
    chrome.on('error', (e) => { clearTimeout(timer); reject(new ExportError(`Chrome を起動できません：${e.message}`)); });
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
}

// 最小限の CDP クライアント：要求と応答は id で対応づけ、イベントはセッションとメソッド名の組で 1 回だけ待つ。
// 接続が切れたら（Chrome が落ちたときなど）、応答を待っている要求とイベントをすべて失敗させる。
export function connect(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const pending = new Map();
    const waiters = new Map();
    let id = 0;
    let closed = null;
    const failAll = (err) => {
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
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new ExportError(`CDP ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method && waiters.has(`${msg.sessionId ?? ''}:${msg.method}`)) {
        const key = `${msg.sessionId ?? ''}:${msg.method}`;
        waiters.get(key).ok(msg.params);
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
