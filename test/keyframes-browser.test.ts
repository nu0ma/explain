import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderVideo } from '../src/video/render.ts';
import { changedFrames, findChrome, launchChrome, openPage } from '../src/video/export.ts';
import type { Browser } from '../src/video/export.ts';

const chrome = findChrome();
const DEMO = new URL('../docs/demo/transactional-outbox.video.md', import.meta.url);

// The MP4 export skips screenshots outside window.__amv.keyframes(). This test takes a screenshot of every frame
// of the demo and checks that each frame that differs from the one before it is among the predicted frames,
// so a new animation in render(t) that is missing from keyframes() fails here instead of freezing in the video.
test('e2e keyframes: デモの全フレームを撮り、前と変わったフレームはすべて撮る対象に入っている', {
  skip: !(process.env.EXPLAIN_E2E === '1' && chrome), timeout: 300000,
}, async () => {
  assert.ok(chrome);
  const dir = mkdtempSync(join(tmpdir(), 'explain-keyframes-'));
  const browsers: Browser[] = [];
  try {
    const { html } = await renderVideo(readFileSync(DEMO, 'utf8'));
    const file = join(dir, 'video.html');
    writeFileSync(file, html);
    const parts = 4;
    for (let i = 0; i < parts; i++) browsers.push(await launchChrome(chrome, join(dir, `profile-${i}`)));
    const pages = await Promise.all(browsers.map((b) => openPage(b.cdp, file)));
    const infos = await Promise.all(pages.map((p) => p.evaluate('document.fonts.ready.then(() => { window.__amv.exportMode(); return { fps: window.__amv.fps, duration: window.__amv.duration, keyframes: window.__amv.keyframes() }; })')));
    const info = infos[0] as { fps: number; duration: number; keyframes: [number, number][] };
    const frames = Math.ceil(info.duration * info.fps);
    const predicted = new Set(changedFrames(info.keyframes, frames, info.fps));

    // Each tab draws a contiguous run of frames in order, starting one frame early to compare against.
    const size = Math.ceil(frames / parts);
    const changed = (await Promise.all(pages.map(async (page, k) => {
      const out: number[] = [];
      let prev = '';
      for (let i = Math.max(0, k * size - 1); i < Math.min(frames, (k + 1) * size); i++) {
        await page.evaluate(`render(${i / info.fps})`);
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
        const hash = createHash('sha1').update(data).digest('hex');
        if (prev && hash !== prev) out.push(i);
        prev = hash;
      }
      return out;
    }))).flat();

    assert.deepEqual(changed.filter((i) => !predicted.has(i)), []);
    assert.ok(changed.length > 0 && predicted.size < frames / 2, `変化 ${changed.length}、撮る ${predicted.size}、全 ${frames} フレーム`);
  } finally {
    await Promise.all(browsers.map((b) => b.stop()));
    rmSync(dir, { recursive: true, force: true });
  }
});
