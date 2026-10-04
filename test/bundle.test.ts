import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG: { version: string } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Build dist/explain.mjs with pnpm run build and check that it still runs when copied alone to another place.
test('bundle: dist/explain.mjs は単体で動く', () => {
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts/build.ts')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(build.status, 0, build.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'explain-bundle-'));
  try {
    const cli = join(dir, 'explain.mjs');
    copyFileSync(join(ROOT, 'dist/explain.mjs'), cli);
    const env = { ...process.env, EXPLAIN_NO_OPEN: '1', EXPLAIN_HOME: join(dir, 'home') };

    const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env });
    assert.equal(version.stdout.trim(), PKG.version);

    const src = '---\ntitle: ビルドのテスト\n---\n## A\n```flow\nA -> B\n```\n';
    const cases = [
      { name: 'ふつう', req: [], want: /<script>/ },
      { name: '静的', req: ['--static'], want: /^(?![\s\S]*<script)/ },
    ];
    for (const { name, req, want } of cases) {
      const out = join(dir, `${name}.html`);
      const r = spawnSync(process.execPath, [cli, 'render', '-', '-o', out, ...req], { input: src, encoding: 'utf8', env, cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      const html = readFileSync(out, 'utf8');
      assert.match(html, /<h1>ビルドのテスト<\/h1>/, name);
      assert.match(html, /class="am-node /, name);
      assert.match(html, /--font-mono/, `${name}: CSS をインライン化している`);
      assert.match(html, want, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
