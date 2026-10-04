// 原稿 → 1 ファイルの HTML。流れ：parse → STE 検査 → パネルを描画（Markdown / 部品 / raw）→ テンプレートに当てはめる → CSS とランタイムをインライン化。

import { parseDoc, applyOverrides, ParseError } from './parse.ts';
import { md } from './markdown.ts';
import { COMPONENTS, RAW_LANGS, ComponentError } from './components/index.ts';
import { TEMPLATES } from './templates/index.ts';
import { pageCss } from './themes/index.ts';
import { lintDoc, blockingWarnings } from './lint/ste.ts';
import { esc } from './svg/text.ts';
import { VERSION, RUNTIME_JS } from './assets.ts';
import { timestamp } from './time.ts';

export class RenderError extends Error {
  /** @param {string} message @param {{ line?: number, component?: string, example?: string }} [info] */
  constructor(message, { line, component, example } = {}) {
    super(message);
    this.name = 'RenderError';
    this.line = line;
    this.component = component;
    this.example = example;
  }
}

export class LintError extends Error {
  constructor(warnings) {
    super(`STE 検査で警告が ${warnings.length} 件あります（style: strict）`);
    this.name = 'LintError';
    this.warnings = warnings;
  }
}

// ページ上のボタンの文言。
export const UI = Object.freeze({
  theme: { blueprint: 'テーマ：図面', shadcn: 'テーマ：カード' },
  mode: { auto: '配色：システムに合わせる', light: '配色：ライト', dark: '配色：ダーク' },
  copy: '原稿をコピー',
  done: 'コピーしました ✓',
});

// 静的出力に紛れ込んだ JavaScript を見つける（html ブロックや Markdown 中の生 HTML 由来）。
const SCRIPT_LIKE = /<script\b|<[^>]+\son[a-z]+\s*=|javascript:/i;

// overrides.static（--static）か frontmatter の static: true で、<script> を含まない HTML を出す。
export function renderDoc(source, overrides = {}, defaults = {}) {
  const doc = parseDoc(source, { defaults });
  const { static: staticFlag, ...rest } = overrides;
  applyOverrides(doc.meta, rest);
  if (doc.meta.template === 'video') throw new ParseError('template: video は動画の原稿です。explain video で作ってください', 0);
  const isStatic = staticFlag === true || doc.meta.static === 'true';
  // 静的出力は JS で配色を切り替えられないので、OS の設定（prefers-color-scheme）に従わせる。
  if (isStatic) doc.meta.mode = 'auto';

  const warnings = doc.meta.style === 'off' ? [] : lintDoc(doc);
  if (doc.meta.style === 'strict' && blockingWarnings(warnings).length) throw new LintError(blockingWarnings(warnings));

  const stats = { panels: doc.panels.length, components: {} };
  const ctx = { seq: 0, stats };
  const introHtml = renderBlocks(doc.intro, ctx);
  const panels = doc.panels.map((p) => ({ ...p, html: renderBlocks(p.blocks, ctx) }));
  const body = TEMPLATES[doc.meta.template]({ meta: doc.meta, introHtml, panels });
  const html = shell({ meta: doc.meta, body, source, isStatic });
  if (isStatic && SCRIPT_LIKE.test(html)) {
    throw new ParseError('静的出力（--static / static: true）には JavaScript を入れられません。html ブロックなどにある <script>、on〜 属性、javascript: を削除してください', 0);
  }
  return { html, warnings, stats, meta: doc.meta, static: isStatic };
}

export function renderBlocks(blocks, ctx) {
  return blocks.map((b) => (b.type === 'md' ? `<div class="am-md">${md(b.text)}</div>` : renderFence(b, ctx))).join('\n');
}

function renderFence(block, ctx) {
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

function shell({ meta, body, source, isStatic }) {
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
