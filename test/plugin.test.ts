import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

// Without a manifest or entry version, Claude Code keys the cache by the pinned source commit.
test('plugin: names agree and the skill uses the bundled CLI', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, pkg.name);
  assert.deepEqual(market.plugins.map((p: { name: string }) => p.name), [plugin.name]);

  const skill = readFileSync(join(ROOT, 'skills/explain/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: explain\n/);
  assert.match(skill, /node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/explain\.mjs"/);
  assert.ok(existsSync(join(ROOT, 'skills/explain/scripts/explain.mjs')));
});

test('plugin: the release source is an immutable GitHub commit, not the marketplace checkout', () => {
  const market = json('.claude-plugin/marketplace.json');
  const source = market.plugins[0].source;
  assert.equal(typeof source, 'object');
  assert.deepEqual(Object.keys(source).sort(), ['repo', 'sha', 'source']);
  assert.equal(source.source, 'github');
  assert.equal(source.repo, 'nu0ma/explain');
  assert.match(source.sha, /^[0-9a-f]{40}$/);
  assert.notEqual(source.sha, '0'.repeat(40));
});

test('plugin: explicit versions cannot mask a changed release pin', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal('version' in plugin, false);
  assert.equal('version' in market.plugins[0], false);
});
