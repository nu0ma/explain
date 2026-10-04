// CLI を 1 ファイル dist/explain.mjs にまとめる。
// 生成物は node_modules も src/ も参照しないので、Node があればこのファイル単体で動く。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// src/assets.js をインライン文字列に差し替え、実行時にディスク上のファイルを読まないようにする。
const inlineAssets = {
  name: 'inline-assets',
  setup(b) {
    b.onLoad({ filter: /src[\\/]assets\.js$/ }, () => ({
      loader: 'js',
      contents: [
        `export const VERSION = ${JSON.stringify(JSON.parse(read('../package.json')).version)};`,
        `export const BASE_CSS = ${JSON.stringify(read('../src/themes/base.css'))};`,
        `export const RUNTIME_JS = ${JSON.stringify(read('../src/runtime/page.js'))};`,
        `export const VIDEO_CSS = ${JSON.stringify(read('../src/themes/video.css'))};`,
        `export const VIDEO_JS = ${JSON.stringify(read('../src/runtime/video.js'))};`,
      ].join('\n'),
    }));
  },
};

await build({
  entryPoints: [fileURLToPath(new URL('../bin/explain.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/explain.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'eof',
  banner: { js: '// explain CLI — scripts/build.mjs が生成。直接編集しない。' },
  plugins: [inlineAssets],
  logLevel: 'info',
});
