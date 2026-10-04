// SVG のレイアウトは Node 側で計算するため、実際のフォントの寸法は取れない。文字の種類ごとに幅を見積もる。
// 見積もりは狭いより広いほうが安全。ノードに余白が出ても、文字が枠からはみ出すよりよい。

const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/;
const NARROW = new Set([...'iljtfrI.,:;|!\'`()[]{}']);
const WIDE = new Set([...'mwMWOQGD@%&']);

export function isCJK(ch) {
  return CJK_RE.test(ch);
}

function charWidth(ch, mono) {
  if (isCJK(ch)) return 1;
  if (mono) return 0.6;
  if (ch === ' ') return 0.3;
  if (NARROW.has(ch)) return 0.32;
  if (WIDE.has(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.56;
}

export function measure(str, size = 13, { mono = false } = {}) {
  let units = 0;
  for (const ch of String(str ?? '')) units += charWidth(ch, mono);
  return Math.round(units * size * 100) / 100;
}

// それ以上分けない組版の単位に切る。全角文字は 1 字で 1 単位、連続した空白以外のラテン文字は 1 語で 1 単位。
function tokenize(str) {
  return String(str).match(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]|[^\s\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]+|\s+/g) ?? [];
}

export function wrap(str, maxWidth, size = 13, opts = {}) {
  const lines = [];
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

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
