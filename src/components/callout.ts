import { md } from '../markdown.ts';
import { esc } from '../svg/text.ts';
import { ComponentError } from './error.ts';
import type { Component } from './types.ts';

const KINDS = new Set(['info', 'ok', 'warn', 'err']);

export default {
  name: 'callout',
  summary: '結論・ヒント・警告の帯',
  syntax: `\`\`\`callout <info|ok|warn|err> [見出し]
本文（Markdown）
\`\`\`
- 最初の引数が種類でないときは、引数全体を見出しにして、種類は info になる。`,
  example: '```callout warn 注意\nバルブを閉じてから、ポンプを外す。\n```',
  render(text, { args }) {
    const [first = '', ...rest] = args.split(/\s+/).filter(Boolean);
    const kind = KINDS.has(first) ? first : 'info';
    const title = (KINDS.has(first) ? rest.join(' ') : args).trim();
    if (!title && !text.trim()) throw new ComponentError('callout には見出しか本文が必要です', 1);
    const head = title ? `<div class="am-callout-title">${esc(title)}</div>` : '';
    const body = text.trim() ? `<div class="am-callout-body am-md">${md(text)}</div>` : '';
    return `<div class="am-callout am-callout--${kind}" role="note">${head}${body}</div>`;
  },
} satisfies Component;
