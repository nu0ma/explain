// Static resources used at run time. In development they are read from disk. The build (scripts/build.ts)
// replaces this whole module with inline strings, so dist/explain.mjs depends on no external files.
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

export const VERSION: string = JSON.parse(read('../package.json')).version;
export const BASE_CSS = read('./themes/base.css');
export const RUNTIME_JS = read('./runtime/page.js');
export const VIDEO_CSS = read('./themes/video.css');
export const VIDEO_JS = read('./runtime/video.js');
