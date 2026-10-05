import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentSecurityPolicy } from '../src/network.ts';
import { renderDoc } from '../src/render.ts';
import { renderVideo } from '../src/video/render.ts';
import { findChrome, launchChrome, openPage } from '../src/video/export.ts';

test('network: generated pages default to inline resources, with caller-only opt-in', async () => {
  const source = '---\nallowNetwork: true\nallow-network: true\nnetwork: true\n---\n## A\n```html\n<script>window.custom = 1</script>\n<svg><circle r="5"/></svg>\n```';
  for (const html of [renderDoc(source).html, (await renderVideo(source + '\n> hello')).html]) {
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'unsafe-inline'/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /img-src data: blob:/);
    assert.match(html, /worker-src 'none'/);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>window.custom'));
    assert.match(html, /<svg><circle/);
  }
  assert.doesNotMatch(renderDoc(source, {}, {}, { allowNetwork: true }).html, /Content-Security-Policy/);
  assert.doesNotMatch((await renderVideo(source + '\n> hello', { allowNetwork: true })).html, /Content-Security-Policy/);
  assert.match(renderDoc('## A\ntext', { static: true }, {}, { allowNetwork: true }).html, /script-src 'none'/);
  assert.match(contentSecurityPolicy(), /form-action 'none'/);
});

const chrome = findChrome();
const e2e = { skip: !(process.env.EXPLAIN_E2E === '1' && chrome), timeout: 60000 };

// The browser must have network access in the first test: otherwise an exporter
// restriction could hide a broken CSP in HTML later opened in an ordinary browser.
test('e2e network: HTML CSP blocks fetch, images, scripts, CSS, and permits inline JS/SVG', e2e, async () => {
  assert.ok(chrome);
  const dir = mkdtempSync(join(tmpdir(), 'explain-csp-'));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/remote.js') res.setHeader('Content-Type', 'text/javascript').end('window.remoteScript = true');
    else if (req.url === '/remote.css') res.setHeader('Content-Type', 'text/css').end('#probe { color: rgb(1, 2, 3) }');
    else if (req.url === '/image.svg') res.setHeader('Content-Type', 'image/svg+xml').end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    else res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    browser = await launchChrome(chrome, join(dir, 'profile'), { allowNetwork: true });
    const source = `## A\n\`\`\`html\n<div id="probe"><svg id="custom" viewBox="0 0 10 10"><circle r="3"/></svg></div>
<link rel="stylesheet" href="${origin}/remote.css">
<style>@import url('${origin}/import.css'); #probe { background-image: url('${origin}/background.svg') }</style>
<img id="remote-image" src="${origin}/image.svg">
<script src="${origin}/remote.js"></script>
<script>window.inlineScript = true; document.querySelector('#custom').dataset.drawn = 'yes'; window.probeDone = fetch('${origin}/fetch').then(() => true, () => false);</script>
\`\`\``;
    for (const allowNetwork of [false, true]) {
      requests.length = 0;
      const file = join(dir, `${allowNetwork}.html`);
      writeFileSync(file, renderDoc(source, {}, {}, { allowNetwork }).html);
      const page = await openPage(browser.cdp, file, { allowNetwork: true });
      const result = await page.evaluate(`(async () => ({ inline: window.inlineScript, svg: document.querySelector('#custom').dataset.drawn, fetch: await window.probeDone, remote: window.remoteScript === true, image: document.querySelector('#remote-image').naturalWidth > 0, css: getComputedStyle(document.querySelector('#probe')).color === 'rgb(1, 2, 3)' }))()`);
      assert.deepEqual(result, { inline: true, svg: 'yes', fetch: allowNetwork, remote: allowNetwork, image: allowNetwork, css: allowNetwork });
      if (allowNetwork) for (const path of ['/fetch', '/remote.js', '/remote.css', '/image.svg', '/import.css', '/background.svg']) assert.ok(requests.includes(path), path);
      else assert.deepEqual(requests, []);
    }
  } finally {
    await browser?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e network: export blocks requests and popups even without a document CSP', e2e, async () => {
  assert.ok(chrome);
  const dir = mkdtempSync(join(tmpdir(), 'explain-export-network-'));
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url ?? ''); res.end('unexpected'); });
  server.on('upgrade', (req, socket) => { requests.push(req.url ?? ''); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    browser = await launchChrome(chrome, join(dir, 'profile'));
    const file = join(dir, 'page.html');
    writeFileSync(file, `<script>window.inlineScript = true; fetch('${origin}/fetch').catch(() => {}); new WebSocket('${origin.replace('http:', 'ws:')}/socket');</script><img src="${origin}/image"><link rel="stylesheet" href="${origin}/style">`);
    const page = await openPage(browser.cdp, file);
    assert.equal(await page.evaluate('window.inlineScript'), true);
    const popup = await page.send('Runtime.evaluate', { expression: `window.open('${origin}/popup') !== null`, userGesture: true, awaitPromise: false, returnByValue: true });
    assert.equal(popup.result.value, true, 'exercise a real new popup target');
    const worker = await page.evaluate(`new Promise(resolve => {
      const code = ${JSON.stringify(`fetch('${origin}/worker').then(() => postMessage('loaded'), () => postMessage('blocked'))`)};
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      worker.onmessage = event => { resolve(event.data); worker.terminate(); };
    })`);
    assert.equal(worker, 'blocked');
    await page.send('Page.navigate', { url: `${origin}/navigation` });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(requests, []);
  } finally {
    await browser?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
