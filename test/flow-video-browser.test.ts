import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderVideo } from '../src/video/render.ts';
import { findChrome, launchChrome, openPage } from '../src/video/export.ts';

const chrome = findChrome();

test('e2e flow: renamed nodes morph by ID and survive repeated forward/backward seeks', {
  skip: !(process.env.EXPLAIN_E2E === '1' && chrome), timeout: 60000,
}, async () => {
  assert.ok(chrome);
  const dir = mkdtempSync(join(tmpdir(), 'explain-flow-video-'));
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    browser = await launchChrome(chrome, join(dir, 'profile'));
    const source = '## Before\n```flow LR\n@api[Old API] -> @API[Old API]\n```\n> [api] sends.\n## After\n```flow LR\n@api[New API] -> @API[New API]\n```\n> [API] sends again.\n';
    const { html } = await renderVideo(source);
    const file = join(dir, 'video.html');
    writeFileSync(file, html);
    const page = await openPage(browser.cdp, file);
    await page.evaluate('window.__amv.exportMode()');
    const result = await page.evaluate(`(() => {
      const data = JSON.parse(document.querySelector('#amv-data').textContent);
      const start = data.segments[2].start;
      const scenes = [...document.querySelectorAll('.amv-scene')];
      const state = (time) => {
        window.render(time);
        return {
          ghosts: [...document.querySelectorAll('.amv-ghost')].filter(el => el.style.display !== 'none').length,
          labels: [...scenes[2].querySelectorAll('.am-node')].map(el => el.textContent),
          visible: [...scenes[2].querySelectorAll('.am-node')].map(el => el.style.visibility !== 'hidden'),
        };
      };
      state(data.segments[1].start + 1);
      const beforeFocus = [...scenes[1].querySelectorAll('.amv-hl')].map(el => el.dataset.key);
      return {
        beforeFocus,
        keys: scenes.slice(1).map(scene => [...scene.querySelectorAll('.am-node')].map(el => el.dataset.key)),
        during: state(start + 0.45),
        after: state(start + 1),
        rewind: state(start + 0.45),
        replay: state(start + 1),
        focus: [...scenes[2].querySelectorAll('.amv-hl')].map(el => el.dataset.key),
      };
    })()`);
    assert.deepEqual(result, {
      beforeFocus: ['api'],
      keys: [['api', 'API'], ['api', 'API']],
      during: { ghosts: 2, labels: ['New API', 'New API'], visible: [false, false] },
      after: { ghosts: 0, labels: ['New API', 'New API'], visible: [true, true] },
      rewind: { ghosts: 2, labels: ['New API', 'New API'], visible: [false, false] },
      replay: { ghosts: 0, labels: ['New API', 'New API'], visible: [true, true] },
      focus: ['API'],
    });
  } finally {
    await browser?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
