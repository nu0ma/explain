// Markdown -> HTML (GFM) with two additions: tables are wrapped in a horizontally scrollable box, and status words in cells become badges.

import { Marked } from 'marked';

const marked = new Marked({ gfm: true });

export type StatusKind = 'ok' | 'no' | 'warn';

const STATUS: Record<StatusKind, { cls: string; icon: string }> = {
  ok: { cls: 'ok', icon: '✓' },
  no: { cls: 'no', icon: '✗' },
  warn: { cls: 'warn', icon: '!' },
};
const STATUS_ALIAS: Record<string, StatusKind> = { '✓': 'ok', '✔': 'ok', '✗': 'no', '✘': 'no', '⚠': 'warn' };

const isStatusKind = (word: string): word is StatusKind => Object.hasOwn(STATUS, word);

export function statusHtml(word: string, label = ''): string | null {
  const key = STATUS_ALIAS[word] ?? word;
  const kind = isStatusKind(key) ? STATUS[key] : undefined;
  if (!kind) return null;
  const text = label.trim();
  return `<span class="am-status am-status--${kind.cls}"><span class="am-status-icon" aria-hidden="true">${kind.icon}</span>${text}</span>`;
}

// The status word must be followed by whitespace or the end of the cell. The label is trimmed afterwards: one [^<]* keeps matching linear.
const CELL_STATUS = /<td([^>]*)>\s*(ok|no|warn|✓|✔|✗|✘|⚠)(?=[\s<])([^<]*)<\/td>/g;

function decorate(html: string): string {
  return html
    .replace(/<table>/g, '<div class="am-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(CELL_STATUS, (_, attrs: string, word: string, label: string) => `<td${attrs}>${statusHtml(word, label)}</td>`);
}

export function md(text: unknown): string {
  return decorate(marked.parse(String(text ?? ''), { async: false }));
}

export function mdInline(text: unknown): string {
  return marked.parseInline(String(text ?? ''), { async: false });
}
