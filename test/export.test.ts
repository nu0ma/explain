import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportMp4, changedFrames, chromeArgs, connect, guardBrowserNetwork, openPage, ExportError } from '../src/video/export.ts';
import type { CdpClient, CdpParams, CdpSocket, ExportDeps } from '../src/video/export.ts';
import type { NetworkOptions } from '../src/network.ts';

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
// Drawing the failAt time returns a script error. Screenshots in the slowTab session take 20 ms.
function fakeBrowser({ duration = 1, fps = 4, failAt = -1, keyframes = undefined as [number, number][] | undefined, slowTab = '' } = {}) {
  let targets = 0;
  const drawn = new Map<string | undefined, number>();
  const browser = {
    stopped: false,
    profileDir: null as string | null,
    networkOptions: undefined as NetworkOptions | undefined,
    calls: [] as { method: string; params: CdpParams; sessionId?: string }[],
    tabs: 0,
    shots: 0,
    cdp: {
      async send(method: string, params: CdpParams = {}, sessionId?: string): Promise<unknown> {
        browser.calls.push({ method, params, sessionId });
        if (method === 'Target.createTarget') return { targetId: `t${++targets}` };
        if (method === 'Target.attachToTarget') { browser.tabs++; return { sessionId: `s-${String(params.targetId)}` }; }
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression);
          if (expression.startsWith('document.fonts')) return { result: { value: { duration, fps, keyframes } } };
          const t = Number(/^render\((.+)\)$/.exec(expression)?.[1]);
          if (t === failAt) return { exceptionDetails: { text: 'boom' } };
          drawn.set(sessionId, t);
          return { result: {} };
        }
        if (method === 'Page.captureScreenshot') {
          browser.shots++;
          if (sessionId === slowTab) await new Promise((r) => setTimeout(r, 20));
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
    launch: async (_path, profileDir, networkOptions) => { browser.profileDir = profileDir; browser.networkOptions = networkOptions; return browser; },
    encoder: (args) => { ffmpeg.args = args; return ffmpeg; },
  };
  return { browser, ffmpeg, progress, opts: { deps, onProgress: (i: number, n: number) => progress.push([i, n]) } };
}

test('exportMp4: 全フレームを順に ffmpeg に渡し、ブラウザを止めて一時ディレクトリを消す', async () => {
  const cases = [
    { name: '音声なし・タブ 1 枚', wav: undefined, concurrency: 1, wantAudio: false, wantProgress: [[1, 4], [4, 4]] },
    { name: '音声あり・タブ 3 枚', wav: Buffer.from('RIFF'), concurrency: 3, wantAudio: true, wantProgress: [[1, 4], [4, 4]] },
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

test('changedFrames: 変化する範囲に触れるフレームと、範囲が終わった直後のフレームだけを撮る', () => {
  const cases: { name: string; req: [number, number][] | undefined; want: number[] }[] = [
    { name: '範囲がわからない', req: undefined, want: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { name: '変化しない', req: [], want: [0] },
    { name: '途中で動く', req: [[0.25, 0.42]], want: [0, 3, 4, 5] },
    { name: '一瞬で変わる', req: [[0.42, 0.42]], want: [0, 5] },
    { name: '範囲が重なる', req: [[0.12, 0.18], [0.15, 0.22], [0.85, 2]], want: [0, 2, 3, 9] },
  ];
  for (const { name, req, want } of cases) assert.deepEqual(changedFrames(req, 10, 10), want, name);
});

test('exportMp4: 変化しないフレームは撮らず、前のフレームの画像を送り直す', async () => {
  const { browser, ffmpeg, opts } = setup({ browser: fakeBrowser({ keyframes: [[0.4, 0.4]] }) });
  const got = await exportMp4('/x/page.html', '/x/out.mp4', { ...opts, concurrency: 2 });
  assert.deepEqual(got, { frames: 4, duration: 1 });
  assert.equal(browser.shots, 2);
  assert.deepEqual(ffmpeg.frames, ['f0', 'f0', 'f0.5', 'f0.5']);
});

test('exportMp4: 遅いタブがあっても空いたタブが次のフレームを撮り、フレームの順に ffmpeg に渡す', async () => {
  const { ffmpeg, opts } = setup({ browser: fakeBrowser({ duration: 2, slowTab: 's-t1' }) });
  await exportMp4('/x/page.html', '/x/out.mp4', { ...opts, concurrency: 2 });
  assert.deepEqual(ffmpeg.frames, ['f0', 'f0.25', 'f0.5', 'f0.75', 'f1', 'f1.25', 'f1.5', 'f1.75']);
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

test('openPage blocks network before author content and supports explicit opt-in', async () => {
  for (const allowNetwork of [false, true]) {
    const browser = fakeBrowser();
    await openPage(browser.cdp, '/tmp/author page.html', { allowNetwork });
    const calls = browser.calls;
    const navigate = calls.findIndex((c) => c.method === 'Page.navigate');
    const blocks = calls.filter((c) => c.method.startsWith('Network.'));
    if (allowNetwork) {
      assert.deepEqual(blocks, []);
    } else {
      assert.deepEqual(blocks.map((c) => c.method), ['Network.enable', 'Network.setBlockedURLs', 'Network.emulateNetworkConditions']);
      assert.deepEqual(blocks[1].params, { urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*'] });
      assert.equal(blocks[2].params.offline, true);
      assert.ok(blocks.every((c) => calls.indexOf(c) < navigate && c.sessionId === 's-t1'));
    }
  }
});

test('Chrome export arguments disable extension background targets without disabling sandboxing', () => {
  const args = chromeArgs('/tmp/private export profile');
  assert.ok(args.includes('--disable-extensions'));
  assert.ok(args.includes('--disable-component-extensions-with-background-pages'));
  assert.ok(args.includes('--disable-background-networking'));
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--user-data-dir=/tmp/private export profile'));
  assert.equal(args.at(-1), 'about:blank');
  assert.ok(!args.some((arg) => /--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|remote-debugging-port)/.test(arg)));
});

test('exportMp4 passes network opt-in to browser launch and every tab', async () => {
  for (const allowNetwork of [false, true]) {
    const { browser, opts } = setup();
    await exportMp4('/tmp/page.html', '/tmp/video.mp4', { ...opts, concurrency: 2, browsers: 1, allowNetwork });
    assert.deepEqual(browser.networkOptions, { allowNetwork });
    assert.equal(browser.calls.filter((c) => c.method === 'Network.setBlockedURLs').length, allowNetwork ? 0 : 2);
  }
});

function fakeGuardClient({ failAt = '', attachOnStart = false } = {}) {
  const calls: { method: string; params: CdpParams; sessionId?: string }[] = [];
  const listeners = new Set<(params: unknown, sessionId?: string) => void>();
  const emit = (sessionId: string, parentSessionId?: string, type = 'page', url?: string) => {
    for (const listener of listeners) listener({ sessionId, targetInfo: { type, url }, waitingForDebugger: true }, parentSessionId);
  };
  const cdp: CdpClient = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === failAt) throw new Error('security setup failed');
      if (attachOnStart && method === 'Target.setAutoAttach' && !sessionId) emit('existing');
      return {};
    },
    on(method, listener) {
      assert.equal(method, 'Target.attachedToTarget');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    once: async () => ({}),
    close: () => {},
  };
  return { cdp, calls, listeners, emit };
}

test('guardBrowserNetwork protects existing targets, popups and nested targets before resuming', async () => {
  const { cdp, calls, listeners, emit } = fakeGuardClient({ attachOnStart: true });
  const failures: Error[] = [];
  const dispose = await guardBrowserNetwork(cdp, (e) => failures.push(e));
  emit('popup');
  emit('frame', 'popup', 'iframe');
  emit('popup'); // Repeated attachment events do not resume a target twice.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[0], { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId: undefined });
  for (const id of ['existing', 'popup', 'frame']) {
    assert.deepEqual(calls.filter((c) => c.sessionId === id).map((c) => c.method), [
      'Network.enable', 'Network.setBlockedURLs', 'Network.emulateNetworkConditions',
      'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger',
    ]);
  }
  assert.deepEqual(failures, []);
  dispose();
  assert.equal(listeners.size, 0);
  const length = calls.length;
  emit('after-dispose');
  assert.equal(calls.length, length);
});

test('guardBrowserNetwork rejects worker and worklet targets without running them', async () => {
  for (const type of ['worker', 'shared_worker', 'service_worker', 'worklet', 'auction_worklet', 'shared_storage_worklet']) {
    const { cdp, calls, listeners, emit } = fakeGuardClient();
    const failures: Error[] = [];
    await guardBrowserNetwork(cdp, (e) => failures.push(e));
    emit('blocked', 'parent', type);
    await new Promise((r) => setImmediate(r));
    assert.equal(failures.length, 1, type);
    assert.ok(failures[0] instanceof ExportError);
    assert.match(failures[0].message, /Worker \/ Worklet を使えません/);
    assert.equal(listeners.size, 0);
    assert.deepEqual(calls.map((c) => c.method), ['Target.setAutoAttach']);
    assert.ok(!calls.some((c) => c.method === 'Runtime.runIfWaitingForDebugger'));
  }
});

test('worker rejection identifies the target kind and scheme without disclosing URLs or source', async () => {
  for (const [type, url, scheme] of [
    ['service_worker', 'chrome-extension://private-extension-id/background.js', 'chrome-extension:'],
    ['worker', 'blob:https://secret.example/private-source', 'blob:'],
    ['worker', 'data:text/javascript,SECRET', 'data:'],
    ['worker', 'file:///private/SECRET.js', 'file:'],
    ['worker', 'SECRET invalid URL', 'unknown'],
  ]) {
    const { cdp, calls, emit } = fakeGuardClient();
    const failures: Error[] = [];
    await guardBrowserNetwork(cdp, (e) => failures.push(e));
    emit('blocked', 'parent', type, url);
    await new Promise((r) => setImmediate(r));
    assert.equal(failures.length, 1);
    assert.ok(failures[0].message.includes(`type=${type}, scheme=${scheme}`));
    assert.ok(!failures[0].message.includes(url));
    assert.doesNotMatch(failures[0].message, /SECRET|private-extension-id|secret\.example/);
    assert.deepEqual(calls.map((c) => c.method), ['Target.setAutoAttach']);
  }
});

test('guardBrowserNetwork fails closed when any security command fails', async () => {
  for (const failAt of ['Network.enable', 'Network.setBlockedURLs', 'Network.emulateNetworkConditions']) {
    const { cdp, calls, listeners, emit } = fakeGuardClient({ failAt });
    const failures: Error[] = [];
    await guardBrowserNetwork(cdp, (e) => failures.push(e));
    emit('popup');
    await new Promise((r) => setImmediate(r));
    assert.equal(failures.length, 1, failAt);
    assert.match(failures[0].message, /security setup failed/);
    assert.equal(listeners.size, 0);
    assert.ok(!calls.some((c) => c.method === 'Runtime.runIfWaitingForDebugger'));
  }
});

test('guardBrowserNetwork requires events and cleans up when initial auto-attach fails', async () => {
  await assert.rejects(guardBrowserNetwork(fakeBrowser().cdp, () => {}), /CDP events are unavailable/);
  const { cdp, listeners } = fakeGuardClient({ failAt: 'Target.setAutoAttach' });
  await assert.rejects(guardBrowserNetwork(cdp, () => {}), /security setup failed/);
  assert.equal(listeners.size, 0);
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
  const cdp = await connect(new FakeSocket('x'));
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
  await assert.rejects(bad, /CDP X.y: no such method/);
});

test('connect supports persistent events across sessions alongside one-shot waits', async () => {
  const cdp = await connect(new FakeSocket('x'));
  const events: unknown[] = [];
  assert.ok(cdp.on);
  const off = cdp.on('Target.attachedToTarget', (params, sessionId) => events.push({ params, sessionId }));
  const one = cdp.once('Target.attachedToTarget', 'parent');
  lastSocket().reply({ method: 'Target.attachedToTarget', params: { sessionId: 'popup' } });
  lastSocket().reply({ method: 'Target.attachedToTarget', params: { sessionId: 'child' }, sessionId: 'parent' });
  assert.deepEqual(await one, { sessionId: 'child' });
  assert.deepEqual(events, [
    { params: { sessionId: 'popup' }, sessionId: undefined },
    { params: { sessionId: 'child' }, sessionId: 'parent' },
  ]);
  off();
  lastSocket().reply({ method: 'Target.attachedToTarget', params: { sessionId: 'ignored' } });
  assert.equal(events.length, 2);
  cdp.close();
});

test('connect: 接続が切れたら、待っている要求とイベントを失敗させ、以後の要求もすぐ失敗させる', async () => {
  const cdp = await connect(new FakeSocket('x'));
  const res = cdp.send('Runtime.evaluate');
  const ev = cdp.once('Page.loadEventFired');
  lastSocket().close();
  await assert.rejects(res, /接続が切れました/);
  await assert.rejects(ev, /接続が切れました/);
  await assert.rejects(cdp.send('Page.enable'), /接続が切れました/);
});

test('connect: 応答やイベントが時間内に来なければ失敗させる', async () => {
  const cdp = await connect(new FakeSocket('x'), { timeoutMs: 20 });
  await assert.rejects(cdp.send('Runtime.evaluate'), /Chrome が 0.02 秒以内に応答しません（Runtime.evaluate）/);
  await assert.rejects(cdp.once('Page.loadEventFired'), /Chrome が 0.02 秒以内に応答しません（Page.loadEventFired）/);
});
