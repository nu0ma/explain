import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimplified } from './helpers/chinese.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('ソース・テスト・スクリプト・README に簡体字の文が残っていない', () => {
  const targets = ['src', 'bin', 'scripts', 'test'].flatMap((d) => files(join(ROOT, d))).concat(join(ROOT, 'README.md'));
  const found = targets.flatMap((file) => findSimplified(readFileSync(file, 'utf8')).map(({ line, text }) => `${relative(ROOT, file)}:${line}: ${text}`));
  assert.deepEqual(found, []);
});
