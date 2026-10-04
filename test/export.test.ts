import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportMp4, connect, ExportError } from '../src/video/export.ts';
import type { CdpParams, CdpSocket, ExportDeps } from '../src/video/export.ts';

// Stands in for ffmpeg: collects frames written to stdin and exits with exitCode when stdin closes.
class FakeFfmpeg extends EventEmitter {
  args: string[] | null = null;
  frames: string[] = [];
  killed: NodeJS.Signals | null | undefined = null;
  stderr = new EventEmitter();
  stdin: Writable;
  constructor({ exitCode = 0, stderr = '' } = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => { this.frames.push(chunk.toString()); cb(); },
      final: (cb) => {
        cb();
        setImmediate(() => {
          if (stderr) this.stderr.emit('data', stderr);
          this.emit('close', exitCode);
        });
      },
    });
  }
  kill(sig?: NodeJS.Signals) { this.killed = sig; }
}

const fakeFfmpeg = (opts: { exitCode?: number; stderr?: string } = {}) => new FakeFfmpeg(opts);

// Stands in for Chrome: remembers the last time drawn per tab and returns "f<time>" as the screenshot.
// Drawing the failAt time returns a script error.
function fakeBrowser({ duration = 1, fps = 4, failAt = -1 } = {}) {
  let targets = 0;
  const drawn = new Map<string | undefined, number>();
  const browser = {
    stopped: false,
    profileDir: null as string | null,
    tabs: 0,
    cdp: {
      async send(method: string, params: CdpParams = {}, sessionId?: string): Promise<unknown> {
        if (method === 'Target.createTarget') return { targetId: `t${++targets}` };
        if (method === 'Target.attachToTarget') { browser.tabs++; return { sessionId: `s-${String(params.targetId)}` }; }
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression);
          if (expression.startsWith('document.fonts')) return { result: { value: { duration, fps } } };
          const t = Number(/^render\((.+)\)$/.exec(expression)?.[1]);
          if (t === failAt) return { exceptionDetails: { text: 'boom' } };
          drawn.set(sessionId, t);
          return { result: {} };
        }
        if (method === 'Page.captureScreenshot') return { data: Buffer.from(`f${drawn.get(sessionId)}`).toString('base64') };
        return {};
      },
      once: async () => ({}),
      close: () => {},
    },
    stop: async () => { browser.stopped = true; },
  };
  return browser;
}

function setup({
  browser = fakeBrowser(),
  ffmpeg = fakeFfmpeg(),
  has = () => true,
  find = () => '/chrome',
}: { browser?: ReturnType<typeof fakeBrowser>; ffmpeg?: FakeFfmpeg; has?: () => boolean; find?: () => string | null } = {}) {
  const progress: [number, number][] = [];
  const deps: ExportDeps = {
    has,
    find,
    launch: async (_path, profileDir) => { browser.profileDir = profileDir; return browser; },
    encoder: (args) => { ffmpeg.args = args; return ffmpeg; },
  };
  return { browser, ffmpeg, progress, opts: { deps, onProgress: (i: number, n: number) => progress.push([i, n]) } };
}

test('exportMp4: 全フレームを順に ffmpeg に渡し、ブラウザを止めて一時ディレクトリを消す', async () => {
  const cases = [
    { name: '音声なし・タブ 1 枚', wav: undefined, concurrency: 1, wantAudio: false, wantProgress: [[1, 4], [4, 4]] },
    { name: '音声あり・タブ 3 枚', wav: Buffer.from('RIFF'), concurrency: 3, wantAudio: true, wantProgress: [[3, 4], [4, 4]] },
  ];
  for (const { name, wav, concurrency, wantAudio, wantProgress } of cases) {
    const { browser, ffmpeg, progress, opts } = setup();
    const got = await exportMp4('/x/page.html', '/x/out.mp4', { ...opts, wav, concurrency });
    assert.deepEqual(got, { frames: 4, duration: 1 }, name);
    assert.equal(browser.tabs, concurrency, name);
    assert.deepEqual(ffmpeg.frames, ['f0', 'f0.25', 'f0.5', 'f0.75'], name);
    assert.deepEqual(progress, wantProgress, name);
    assert.equal(ffmpeg.args?.includes('-shortest'), wantAudio, name);
    assert.equal(ffmpeg.args?.at(-1), '/x/out.mp4', name);
    assert.equal(ffmpeg.killed, null, name);
    assert.equal(browser.stopped, true, name);
    assert.equal(existsSync(dirname(String(browser.profileDir))), false, `${name}: 一時ディレクトリ`);
  }
});

