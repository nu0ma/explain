import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

// plugin.json has no version on purpose: Claude Code then tracks the install by commit, so every push to main reaches users.
test('plugin: 版を書かず、名前が package.json とマーケットプレイスにそろい、スキルが同梱の CLI を指す', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal('version' in plugin, false);
  assert.equal(plugin.name, pkg.name);
  assert.deepEqual(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [[plugin.name, './']]);

  const skill = readFileSync(join(ROOT, 'skills/explain/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: explain\n/);
  assert.match(skill, /node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/explain\.mjs"/);
  assert.ok(existsSync(join(ROOT, 'skills/explain/scripts/explain.mjs')));
});
