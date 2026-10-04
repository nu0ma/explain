// --mp4：手元の Chrome（ヘッドレス、Chrome DevTools Protocol 経由）で再生ページの render(t) をフレームごとに呼んでスクリーンショットを撮り、
// ffmpeg で H.264 にエンコードしてナレーションの音声と合わせる。Playwright や Puppeteer は使わない。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

export async function exportMp4(htmlFile, mp4File, { wav, env = process.env, onProgress = () => {} } = {}) {
  if (typeof WebSocket === 'undefined') throw new ExportError('MP4 の書き出しには Node.js 22 以上（組み込みの WebSocket）が必要です');
  if (!hasCommand('ffmpeg')) throw new ExportError('MP4 の書き出しには ffmpeg が必要です。macOS は brew install ffmpeg、Linux はパッケージマネージャーで入れてください');
  const chromePath = findChrome(env);
  if (!chromePath) throw new ExportError('Chrome / Chromium / Edge が見つかりません。環境変数 EXPLAIN_CHROME でブラウザのパスを指定できます');

  const tmp = mkdtempSync(join(tmpdir(), 'explain-export-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', '--window-size=1920,1080', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const cdp = await connect(await devtoolsUrl(chrome));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);
    await page('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await page('Page.enable');
    const loaded = cdp.once('Page.loadEventFired');
    await page('Page.navigate', { url: pathToFileURL(htmlFile).href });
    await loaded;
    const evaluate = async (expression) => {
      const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new ExportError(`再生ページのスクリプトでエラーが起きました：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const info = await evaluate('document.fonts.ready.then(() => { window.__amv.exportMode(); return { duration: window.__amv.duration, fps: window.__amv.fps }; })');

    const wavFile = wav ? join(tmp, 'voice.wav') : null;
    if (wav) writeFileSync(wavFile, wav);
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-',
      ...(wavFile ? ['-i', wavFile] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
      ...(wavFile ? ['-c:a', 'aac', '-b:a', '160k', '-shortest'] : []),
      '-movflags', '+faststart', mp4File,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => { ffErr += d; });
    const done = new Promise((resolve, reject) => {
      ffmpeg.on('error', reject);
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new ExportError(`ffmpeg が失敗しました（${code}）：${ffErr.slice(0, 300)}`))));
    });

    const frames = Math.ceil(info.duration * info.fps);
    for (let i = 0; i < frames; i++) {
      await evaluate(`render(${i / info.fps})`);
      const { data } = await page('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
      if (!ffmpeg.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      if (i % 30 === 0 || i === frames - 1) onProgress(i + 1, frames);
    }
    ffmpeg.stdin.end();
    await done;
    cdp.close();
    return { frames, duration: info.duration };
  } finally {
    await new Promise((r) => {
      if (chrome.exitCode !== null) return r();
      const timer = setTimeout(r, 3000);
      chrome.once('exit', () => { clearTimeout(timer); r(); });
      chrome.kill();
    });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // 一時ディレクトリを消せなくても、できた動画には影響しない。
    }
  }
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

// 最小限の CDP クライアント：要求と応答は id で対応づけ、イベントはメソッド名で 1 回だけ待つ。
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const waiters = new Map();
    let id = 0;
    ws.addEventListener('error', () => reject(new ExportError('Chrome DevTools に接続できません')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new ExportError(`CDP ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method && waiters.has(msg.method)) {
        waiters.get(msg.method)(msg.params);
        waiters.delete(msg.method);
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((ok, fail) => {
          pending.set(++id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      once: (method) => new Promise((r) => waiters.set(method, r)),
      close: () => ws.close(),
    }));
  });
}
