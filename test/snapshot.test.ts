import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDoc } from '../src/render.ts';
import { snapshot } from '../src/snapshot.ts';
import { findChrome } from '../src/video/export.ts';

const E2E = process.env.EXPLAIN_E2E === '1';

test('e2e snapshot: はみ出し、図の外の文字、重なった文字を見つけ、ページ全体の PNG を保存する', { skip: !(E2E && findChrome()), timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-snap-'));
  try {
    const src = '---\ntitle: 崩れた図\n---\n## A 重なり\n```svg\n<svg viewBox="0 0 200 60"><text x="10" y="30">注文API</text><text x="20" y="32">在庫サービス</text><text x="170" y="50">はみ出す文字</text></svg>\n```\n\n## B 幅\n```html\n<div style="width: 3000px">広い要素</div>\n```\n\n## C 正常\n```flow LR\nA -> B: 送る\n```\n';
    const html = join(dir, 'page.html');
    const png = join(dir, 'page.png');
    writeFileSync(html, renderDoc(src).html);
    const { issues } = await snapshot(html, png);
    assert.deepEqual(issues.map((i) => [i.kind, i.panel]).sort(), [['clipped', 'A'], ['overflow', 'B'], ['overlap', 'A']]);
    assert.equal(readFileSync(png).subarray(1, 4).toString(), 'PNG');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
