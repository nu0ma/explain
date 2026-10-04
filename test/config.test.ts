import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, explainHome, readConfig, setConfig, resetConfig, CONFIG_KEYS, ConfigError } from '../src/config.ts';
import { renderDoc } from '../src/render.ts';

const DEFAULTS = { open: true, theme: 'blueprint', mode: 'auto', style: '80', voice: 'say' };

let home;
let env;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'explain-config-'));
  env = { EXPLAIN_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test('explainHome: 既定は ~/.explain-cli。EXPLAIN_HOME で上書きする', () => {
  const cases = [
    { req: {}, want: join(homedir(), '.explain-cli') },
    { req: { EXPLAIN_HOME: '/x/y' }, want: '/x/y' },
  ];
  for (const { req, want } of cases) assert.equal(explainHome(req), want, JSON.stringify(req));
  assert.equal(configPath(env), join(home, 'config.json'));
});

test('readConfig: ファイルがなければ既定値。always はない', () => {
  assert.deepEqual(readConfig(env).values, DEFAULTS);
  assert.equal('always' in CONFIG_KEYS, false);
});

test('setConfig: 真偽値は on/off/true/false/オン/オフ を受け付け、ファイルに書く', () => {
  setConfig('open', 'off', env);
  assert.equal(readConfig(env).values.open, false);
  setConfig('open', 'オン', env);
  assert.equal(readConfig(env).values.open, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath(env), 'utf8')), { open: true });
});

test('setConfig: 列挙値を検証し、不正な値には選択肢を示す', () => {
  setConfig('theme', 'shadcn', env);
  assert.equal(readConfig(env).values.theme, 'shadcn');
  assert.throws(() => setConfig('theme', 'neon', env), (e) => e instanceof ConfigError && /blueprint \| shadcn/.test(e.message));
  assert.throws(() => setConfig('nope', '1', env), (e) => e instanceof ConfigError && /open/.test(e.message));
  assert.throws(() => setConfig('always', 'on', env), ConfigError);
  assert.throws(() => setConfig('open', 'maybe', env), ConfigError);
});

test('resetConfig: 1 項目、またはすべてを既定値に戻す', () => {
  setConfig('open', 'off', env);
  setConfig('theme', 'shadcn', env);
  resetConfig('open', env);
  assert.deepEqual(readConfig(env).values, { ...DEFAULTS, theme: 'shadcn' });
  resetConfig(undefined, env);
  assert.equal(existsSync(configPath(env)), false);
});

test('readConfig: ファイルが壊れていれば既定値に戻し、警告を返す', () => {
  writeFileSync(configPath(env), '{ not json');
  const { values, warning } = readConfig(env);
  assert.equal(values.open, true);
  assert.match(warning, /config\.json を読めないため/);
});

test('readConfig: 知らないキーと不正な値は無視する（古い always も無視）', () => {
  writeFileSync(configPath(env), JSON.stringify({ open: 'yes-ish', theme: 'shadcn', always: false, extra: 1 }));
  assert.deepEqual(readConfig(env).values, { ...DEFAULTS, theme: 'shadcn' });
});

test('CONFIG_KEYS: すべての項目に説明がある', () => {
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) assert.ok(spec.label, key);
});

test('render: 設定は既定値として使い、frontmatter とコマンドラインの指定を優先する', () => {
  const defaults = { theme: 'shadcn', mode: 'dark', style: 'off' };
  const plain = renderDoc('## A\n確認を行う。', {}, defaults);
  assert.match(plain.html, /data-theme="shadcn" data-mode="dark"/);
  assert.equal(plain.warnings.length, 0, '設定の style: off が効く');
  const explicit = renderDoc('---\ntheme: blueprint\n---\n## A\nx', {}, defaults);
  assert.match(explicit.html, /data-theme="blueprint"/);
  const flag = renderDoc('---\ntheme: blueprint\n---\n## A\nx', { theme: 'shadcn' }, defaults);
  assert.match(flag.html, /data-theme="shadcn"/, 'コマンドラインの引数が最優先');
});
