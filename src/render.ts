// Script -> single-file HTML. Pipeline: parse -> STE check -> render panels (Markdown / components / raw) -> apply the template -> inline CSS and runtime.

import { parseDoc, applyOverrides, ParseError } from './parse.ts';
import type { Block, FenceBlock, Meta, MetaValue, ParseDocOptions } from './parse.ts';
import { md } from './markdown.ts';
import { COMPONENTS, RAW_LANGS, ComponentError } from './components/index.ts';
import { TEMPLATES } from './templates/index.ts';
import { pageCss } from './themes/index.ts';
import { lintDoc, blockingWarnings } from './lint/ste.ts';
import type { LintWarning } from './lint/ste.ts';
import { esc } from './svg/text.ts';
import { VERSION, RUNTIME_JS } from './assets.ts';
import { timestamp } from './time.ts';

export type RenderErrorInfo = { line?: number; component?: string; example?: string };

// Per-render counters: panel count and how many times each component was used.
export type RenderStats = { panels: number; components: Record<string, number> };

// Shared across all blocks of one page: seq numbers SVG ids so they stay unique on the page.
export type RenderBlocksContext = { seq: number; stats: RenderStats };

export type RenderOverrides = Readonly<Record<string, MetaValue | undefined>>;

export type RenderResult = {
  html: string;
  warnings: LintWarning[];
  stats: RenderStats;
  meta: Meta;
  static: boolean;
};

export class RenderError extends Error {
  line: number | undefined;
  component: string | undefined;
  example: string | undefined;

  constructor(message: string, { line, component, example }: RenderErrorInfo = {}) {
    super(message);
    this.name = 'RenderError';
    this.line = line;
    this.component = component;
    this.example = example;
  }
}

export class LintError extends Error {
  warnings: LintWarning[];

  constructor(warnings: LintWarning[]) {
    super(`STE 検査で警告が ${warnings.length} 件あります（style: strict）`);
    this.name = 'LintError';
    this.warnings = warnings;
  }
}

type UiLabels = {
  theme: Readonly<Record<string, string>>;
  mode: Readonly<Record<string, string>>;
  copy: string;
  done: string;
};

// Labels for the buttons on the page.
export const UI: Readonly<UiLabels> = Object.freeze({
  theme: { blueprint: 'テーマ：図面', shadcn: 'テーマ：カード' },
  mode: { auto: '配色：システムに合わせる', light: '配色：ライト', dark: '配色：ダーク' },
  copy: '原稿をコピー',
  done: 'コピーしました ✓',
});

// Detects JavaScript that slipped into static output (from html blocks or raw HTML in Markdown).
const SCRIPT_LIKE = /<script\b|<[^>]+\son[a-z]+\s*=|javascript:/i;

// overrides.static (--static) or frontmatter static: true produces HTML without <script>.
export function renderDoc(source: string, overrides: RenderOverrides = {}, defaults: ParseDocOptions['defaults'] = {}): RenderResult {
  const doc = parseDoc(source, { defaults });
  const { static: staticFlag, ...rest } = overrides;
  applyOverrides(doc.meta, rest);
  if (doc.meta.template === 'video') throw new ParseError('template: video は動画の原稿です。explain video で作ってください', 0);
  const isStatic = staticFlag === true || doc.meta.static === 'true';
  // Static output cannot switch colors with JS, so it follows the OS setting (prefers-color-scheme).
  if (isStatic) doc.meta.mode = 'auto';

  const warnings = doc.meta.style === 'off' ? [] : lintDoc(doc);
  if (doc.meta.style === 'strict' && blockingWarnings(warnings).length) throw new LintError(blockingWarnings(warnings));

  const stats: RenderStats = { panels: doc.panels.length, components: {} };
  const ctx: RenderBlocksContext = { seq: 0, stats };
  const introHtml = renderBlocks(doc.intro, ctx);
  const panels = doc.panels.map((p) => ({ ...p, html: renderBlocks(p.blocks, ctx) }));
  const body = TEMPLATES[doc.meta.template]({ meta: doc.meta, introHtml, panels });
  const html = shell({ meta: doc.meta, body, source, isStatic });
  if (isStatic && SCRIPT_LIKE.test(html)) {
    throw new ParseError('静的出力（--static / static: true）には JavaScript を入れられません。html ブロックなどにある <script>、on〜 属性、javascript: を削除してください', 0);
  }
  return { html, warnings, stats, meta: doc.meta, static: isStatic };
}

export function renderBlocks(blocks: readonly Block[], ctx: RenderBlocksContext): string {
  return blocks.map((b) => (b.type === 'md' ? `<div class="am-md">${md(b.text)}</div>` : renderFence(b, ctx))).join('\n');
}

function renderFence(block: FenceBlock, ctx: RenderBlocksContext): string {
  const { lang, args, text, line } = block;
  if (RAW_LANGS.has(lang)) return text;
  const comp = COMPONENTS.get(lang);
  if (!comp) {
    return `<pre class="am-code"><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(text)}</code></pre>`;
  }
  ctx.stats.components[lang] = (ctx.stats.components[lang] ?? 0) + 1;
  try {
    return comp.render(text, { args, uid: () => `am${++ctx.seq}` });
  } catch (err) {
    if (!(err instanceof ComponentError)) throw err;
    throw new RenderError(err.message, {
      line: line + (err.line || 0),
      component: lang,
      example: comp.example,
    });
  }
}

function shell({ meta, body, source, isStatic }: { meta: Meta; body: string; source: string; isStatic: boolean }): string {
  const toolbar = isStatic ? '' : `<div class="am-toolbar">
<button class="am-btn" type="button" data-am="theme" data-labels="${esc(JSON.stringify(UI.theme))}">${esc(UI.theme[meta.theme])}</button>
<button class="am-btn" type="button" data-am="mode" data-labels="${esc(JSON.stringify(UI.mode))}">${esc(UI.mode[meta.mode])}</button>
<button class="am-btn" type="button" data-am="copy" data-done="${esc(UI.done)}">${esc(UI.copy)}</button>
</div>
`;
  const tail = isStatic ? '' : `<textarea id="am-source" hidden readonly aria-hidden="true">${esc(source)}</textarea>
<script>
${RUNTIME_JS}</script>
`;
  return `<!doctype html>
<html lang="ja" data-theme="${esc(meta.theme)}" data-mode="${esc(meta.mode)}"${isStatic ? ' data-static' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="explain ${VERSION}">
<title>${esc(meta.title || '無題')}</title>
<style>
${pageCss()}
</style>
</head>
<body>
${toolbar}${body}
<footer class="am-colophon">explain ${VERSION} で生成 · ${esc(timestamp())}</footer>
${tail}</body>
</html>
`;
}
