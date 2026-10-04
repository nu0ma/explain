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

test('e2e 動画：幅の広い flow は画面に収まり、表の行の強調はセルごとに枠を描かない', {
  skip: !(process.env.EXPLAIN_E2E === '1' && chrome), timeout: 60000,
}, async () => {
  assert.ok(chrome);
  const dir = mkdtempSync(join(tmpdir(), 'explain-fit-video-'));
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    browser = await launchChrome(chrome, join(dir, 'profile'));
    const source = [
      '## 広い図', '```flow LR',
      '@a[ブラウザ] -> @b[OSのスタブリゾルバ]: 名前を尋ねる', 'b -> {OSにキャッシュがある?}',
      'OSにキャッシュがある? -> @c[フルリゾルバ]: なければ問い合わせる', 'c -> {リゾルバにキャッシュがある?}',
      '```', '> 最後まで出します。',
      '## 表', '| 場所 | 期間 |', '|---|---|', '| フルリゾルバ | TTLまで |', '| OS | TTLまで |', '> [フルリゾルバ]が先に覚えます。', '',
    ].join('\n');
    const { html } = await renderVideo(source);
    const file = join(dir, 'video.html');
    writeFileSync(file, html);
    const page = await openPage(browser.cdp, file);
    await page.evaluate('window.__amv.exportMode()');
    const result = await page.evaluate(`(() => {
      const data = JSON.parse(document.querySelector('#amv-data').textContent);
      const stage = document.querySelector('.amv-stage').getBoundingClientRect();
      const k = stage.width / 1920;
      const scenes = [...document.querySelectorAll('.amv-scene')];
      window.render(data.segments[1].start + data.segments[1].duration - 0.1);
      const svg = scenes[1].querySelector('svg').getBoundingClientRect();
      window.render(data.segments[2].start + 1.5);
      const row = scenes[2].querySelector('tr.amv-hl');
      return {
        left: (svg.left - stage.left) / k >= 0,
        right: (svg.right - stage.left) / k <= 1920,
        row: row?.textContent.trim().slice(0, 6),
        outlines: row ? [...row.cells].map((td) => getComputedStyle(td).outlineStyle) : [],
      };
    })()`);
    assert.deepEqual(result, { left: true, right: true, row: 'フルリゾルバ', outlines: ['none', 'none'] });
  } finally {
    await browser?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
