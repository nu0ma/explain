// Markdown → HTML（GFM）。2 つの装飾を加える：表を横スクロールできる枠で包む。セルの状態語をバッジにする。

import { Marked } from 'marked';

const marked = new Marked({ gfm: true });

const STATUS = {
  ok: { cls: 'ok', icon: '✓' },
  no: { cls: 'no', icon: '✗' },
  warn: { cls: 'warn', icon: '!' },
};
const STATUS_ALIAS = { '✓': 'ok', '✔': 'ok', '✗': 'no', '✘': 'no', '⚠': 'warn' };

export function statusHtml(word, label = '') {
  const kind = STATUS[STATUS_ALIAS[word] ?? word];
  if (!kind) return null;
  const text = label.trim();
  return `<span class="am-status am-status--${kind.cls}"><span class="am-status-icon" aria-hidden="true">${kind.icon}</span>${text}</span>`;
}

const CELL_STATUS = /<td([^>]*)>\s*(ok|no|warn|✓|✔|✗|✘|⚠)(?:\s+([^<]*?))?\s*<\/td>/g;

function decorate(html) {
  return html
    .replace(/<table>/g, '<div class="am-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(CELL_STATUS, (_, attrs, word, label = '') => `<td${attrs}>${statusHtml(word, label)}</td>`);
}

/** @returns {string} */
export function md(text) {
  return decorate(marked.parse(String(text ?? '')));
}

/** @returns {string} */
export function mdInline(text) {
  return /** @type {string} */ (marked.parseInline(String(text ?? '')));
}
