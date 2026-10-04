// render --png: opens the page in headless Chrome, checks the layout, and saves a full-page screenshot.
// The checks run in the page, so they see the real fonts and the real positions that the flow layout and CSS produced.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, openPage, ExportError } from './video/export.ts';
import type { Browser } from './video/export.ts';

export type LayoutIssue = {
  kind: 'overflow' | 'overlap' | 'clipped';
  // Panel ID ("A", "B"...), or null outside panels.
  panel: string | null;
  message: string;
};

export interface SnapshotDeps {
  find?: (env: NodeJS.ProcessEnv) => string | null;
  launch?: (chromePath: string, profileDir: string) => Promise<Browser>;
}

export interface SnapshotOptions {
  env?: NodeJS.ProcessEnv;
  width?: number;
  deps?: SnapshotDeps;
}

export const PAGE_WIDTH = 1440;
const MAX_HEIGHT = 16000;
const MAX_ISSUES = 30;

// Runs in the page. Returns LayoutIssue[].
// - overflow: the content of a panel is wider than the panel (the panel hides the excess).
// - clipped: text sticks out of its SVG, so part of it is cut off.
// - overlap: two texts in one SVG overlap by more than 20% of the smaller one.
const CHECK = `(() => {
  const issues = [];
  const panelOf = (el) => el.closest('.am-panel')?.id.replace(/^panel-/, '') ?? null;
  const label = (el) => el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 30);
  for (const body of document.querySelectorAll('.am-panel-body')) {
    const over = body.scrollWidth - body.clientWidth;
    if (over > 1) issues.push({ kind: 'overflow', panel: panelOf(body), message: 'パネルの内容が幅を ' + over + 'px はみ出しています' });
  }
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.parentElement.closest('svg')) continue;
    const box = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => r.width > 0 && label(el));
    for (const { el, r } of texts) {
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
        issues.push({ kind: 'clipped', panel: panelOf(svg), message: '文字「' + label(el) + '」が図の外にはみ出しています' });
      }
    }
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].r;
        const b = texts[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w <= 0 || h <= 0) continue;
        if (w * h > 0.2 * Math.min(a.width * a.height, b.width * b.height)) {
          issues.push({ kind: 'overlap', panel: panelOf(svg), message: '文字「' + label(texts[i].el) + '」と「' + label(texts[j].el) + '」が重なっています' });
        }
      }
    }
  }
  return issues;
})()`;

// Checks the layout of htmlFile. With pngFile, also saves a full-page screenshot there.
export async function snapshot(
  htmlFile: string,
  pngFile: string | null,
  { env = process.env, width = PAGE_WIDTH, deps = {} }: SnapshotOptions = {},
): Promise<{ issues: LayoutIssue[]; truncated: number }> {
  const { find = findChrome, launch = launchChrome } = deps;
  const chromePath = find(env);
  if (!chromePath) throw new ExportError('Chrome / Chromium / Edge が見つかりません。環境変数 EXPLAIN_CHROME でブラウザのパスを指定できます');
  const tmp = mkdtempSync(join(tmpdir(), 'explain-snapshot-'));
  let browser: Browser | null = null;
  try {
    browser = await launch(chromePath, join(tmp, 'profile'));
    const page = await openPage(browser.cdp, htmlFile, { width, height: 900 });
    await page.evaluate('document.fonts.ready.then(() => true)');
    // The CHECK expression returns this shape.
    const issues = await page.evaluate(CHECK) as LayoutIssue[];
    if (pngFile) {
      const height = Math.min(MAX_HEIGHT, Math.ceil(Number(await page.evaluate('document.documentElement.scrollHeight'))));
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      // optimizeForSpeed encodes the PNG faster (about 66 ms to 49 ms on the demo page); the file is about a quarter larger.
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      writeFileSync(pngFile, Buffer.from(data, 'base64'));
    }
    return { issues: issues.slice(0, MAX_ISSUES), truncated: Math.max(0, issues.length - MAX_ISSUES) };
  } finally {
    if (browser) await browser.stop();
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Failing to remove the temp directory does not affect the result.
    }
  }
}