test('exportMp4: 途中で失敗したら ExportError にし、ffmpeg とブラウザを止める', async () => {
  const cases = [
    { name: 'スクリプトのエラー', browser: fakeBrowser({ failAt: 0.5 }), ffmpeg: fakeFfmpeg(), wantErr: /スクリプトでエラー.*boom/, wantKilled: 'SIGKILL' },
    { name: 'ffmpeg の異常終了', browser: fakeBrowser(), ffmpeg: fakeFfmpeg({ exitCode: 1, stderr: 'bad codec' }), wantErr: /ffmpeg が失敗しました（1）：bad codec/, wantKilled: 'SIGKILL' },
  ];
  for (const { name, browser, ffmpeg, wantErr, wantKilled } of cases) {
    const { opts } = setup({ browser, ffmpeg });
    await assert.rejects(exportMp4('/x/page.html', '/x/out.mp4', opts), (e) => e instanceof ExportError && wantErr.test(e.message), name);
    assert.equal(ffmpeg.killed, wantKilled, name);
    assert.equal(browser.stopped, true, name);
    assert.equal(existsSync(dirname(String(browser.profileDir))), false, `${name}: 一時ディレクトリ`);
  }
});

test('exportMp4: ffmpeg か Chrome がなければ、ブラウザを起動せずに ExportError', async () => {
  const cases = [
    { name: 'ffmpeg なし', has: () => false, find: () => '/chrome', wantErr: /ffmpeg が必要/ },
    { name: 'Chrome なし', has: () => true, find: () => null, wantErr: /Chrome \/ Chromium \/ Edge が見つかりません/ },
  ];
  for (const { name, has, find, wantErr } of cases) {
    const { browser, opts } = setup({ has, find });
    await assert.rejects(exportMp4('/x/page.html', '/x/out.mp4', opts), wantErr, name);
    assert.equal(browser.profileDir, null, name);
  }
});

// Stands in for WebSocket: records sent requests and lets the test fire events.
class FakeSocket extends EventTarget implements CdpSocket {
  static last: FakeSocket | null = null;
  url: string;
  sent: unknown[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
    setImmediate(() => this.dispatchEvent(new Event('open')));
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

function lastSocket(): FakeSocket {
  if (!FakeSocket.last) throw new Error('no socket');
  return FakeSocket.last;
}

test('connect: 応答を id で対応づけ、イベントを 1 回だけ待つ', async () => {
  const cdp = await connect('ws://x', { WebSocketImpl: FakeSocket });
  const ws = lastSocket();
  const res = cdp.send('Page.enable', {}, 's1');
  const ev = cdp.once('Page.loadEventFired');
  assert.deepEqual(ws.sent, [{ id: 1, method: 'Page.enable', params: {}, sessionId: 's1' }]);
  ws.reply({ id: 1, result: { ok: true } });
  ws.reply({ method: 'Page.loadEventFired', params: { t: 1 } });
  assert.deepEqual(await res, { ok: true });
  assert.deepEqual(await ev, { t: 1 });

  // The same event is awaited separately per session.
  const s1 = cdp.once('Page.loadEventFired', 's1');
  const s2 = cdp.once('Page.loadEventFired', 's2');
  ws.reply({ method: 'Page.loadEventFired', sessionId: 's2', params: { tab: 2 } });
  ws.reply({ method: 'Page.loadEventFired', sessionId: 's1', params: { tab: 1 } });
  assert.deepEqual(await Promise.all([s1, s2]), [{ tab: 1 }, { tab: 2 }]);

  const bad = cdp.send('X.y');
  ws.reply({ id: 2, error: { message: 'no such method' } });
  await assert.rejects(bad, /CDP no such method/);
});

test('connect: 接続が切れたら、待っている要求とイベントを失敗させ、以後の要求もすぐ失敗させる', async () => {
  const cdp = await connect('ws://x', { WebSocketImpl: FakeSocket });
  const res = cdp.send('Runtime.evaluate');
  const ev = cdp.once('Page.loadEventFired');
  lastSocket().close();
  await assert.rejects(res, /接続が切れました/);
  await assert.rejects(ev, /接続が切れました/);
  await assert.rejects(cdp.send('Page.enable'), /接続が切れました/);
});
