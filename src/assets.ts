// 実行時に使う静的リソースをここに集める。開発時はディスクから読む。ビルド（scripts/build.ts）時は
// このモジュールごとインライン文字列に差し替わるので、dist/explain.mjs は外部ファイルに依存しない。
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

export const VERSION = JSON.parse(read('../package.json')).version;
export const BASE_CSS = read('./themes/base.css');
export const RUNTIME_JS = read('./runtime/page.js');
export const VIDEO_CSS = read('./themes/video.css');
export const VIDEO_JS = read('./runtime/video.js');
