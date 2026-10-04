// SVG layout is computed in Node, so real font metrics are not available. Estimate the width per character class.
// Overestimating is safer: extra padding in a node is better than text overflowing its box.

const CJK_RE = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/;
const NARROW = new Set('iljtfrI.,:;|!\'`()[]{}');
const WIDE = new Set('mwMWOQGD@%&');

export type MeasureOptions = { mono?: boolean };

export function isCJK(ch: string): boolean {
  return CJK_RE.test(ch);
}

function charWidth(ch: string, mono: boolean): number {
  if (isCJK(ch)) return 1;
  if (mono) return 0.6;
  if (ch === ' ') return 0.3;
  if (NARROW.has(ch)) return 0.32;
  if (WIDE.has(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.56;
}

export function measure(str: unknown, size = 13, { mono = false }: MeasureOptions = {}): number {
  let units = 0;
  for (const ch of String(str ?? '')) units += charWidth(ch, mono);
  return Math.round(units * size * 100) / 100;
}

// Split into unbreakable typesetting units: each full-width character is one unit, each run of non-space Latin text is one word.
function tokenize(str: unknown): string[] {
  return String(str).match(/[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]|[^\s⺀-鿿가-힯豈-﫿︰-﹏＀-￯]+|\s+/g) ?? [];
}

export function wrap(str: unknown, maxWidth: number, size = 13, opts: MeasureOptions = {}): string[] {
  const lines: string[] = [];
  let line = '';
  for (const tok of tokenize(str)) {
    if (/^\s+$/.test(tok)) {
      if (line) line += ' ';
      continue;
    }
    const candidate = line + tok;
    if (line.trim() && measure(candidate, size, opts) > maxWidth) {
      lines.push(line.trimEnd());
      line = tok;
    } else {
      line = candidate;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
