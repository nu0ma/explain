import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportMp4, connect, ExportError } from '../src/video/export.js';

// ffmpeg の代わり：標準入力に書かれたフレームを数え、入力が閉じたら exitCode で終わる。
function fakeFfmpeg({ exitCode = 0, stderr = '' } = {}) {
  const proc = new EventEmitter();
  proc.args = null;
  proc.frames = 0;
  proc.killed = null;
  proc.stderr = new EventEmitter();
  proc.stdin = new Writable({
    write(_chunk, _enc, cb) { proc.frames++; cb(); },
    final(cb) {
      cb();
      setImmediate(() => {
        if (stderr) proc.stderr.emit('data', stderr);
        proc.emit('close', exitCode);
      });
    },
  });
  proc.kill = (sig) => { proc.killed = sig; };
  return proc;
}

// Chrome の代わり：再生ページの情報を返し、failAt 番目のフレームでスクリプトのエラーを返す。
function fakeBrowser({ duration = 1, fps = 4, failAt = -1 } = {}) {
  let frame = -1;
  const browser = { stopped: false, profileDir: null };
  browser.cdp = {
    async send(method, params) {
      if (method === 'Target.createTarget') return { targetId: 't' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      if (method === 'Runtime.evaluate') {
        if (params.expression.startsWith('document.fonts')) return { result: { value: { duration, fps } } };
        frame++;
        if (frame === failAt) return { exceptionDetails: { text: 'boom' } };
        return { result: {} };
      }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('jpg').toString('base64') };
      return {};
    },
    once: async () => ({}),
  };
  browser.stop = async () => { browser.stopped = true; };
  return browser;
}

function setup({ browser = fakeBrowser(), ffmpeg = fakeFfmpeg(), has = () => true, find = () => '/chrome' } = {}) {
  const progress = [];
  const deps = {
    has,
    find,
    launch: async (_path, profileDir) => { browser.profileDir = profileDir; return browser; },
    encoder: (args) => { ffmpeg.args = args; return ffmpeg; },
  };
  return { browser, ffmpeg, progress, opts: { deps, onProgress: (i, n) => progress.push([i, n]) } };
}

test('exportMp4: 全フレームを ffmpeg に渡し、ブラウザを止めて一時ディレクトリを消す', async () => {
  const cases = [
    { name: '音声なし', wav: undefined, wantAudio: false },
    { name: '音声あり', wav: Buffer.from('RIFF'), wantAudio: true },
  ];
  for (const { name, wav, wantAudio } of cases) {
    const { browser, ffmpeg, progress, opts } = setup();
    const got = await exportMp4('/x/page.html', '/x/out.mp4', { ...opts, wav });
    assert.deepEqual(got, { frames: 4, duration: 1 }, name);
    assert.equal(ffmpeg.frames, 4, name);
    assert.deepEqual(progress, [[1, 4], [4, 4]], name);
    assert.equal(ffmpeg.args.includes('-shortest'), wantAudio, name);
    assert.equal(ffmpeg.args.at(-1), '/x/out.mp4', name);
    assert.equal(ffmpeg.killed, null, name);
    assert.equal(browser.stopped, true, name);
    assert.equal(existsSync(dirname(browser.profileDir)), false, `${name}: 一時ディレクトリ`);
  }
});

test('exportMp4: 途中で失敗したら ExportError にし、ffmpeg とブラウザを止める', async () => {
  const cases = [
    { name: 'スクリプトのエラー', browser: fakeBrowser({ failAt: 2 }), ffmpeg: fakeFfmpeg(), wantErr: /スクリプトでエラー.*boom/, wantKilled: 'SIGKILL' },
    { name: 'ffmpeg の異常終了', browser: fakeBrowser(), ffmpeg: fakeFfmpeg({ exitCode: 1, stderr: 'bad codec' }), wantErr: /ffmpeg が失敗しました（1）：bad codec/, wantKilled: 'SIGKILL' },
  ];
  for (const { name, browser, ffmpeg, wantErr, wantKilled } of cases) {
    const { opts } = setup({ browser, ffmpeg });
    await assert.rejects(exportMp4('/x/page.html', '/x/out.mp4', opts), (e) => e instanceof ExportError && wantErr.test(e.message), name);
    assert.equal(ffmpeg.killed, wantKilled, name);
    assert.equal(browser.stopped, true, name);
    assert.equal(existsSync(dirname(browser.profileDir)), false, `${name}: 一時ディレクトリ`);
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

// WebSocket の代わり：送った要求を記録し、テストからイベントを起こせる。
class FakeSocket extends EventTarget {
  static last = null;
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeSocket.last = this;
    setImmediate(() => this.dispatchEvent(new Event('open')));
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

test('connect: 応答を id で対応づけ、イベントを 1 回だけ待つ', async () => {
  const cdp = await connect('ws://x', { WebSocketImpl: FakeSocket });
  const ws = FakeSocket.last;
  const res = cdp.send('Page.enable', {}, 's1');
  const ev = cdp.once('Page.loadEventFired');
  assert.deepEqual(ws.sent, [{ id: 1, method: 'Page.enable', params: {}, sessionId: 's1' }]);
  ws.reply({ id: 1, result: { ok: true } });
  ws.reply({ method: 'Page.loadEventFired', params: { t: 1 } });
  assert.deepEqual(await res, { ok: true });
  assert.deepEqual(await ev, { t: 1 });

  const bad = cdp.send('X.y');
  ws.reply({ id: 2, error: { message: 'no such method' } });
  await assert.rejects(bad, /CDP no such method/);
});

test('connect: 接続が切れたら、待っている要求とイベントを失敗させ、以後の要求もすぐ失敗させる', async () => {
  const cdp = await connect('ws://x', { WebSocketImpl: FakeSocket });
  const res = cdp.send('Runtime.evaluate');
  const ev = cdp.once('Page.loadEventFired');
  FakeSocket.last.close();
  await assert.rejects(res, /接続が切れました/);
  await assert.rejects(ev, /接続が切れました/);
  await assert.rejects(cdp.send('Page.enable'), /接続が切れました/);
});
