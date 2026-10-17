/*!
 * Bold-rendering check ported from yomiyasu (https://github.com/nanaism/yomiyasu) v2.0.1:
 * bold_problems and its helpers in scripts/yomiyasu_lint.py, and the parts of scripts/markdown_visibility.py they use
 * (analyze_markdown, inline_protected_spans, reference_definition_end).
 * Changes for explain:
 * - Offsets are UTF-16 code units. Where the original reads one character (the neighbors of a ** run, the context
 *   around a finding, the length of a long bold), this port reads whole code points so that the output is the same.
 *
 * This is a block comment so that esbuild keeps the notice in the bundled CLI (legalComments).
 *
 * The yomiyasu license applies to this port:
 *
 * MIT License
 *
 * Copyright (c) 2026 nanaism
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { BoldProblem } from './yomiyasu.ts';

type Span = [start: number, end: number];


const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const BRACKETS: Record<string, string> = { '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '〔': '〕', '［': '］', '[': ']', '〈': '〉', '《': '》', '“': '”', '‘': '’', '＜': '＞' };
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const pyStrip = (s: string): string => s.replace(PY_WS_RE, '');

const isWs = (ch: string): boolean => ch === '' || /^[\t\n\r\f\p{Zs}]+$/u.test(ch);
const punctGfm = (ch: string): boolean => ch !== '' && (ASCII_PUNCT.has(ch) || /^\p{P}$/u.test(ch));
const punctNew = (ch: string): boolean => ch !== '' && /^[\p{P}\p{S}]$/u.test(ch);
type Punct = (ch: string) => boolean;
const canOpen = (prev: string, nxt: string): boolean => [punctGfm, punctNew].every((p) => !isWs(nxt) && (!p(nxt) || isWs(prev) || p(prev)));
const canClose = (prev: string, nxt: string): boolean => [punctGfm, punctNew].every((p) => !isWs(prev) && (!p(prev) || isWs(nxt) || p(nxt)));

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
function cpAt(s: string, p: number): string {
  if (p < 0 || p >= s.length) return '';
  return isHigh(s.charCodeAt(p)) && isLow(s.charCodeAt(p + 1)) ? s.slice(p, p + 2) : s[p];
}
function cpBefore(s: string, p: number): string {
  if (p <= 0 || p > s.length) return '';
  return p >= 2 && isLow(s.charCodeAt(p - 1)) && isHigh(s.charCodeAt(p - 2)) ? s.slice(p - 2, p) : s[p - 1];
}

const escaped = (text: string, position: number): boolean => {
  let start = position;
  while (start > 0 && text[start - 1] === '\\') start--;
  return (position - start) % 2 === 1;
};

function lowerBound(sorted: readonly number[], x: number): number {
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (sorted[mid] < x) a = mid + 1;
    else b = mid;
  }
  return a;
}


type SpanKind = 'escape' | 'inline_code' | 'autolink' | 'html_token' | 'image' | 'link_destination' | 'bare_url';
type KindSpan = [start: number, end: number, kind: SpanKind];

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup '
  + 'dd details dialog dir div dl dt fieldset figcaption figure footer form frame '
  + 'frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main '
  + 'menu menuitem nav noframes ol optgroup option p param section source summary '
  + 'table tbody td tfoot th thead title tr track ul').split(' '));
const TAG_NAME = /<\/?[A-Za-z][A-Za-z0-9-]*/y;
const ATTRIBUTE_NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:(?:[^<>\p{Cc} ]|[\x7f-\x9f])*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>)/uy;
const BARE_URL = new RegExp(`(?:https?://|www\\.)[^${PY_WS}<>]+`, 'uy');
const BLANK_TITLE_LINE = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/y;
const INLINE_EVENTS = /[\\`<[\]hw]/g;

const stickyMatch = (re: RegExp, text: string, pos: number): RegExpExecArray | null => {
  re.lastIndex = pos;
  return re.exec(text);
};

type Terminators = Record<'-->' | '?>' | ']]>' | '>', number[]>;

function terminatorPositions(text: string): Terminators {
  const find = (token: string): number[] => {
    const out: number[] = [];
    for (let p = text.indexOf(token); p !== -1; p = text.indexOf(token, p + token.length)) out.push(p);
    return out;
  };
  return { '-->': find('-->'), '?>': find('?>'), ']]>': find(']]>'), '>': find('>') };
}

function tagSpaceEnd(text: string, start: number): number {
  let pos = start;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  if (text.startsWith('\r\n', pos)) pos += 2;
  else if (text[pos] === '\r' || text[pos] === '\n') pos++;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  return pos;
}

function tagEnd(text: string, start: number, terminators?: Terminators): number | null {
  const closed = (token: keyof Terminators, begin: number): number | null => {
    let end: number;
    if (terminators === undefined) {
      end = text.indexOf(token, begin);
    } else {
      const positions = terminators[token];
      const index = lowerBound(positions, begin);
      end = index < positions.length ? positions[index] : -1;
    }
    return end < 0 ? null : end + token.length;
  };
  if (text.startsWith('<!--', start)) {
    if (text.startsWith('<!-->', start)) return start + 5;
    if (text.startsWith('<!--->', start)) return start + 6;
    return closed('-->', start + 4);
  }
  if (text.startsWith('<?', start)) return closed('?>', start + 2);
  if (text.startsWith('<![CDATA[', start)) return closed(']]>', start + 9);
  if (text.startsWith('<!', start) && /^[A-Za-z]$/.test(text[start + 2] ?? '')) return closed('>', start + 3);
  const opening = stickyMatch(TAG_NAME, text, start);
  if (opening === null) return null;
  let pos = start + opening[0].length;
  const closing = text.startsWith('</', start);
  while (pos < text.length) {
    const spaceEnd = tagSpaceEnd(text, pos);
    if (text[spaceEnd] === '>') return spaceEnd + 1;
    if (!closing && text.startsWith('/>', spaceEnd)) return spaceEnd + 2;
    if (closing || spaceEnd === pos) return null;
    const attribute = stickyMatch(ATTRIBUTE_NAME, text, spaceEnd);
    if (attribute === null) return null;
    pos = spaceEnd + attribute[0].length;
    const assignment = tagSpaceEnd(text, pos);
    if (assignment >= text.length || text[assignment] !== '=') continue;
    pos = tagSpaceEnd(text, assignment + 1);
    if (pos >= text.length) return null;
    if (text[pos] === '"' || text[pos] === "'") {
      const end = text.indexOf(text[pos], pos + 1);
      if (end < 0) return null;
      pos = end + 1;
    } else {
      const begin = pos;
      while (pos < text.length && !' \t\r\n"\'=<>`'.includes(text[pos])) pos++;
      if (pos === begin) return null;
    }
  }
  return null;
}

const isLinkSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function linkEnd(text: string, opening: number): number | null {
  let pos = opening + 1;
  while (isLinkSpace(text[pos])) pos++;
  if (pos >= text.length) return null;
  if (text[pos] === '<') {
    pos++;
    let found = false;
    while (pos < text.length) {
      if (text[pos] === '\\' && pos + 1 < text.length) {
        pos += 2;
        continue;
      }
      if (text[pos] === '>') {
        pos++;
        found = true;
        break;
      }
      if (text[pos] === '<' || text[pos] === '\n' || text[pos] === '\r') return null;
      pos++;
    }
    if (!found) return null;
  } else {
    let depth = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\' && pos + 1 < text.length) {
        pos += 2;
        continue;
      }
      if (ch === '(') {
        depth++;
        if (depth > 32) return null;
      } else if (ch === ')') {
        if (depth === 0) return pos + 1;
        depth--;
      } else if (isLinkSpace(ch)) {
        if (depth) return null;
        break;
      } else if (ch.charCodeAt(0) < 32 || ch === '<' || ch === '>') {
        return null;
      }
      pos++;
    }
    if (depth) return null;
  }
  const spacesStart = pos;
  while (isLinkSpace(text[pos])) pos++;
  if (text[pos] === ')') return pos + 1;
  if (pos === spacesStart || pos >= text.length || !'"\'('.includes(text[pos])) return null;
  const closer = text[pos] === '(' ? ')' : text[pos];
  pos++;
  let found = false;
  while (pos < text.length) {
    if (text[pos] === '\\' && pos + 1 < text.length) {
      pos += 2;
      continue;
    }
    if (text[pos] === closer) {
      pos++;
      found = true;
      break;
    }
    if (stickyMatch(BLANK_TITLE_LINE, text, pos)) return null;
    if (closer === ')' && text[pos] === '(') return null;
    pos++;
  }
  if (!found) return null;
  while (isLinkSpace(text[pos])) pos++;
  return text[pos] === ')' ? pos + 1 : null;
}

const byStartEndKind = (a: KindSpan, b: KindSpan): number => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

function inlineProtectedSpans(text: string): KindSpan[] {
  const startsByWidth = new Map<number, Span[]>();
  for (const m of text.matchAll(/`+/g)) {
    const width = m[0].length;
    const list = startsByWidth.get(width) ?? [];
    list.push([m.index, m.index + width]);
    startsByWidth.set(width, list);
  }
  const starts = new Map<number, number[]>([...startsByWidth].map(([w, runs]) => [w, runs.map((r) => r[0])]));
  const spans: KindSpan[] = [];
  const brackets: number[] = [];
  const terminators = text.includes('<') ? terminatorPositions(text) : undefined;
  let pos = 0;
  while (pos < text.length) {
    INLINE_EVENTS.lastIndex = pos;
    const event = INLINE_EVENTS.exec(text);
    if (event === null) break;
    pos = event.index;
    const ch = text[pos];
    if (ch === '\\' && pos + 1 < text.length && ASCII_PUNCT.has(text[pos + 1])) {
      spans.push([pos, pos + 2, 'escape']);
      pos += 2;
      continue;
    }
    if (ch === '`') {
      let end = pos + 1;
      while (text[end] === '`') end++;
      const width = end - pos;
      const positions = starts.get(width) ?? [];
      const index = lowerBound(positions, end);
      if (index < positions.length) {
        const closing = (startsByWidth.get(width) ?? [])[index][1];
        spans.push([pos, closing, 'inline_code']);
        pos = closing;
        continue;
      }
      pos = end;
      continue;
    }
    if (ch === '<') {
      const auto = stickyMatch(AUTOLINK, text, pos);
      if (auto) {
        const end = pos + auto[0].length;
        spans.push([pos, end, 'autolink']);
        pos = end;
        continue;
      }
      const end = tagEnd(text, pos, terminators);
      if (end !== null) {
        spans.push([pos, end, 'html_token']);
        pos = end;
        continue;
      }
    }
    if (ch === '[') {
      brackets.push(pos);
    } else if (ch === ']' && brackets.length) {
      const opening = brackets.pop() ?? 0;
      if (text[pos + 1] === '(') {
        const end = linkEnd(text, pos + 1);
        if (end !== null) {
          if (opening > 0 && text[opening - 1] === '!' && !escaped(text, opening - 1)) spans.push([opening - 1, end, 'image']);
          else spans.push([pos + 1, end, 'link_destination']);
          pos = end;
          continue;
        }
      }
    }
    const www = text.startsWith('www.', pos);
    if (www || text.startsWith('http://', pos) || text.startsWith('https://', pos)) {
      const prev = pos ? text[pos - 1] : '';
      const boundary = pos === 0 || isWs(prev) || '*_~('.includes(prev);
      if (www && pos && !boundary) {
        pos++;
        continue;
      }
      const match = stickyMatch(BARE_URL, text, pos);
      if (match) {
        let end = pos + match[0].length;
        const segments = match[0].split(/[/?:#]/)[0].split('.');
        const validWww = segments.length >= 2 && segments.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
          && segments.slice(-2).every((part) => !part.includes('_')) && boundary;
        if (!www || validWww) {
          while (end > pos && '?!.,:*_~'.includes(text[end - 1])) end--;
          const url = text.slice(pos, end);
          let excess = url.split(')').length - url.split('(').length;
          while (excess > 0 && end > pos && text[end - 1] === ')') {
            end--;
            excess--;
          }
          spans.push([pos, end, 'bare_url']);
          pos = end;
          continue;
        }
      }
    }
    pos++;
  }
  return spans.sort(byStartEndKind);
}


const CONTAINER_MARKER = /(?:[-+*]|\p{Nd}{1,9}[.)])(?:[ \t]+|$)/uy;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

type BlockKind = 'paragraph' | 'quote' | 'list' | 'heading' | 'heading_underline' | 'table' | 'code' | 'frontmatter'
  | 'html_block' | 'blank' | 'thematic_break' | 'reference_definition';

interface Row {
  line: number;
  raw: string;
  start: number;
  ending: string;
  contentStart: number;
  content: string;
  quoteDepth: number;
  kind: BlockKind;
}

interface LeafBlock {
  kind: BlockKind;
  lines: Row[];
}

interface Analysis {
  blocks: LeafBlock[];
  maskSpans: Span[];
}

const OPAQUE_BLOCKS = new Set<BlockKind>(['code', 'frontmatter', 'html_block', 'reference_definition']);
const LEAF_TEXT = new Set<BlockKind>(['paragraph', 'quote', 'list']);

function columns(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

function containers(raw: string, allowList = true): [prefix: number, quotes: number, listItem: boolean] {
  let pos = 0;
  let quotes = 0;
  let listItem = false;
  while (pos < raw.length) {
    let candidate = pos;
    while (candidate < raw.length && candidate - pos < 3 && raw[candidate] === ' ') candidate++;
    if (raw[candidate] === '>') {
      quotes++;
      pos = candidate + 1;
      if (raw[pos] === ' ' || raw[pos] === '\t') pos++;
      continue;
    }
    const marker = allowList ? stickyMatch(CONTAINER_MARKER, raw, candidate) : null;
    if (marker) {
      listItem = true;
      pos = candidate + marker[0].length;
      continue;
    }
    break;
  }
  return [pos, quotes, listItem];
}

function physicalLines(text: string): [start: number, raw: string, ending: string][] {
  const rows: [number, string, string][] = [];
  let start = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/g)) {
    rows.push([start, text.slice(start, m.index), m[0]]);
    start = m.index + m[0].length;
  }
  rows.push([start, text.slice(start), '']);
  return rows;
}

function tableCells(content: string): string[] {
  const stripped = content.replace(/^[ \t]+|[ \t]+$/g, '');
  const starts = [0];
  const ends: number[] = [];
  for (let index = 0; index < stripped.length; index++) {
    if (stripped[index] === '|' && !escaped(stripped, index)) {
      ends.push(index);
      starts.push(index + 1);
    }
  }
  ends.push(stripped.length);
  const cells = starts.map((left, n) => stripped.slice(left, ends[n]));
  if (stripped.startsWith('|')) cells.shift();
  if (stripped.endsWith('|') && !escaped(stripped, stripped.length - 1)) cells.pop();
  return cells;
}

class RowCursor {
  lines: readonly string[];
  row: number;
  column = 0;

  constructor(lines: readonly string[], row: number) {
    this.lines = lines;
    this.row = row;
  }

  char(): string | null {
    const line = this.lines[this.row];
    if (this.column < line.length) return line[this.column];
    return this.row + 1 < this.lines.length ? '\n' : null;
  }

  following(): string | null {
    return this.lines[this.row][this.column + 1] ?? null;
  }

  advance(): void {
    if (this.column < this.lines[this.row].length) {
      this.column++;
    } else if (this.row + 1 < this.lines.length) {
      this.row++;
      this.column = 0;
    }
  }

  escape(): boolean {
    const next = this.following();
    if (this.char() === '\\' && next !== null && ASCII_PUNCT.has(next)) {
      this.advance();
      this.advance();
      return true;
    }
    return false;
  }

  nextRowBlank(): boolean {
    return !this.lines[this.row + 1].replace(/^[ \t]+|[ \t]+$/g, '');
  }
}

const isSpaceOrTab = (ch: string | null): boolean => ch === ' ' || ch === '\t';

function referenceGap(cursor: RowCursor): boolean {
  let seen = false;
  while (isSpaceOrTab(cursor.char())) {
    cursor.advance();
    seen = true;
  }
  if (cursor.char() === '\n') {
    cursor.advance();
    seen = true;
    while (isSpaceOrTab(cursor.char())) cursor.advance();
  }
  return seen;
}

function referenceDestination(cursor: RowCursor): boolean {
  if (cursor.char() === '<') {
    cursor.advance();
    while (cursor.char() !== null) {
      if (cursor.escape()) continue;
      if (cursor.char() === '>') {
        cursor.advance();
        return true;
      }
      if (cursor.char() === '<' || cursor.char() === '\n') return false;
      cursor.advance();
    }
    return false;
  }
  let count = 0;
  let depth = 0;
  for (let ch = cursor.char(); ch !== null && ch !== ' ' && ch !== '\t' && ch !== '\n'; ch = cursor.char()) {
    if (cursor.escape()) {
      count += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127 || ch === '<' || ch === '>') return false;
    if (ch === '(') {
      depth++;
      if (depth > 32) return false;
    } else if (ch === ')') {
      if (depth === 0) return false;
      depth--;
    }
    cursor.advance();
    count++;
  }
  return count > 0 && depth === 0;
}

function referenceTitleEnd(cursor: RowCursor): number | null {
  const opener = cursor.char();
  const closer = opener === '(' ? ')' : opener;
  cursor.advance();
  while (cursor.char() !== null) {
    if (cursor.escape()) continue;
    const ch = cursor.char();
    if (ch === closer) {
      cursor.advance();
      while (isSpaceOrTab(cursor.char())) cursor.advance();
      const after = cursor.char();
      return after === null || after === '\n' ? cursor.row : null;
    }
    if (opener === '(' && ch === '(') return null;
    if (ch === '\n' && cursor.nextRowBlank()) return null;
    cursor.advance();
  }
  return null;
}

function referenceDefinitionEnd(lines: readonly string[], start: number): number | null {
  if (start < 0 || start >= lines.length) return null;
  const cursor = new RowCursor(lines, start);
  let spaces = 0;
  while (cursor.char() === ' ' && spaces < 3) {
    cursor.advance();
    spaces++;
  }
  if (cursor.char() !== '[') return null;
  cursor.advance();
  let labelLength = 0;
  let meaningful = false;
  while (cursor.char() !== null && cursor.char() !== ']') {
    const ch = cursor.char() ?? '';
    if (cursor.escape()) {
      labelLength += 2;
      meaningful = true;
    } else {
      if (ch === '[') return null;
      if (ch === '\n' && cursor.nextRowBlank()) return null;
      meaningful ||= !' \t\n'.includes(ch);
      if (!isLow(ch.charCodeAt(0))) labelLength++;
      cursor.advance();
    }
    if (labelLength > 999) return null;
  }
  if (cursor.char() !== ']' || !meaningful) return null;
  cursor.advance();
  if (cursor.char() !== ':') return null;
  cursor.advance();
  referenceGap(cursor);
  if (cursor.char() === null || cursor.char() === '\n' || !referenceDestination(cursor)) return null;
  const destinationRow = cursor.row;
  const separated = referenceGap(cursor);
  const next = cursor.char();
  if (next === null || next === '\n') return destinationRow;
  if (!separated || !'"\'('.includes(next)) return cursor.row > destinationRow ? destinationRow : null;
  const titleOnLaterRow = cursor.row > destinationRow;
  const titleRow = referenceTitleEnd(cursor);
  return titleRow === null && titleOnLaterRow ? destinationRow : titleRow;
}

type HtmlUntil = RegExp | 'blank';

function analyzeMarkdown(text: string, skipFrontmatter: boolean): Analysis {
  let blocks: LeafBlock[] = [];
  const protectedSpans: Span[] = [];
  let current: LeafBlock | null = null;
  let fence: [char: string, length: number, depth: number] | null = null;
  let htmlUntil: HtmlUntil | null = null;
  let activeListIndent = 0;
  const rawRows = physicalLines(text);
  let fmEnd = 0;
  if (skipFrontmatter && pyStrip(rawRows[0][1]) === '---') {
    for (let index = 1; index < rawRows.length; index++) {
      if (pyStrip(rawRows[index][1]) === '---') {
        fmEnd = index + 1;
        break;
      }
    }
  }
  for (const [index, [start, raw, ending]] of rawRows.entries()) {
    let [prefix, depth, listItem] = containers(raw);
    const [quotePrefix, quoteDepth] = containers(raw, false);
    const quoteContent = raw.slice(quotePrefix);
    if (THEMATIC.test(quoteContent) || (current !== null && LEAF_TEXT.has(current.kind) && SETEXT.test(quoteContent))) {
      [prefix, depth, listItem] = [quotePrefix, quoteDepth, false];
    }
    if (listItem) {
      activeListIndent = prefix;
    } else if (activeListIndent && depth && prefix >= activeListIndent) {
      listItem = true;
    } else if (activeListIndent && pyStrip(raw)) {
      const indent = raw.length - raw.replace(/^[ \t]+/, '').length;
      if (depth === 0 && indent >= activeListIndent) {
        prefix = activeListIndent;
        listItem = true;
      } else if (depth === 0) {
        activeListIndent = 0;
      }
    }
    const content = raw.slice(prefix);
    const stripped = content.replace(/^[ \t]+|[ \t]+$/g, '');
    const info: Row = { line: index + 1, raw, start, ending, contentStart: start + prefix, content, quoteDepth: depth, kind: 'paragraph' };
    if (prefix) protectedSpans.push([start, start + prefix]);
    let kind: BlockKind | null = null;
    if (index < fmEnd) {
      kind = 'frontmatter';
    } else if (fence !== null && depth < fence[2]) {
      fence = null;
    }
    if (kind === null && fence !== null) {
      kind = 'code';
      if (new RegExp(`^ {0,3}(${fence[0]}{${fence[1]},})[ \\t]*$`).test(content)) fence = null;
    }
    if (kind === null && htmlUntil !== null) {
      kind = 'html_block';
      if (htmlUntil === 'blank') {
        if (!stripped) htmlUntil = null;
      } else if (htmlUntil.test(content)) {
        htmlUntil = null;
      }
    }
    if (kind === null) {
      const marker = content.match(FENCE_OPEN);
      if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
        kind = 'code';
        fence = [marker[1][0], marker[1].length, depth];
      } else if (columns(content) >= 4 && (current === null || current.kind === 'code')) {
        kind = 'code';
      } else if (!stripped) {
        kind = 'blank';
      } else if (ATX_HEADING.test(content)) {
        kind = 'heading';
      } else if (SETEXT.test(content) && current !== null && LEAF_TEXT.has(current.kind)) {
        current.kind = 'heading';
        for (const earlier of current.lines) earlier.kind = 'heading';
        kind = 'heading_underline';
      } else if (THEMATIC.test(content)) {
        kind = 'thematic_break';
      } else if (current !== null && LEAF_TEXT.has(current.kind) && current.lines.length && content.includes('|')
        && tableCells(content).length === tableCells(current.lines[current.lines.length - 1].content).length
        && tableCells(content).every((cell) => DELIMITER_CELL.test(cell))) {
        const header = current.lines.pop();
        if (header) {
          header.kind = 'table';
          if (!current.lines.length) blocks.pop();
          blocks.push({ kind: 'table', lines: [header] });
          current = null;
        }
        kind = 'table';
      } else if (current !== null && current.kind === 'table' && content.includes('|')) {
        kind = 'table';
      } else {
        const htmlStart: string = content.replace(/^[ \t]+/, '');
        if (htmlStart.startsWith('<!--')) htmlUntil = /-->/i;
        else if (htmlStart.startsWith('<?')) htmlUntil = /\?>/i;
        else if (htmlStart.startsWith('<![CDATA[')) htmlUntil = /\]\]>/i;
        else if (/^<![A-Z]/.test(htmlStart)) htmlUntil = />/i;
        else if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(htmlStart)) {
          const tag = htmlStart.match(/^<([A-Za-z]+)/)?.[1] ?? '';
          htmlUntil = new RegExp(`</${tag}[${PY_WS}]*>`, 'i');
        } else {
          const tag: string | undefined = htmlStart.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/)?.[1];
          if (tag !== undefined) {
            if (HTML_BLOCK_TAGS.has(tag.toLowerCase())) {
              htmlUntil = 'blank';
            } else if (current === null || !LEAF_TEXT.has(current.kind)) {
              const end = tagEnd(htmlStart, 0);
              if (end !== null && !htmlStart.slice(end).replace(/^[ \t]+|[ \t]+$/g, '')) htmlUntil = 'blank';
            }
          }
        }
        if (htmlUntil !== null) {
          kind = 'html_block';
          if (htmlUntil !== 'blank' && htmlUntil.test(content)) htmlUntil = null;
        } else {
          kind = listItem ? 'list' : depth ? 'quote' : 'paragraph';
        }
      }
    }
    info.kind = kind;
    if (kind === 'blank' || kind === 'thematic_break' || kind === 'heading_underline') {
      current = null;
      continue;
    }
    if (OPAQUE_BLOCKS.has(kind)) protectedSpans.push([start, start + raw.length + ending.length]);
    let continueBlock = current !== null && current.kind === kind && kind !== 'heading' && kind !== 'table' && kind !== 'list';
    if (continueBlock && kind === 'quote' && current?.lines[0].quoteDepth !== depth) continueBlock = false;
    if (kind === 'list' && current?.kind === 'list' && !containers(raw)[2]) continueBlock = true;
    if (kind === 'paragraph' && current?.kind === 'quote' && depth === 0) {
      continueBlock = true;
      info.kind = 'quote';
    }
    if (!continueBlock || current === null) {
      current = { kind: info.kind, lines: [] };
      blocks.push(current);
    }
    current.lines.push(info);
  }
  const referenceBlocks: LeafBlock[] = [];
  for (const block of blocks) {
    const rows = block.lines;
    let offset = 0;
    if (LEAF_TEXT.has(block.kind) || block.kind === 'heading') {
      const contents = rows.map((row) => row.content);
      while (offset < rows.length) {
        const end = referenceDefinitionEnd(contents, offset);
        if (end === null) break;
        const referenceRows = rows.slice(offset, end + 1);
        for (const row of referenceRows) {
          row.kind = 'reference_definition';
          protectedSpans.push([row.start, row.start + row.raw.length + row.ending.length]);
        }
        referenceBlocks.push({ kind: 'reference_definition', lines: referenceRows });
        offset = end + 1;
      }
    }
    if (offset < rows.length) referenceBlocks.push({ kind: block.kind, lines: rows.slice(offset) });
  }
  blocks = referenceBlocks;
  for (const block of blocks) {
    if (OPAQUE_BLOCKS.has(block.kind)) continue;
    const first = block.lines[0];
    const last = block.lines[block.lines.length - 1];
    const begin = first.start;
    let segment = '';
    let pos = begin;
    for (const row of block.lines) {
      segment += text.slice(pos, row.start) + ' '.repeat(row.contentStart - row.start);
      pos = row.contentStart;
    }
    segment += text.slice(pos, last.start + last.raw.length);
    for (const [left, right] of inlineProtectedSpans(segment)) protectedSpans.push([begin + left, begin + right]);
  }
  protectedSpans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const maskSpans: Span[] = [];
  for (const [left, right] of protectedSpans) {
    const prev = maskSpans[maskSpans.length - 1];
    if (prev && left <= prev[1]) prev[1] = Math.max(prev[1], right);
    else maskSpans.push([left, right]);
  }
  return { blocks, maskSpans };
}


function runsFromMasks(text: string, masked: readonly Span[]): Span[] {
  const runs: Span[] = [];
  let maskIndex = 0;
  for (const m of text.matchAll(/\*+/g)) {
    let position = m.index;
    const finish = m.index + m[0].length;
    while (position < finish) {
      while (maskIndex < masked.length && masked[maskIndex][1] <= position) maskIndex++;
      if (maskIndex < masked.length && masked[maskIndex][0] <= position) {
        position = Math.min(finish, masked[maskIndex][1]);
        continue;
      }
      let end = finish;
      if (maskIndex < masked.length) end = Math.min(end, masked[maskIndex][0]);
      if (end > position) runs.push([position, end]);
      position = end;
    }
  }
  return runs;
}

const starRuns = (text: string): Span[] => runsFromMasks(text, analyzeMarkdown(text, false).maskSpans);

function roles(text: string, start: number, end: number, punct: Punct): [canOpen: boolean, canClose: boolean] {
  const prev = cpBefore(text, start);
  const nxt = cpAt(text, end);
  return [!isWs(nxt) && (!punct(nxt) || isWs(prev) || punct(prev)), !isWs(prev) && (!punct(prev) || isWs(nxt) || punct(nxt))];
}

type Emphasis = [left: number, right: number, width: number];

interface Delimiter {
  start: number;
  head: number;
  remaining: number;
  length: number;
  canClose: boolean;
  stackIndex: number;
}

function delimiterParse(text: string, punct: Punct, runs: readonly Span[]): [pairs: Span[], consumed: Set<number>, emphasis: Emphasis[]] {
  const openers: Delimiter[] = [];
  const buckets: Delimiter[][] = [[], [], [], [], [], []];
  const bucketOf = (d: Delimiter): Delimiter[] => buckets[(d.length % 3) * 2 + (d.canClose ? 1 : 0)];
  const gfmBounds = punct === punctGfm;
  const bottoms = new Map<string, number>();
  const pairs: Span[] = [];
  const emphasis: Emphasis[] = [];
  const consumed = new Set<number>();
  for (const [start, end] of runs) {
    const [isOpen, isClose] = roles(text, start, end, punct);
    const closer: Delimiter = { start, head: 0, remaining: end - start, length: end - start, canClose: isClose, stackIndex: -1 };
    while (isClose && closer.remaining) {
      let opener: Delimiter | null = null;
      const closerMod = closer.length % 3;
      const bottomKey = `${closerMod}:${gfmBounds ? '' : isOpen}`;
      const bottom = bottoms.get(bottomKey) ?? -1;
      for (let b = 0; b < 6; b++) {
        const bucket = buckets[b];
        const mod = b >> 1;
        const closes = (b & 1) === 1;
        const blocked = (isOpen || closes) && (mod + closerMod) % 3 === 0 && (mod !== 0 || closerMod !== 0);
        const candidate = bucket[bucket.length - 1];
        if (candidate && !blocked && candidate.start >= bottom && (opener === null || candidate.stackIndex > opener.stackIndex)) opener = candidate;
      }
      if (opener === null) {
        bottoms.set(bottomKey, start);
        break;
      }
      const used = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
      const left = opener.start + opener.head + opener.remaining - used;
      const right = closer.start + closer.head;
      if (used === 2) pairs.push([left, right]);
      emphasis.push([left, right, used]);
      for (let p = 0; p < used; p++) {
        consumed.add(left + p);
        consumed.add(right + p);
      }
      while (openers[openers.length - 1] !== opener) {
        const removed = openers.pop();
        if (removed) bucketOf(removed).pop();
      }
      bucketOf(opener).pop();
      opener.remaining -= used;
      closer.head += used;
      closer.remaining -= used;
      if (!opener.remaining) openers.pop();
      else bucketOf(opener).push(opener);
    }
    if (isOpen && closer.remaining) {
      closer.stackIndex = openers.length;
      openers.push(closer);
      bucketOf(closer).push(closer);
    }
  }
  return [pairs, consumed, emphasis];
}

function starExtent(text: string, position: number): Span {
  let left = position;
  while (left > 0 && text[left - 1] === '*' && !escaped(text, left - 1)) left--;
  let right = position;
  while (text[right] === '*') right++;
  return [left, right];
}

function localPairOk(text: string, i: number, j: number): boolean {
  const [leftStart, leftEnd] = starExtent(text, i);
  const [rightStart, rightEnd] = starExtent(text, j);
  for (const punct of [punctGfm, punctNew]) {
    const [leftOpen, leftClose] = roles(text, leftStart, leftEnd, punct);
    const [rightOpen, rightClose] = roles(text, rightStart, rightEnd, punct);
    if (!leftOpen || !rightClose) return false;
    const leftN = leftEnd - leftStart;
    const rightN = rightEnd - rightStart;
    if ((rightOpen || leftClose) && (leftN + rightN) % 3 === 0 && (leftN % 3 !== 0 || rightN % 3 !== 0)) return false;
  }
  return true;
}

const key = (...xs: number[]): string => xs.join(',');

interface ScanContext {
  runs: Span[];
  gfm: Emphasis[];
  common: Emphasis[];
  runKeys?: Set<string>;
  opaque?: [SpanKind, string][];
  delimiterMatches?: Map<number, Set<string>>;
}

function boldScan(blockText: string, runs: Span[]): { pairs: Span[]; gfm: Set<string>; common: Set<string>; context: ScanContext } {
  const [gfm, usedGfm, emphasisGfm] = delimiterParse(blockText, punctGfm, runs);
  const [common, usedCommon, emphasisCommon] = delimiterParse(blockText, punctNew, runs);
  const pairs = new Map<string, Span>();
  for (const [i, j] of [...gfm, ...common]) pairs.set(key(i, j), [i, j]);
  const isUsed = (p: number): boolean => usedGfm.has(p) || usedCommon.has(p);
  const anyUsed = (start: number, end: number): boolean => {
    for (let p = start; p < end; p++) if (isUsed(p)) return true;
    return false;
  };
  const nextDouble: (number | null)[] = Array.from({ length: runs.length }, () => null);
  let later: number | null = null;
  for (let index = runs.length - 1; index >= 0; index--) {
    nextDouble[index] = later;
    if (runs[index][1] - runs[index][0] >= 2) later = index;
  }
  for (const [index, [start, end]] of runs.entries()) {
    if (end - start < 2 || anyUsed(start, end)) continue;
    const next = nextDouble[index];
    if (next === null) continue;
    const [laterStart, laterEnd] = runs[next];
    if (end < laterStart && isWs(cpAt(blockText, end)) && anyUsed(laterStart, laterEnd)) continue;
    if (!localPairOk(blockText, start, laterStart)) pairs.set(key(start, laterStart), [start, laterStart]);
  }
  return {
    pairs: [...pairs.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    gfm: new Set(gfm.map(([i, j]) => key(i, j))),
    common: new Set(common.map(([i, j]) => key(i, j))),
    context: { runs, gfm: emphasisGfm, common: emphasisCommon },
  };
}

/** Bold pairs (positions of the opening and closing **) in a block, including ones that do not render. */
export function boldPairs(text: string): Span[] {
  if (!text.includes('**')) return [];
  return boldScan(text, starRuns(text)).pairs;
}


function closeOf(s: string): number {
  const o = s[0];
  const c = BRACKETS[o];
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === o) depth++;
    else if (s[k] === c && --depth === 0) return k;
  }
  return -1;
}

const opaqueOf = (text: string): [SpanKind, string][] => inlineProtectedSpans(text).map(([l, r, kind]) => [kind, text.slice(l, r)]);
const sameOpaque = (a: readonly [SpanKind, string][], b: readonly [SpanKind, string][]): boolean =>
  a.length === b.length && a.every(([kind, s], n) => kind === b[n][0] && s === b[n][1]);

function preservesOtherEmphasis(original: readonly Emphasis[], repaired: readonly Emphasis[], i: number, j: number, delta: number): boolean {
  const kept = new Set(repaired.map((e) => key(...e)));
  for (const [left, right, width] of original) {
    if (left === i && right === j && width === 2) continue;
    if ((i <= left && left < j + 2) || (i <= right && right < j + 2)) return false;
    const movedLeft = left + (left >= j + 2 ? delta : 0);
    const movedRight = right + (right >= j + 2 ? delta : 0);
    if (!kept.has(key(movedLeft, movedRight, width))) return false;
  }
  return true;
}

const MANUAL = { middle: null, how: '手で直す' } as const;

function boldFix(text: string, i: number, j: number, context: ScanContext): { middle: string | null; how: string } {
  const [openStart, openEnd] = starExtent(text, i);
  const [closeStart, closeEnd] = starExtent(text, j);
  if (openEnd - openStart !== 2 || closeEnd - closeStart !== 2) return MANUAL;
  context.runKeys ??= new Set(context.runs.map(([s, e]) => key(s, e)));
  if (!context.runKeys.has(key(i, i + 2)) || !context.runKeys.has(key(j, j + 2))) return MANUAL;
  const inner = text.slice(i + 2, j);
  if (inner.includes('*')) return MANUAL;
  if (context.runs.length > 2 && (isWs(cpAt(inner, 0)) || isWs(cpBefore(inner, inner.length)))) return MANUAL;
  if (context.delimiterMatches === undefined) {
    const matches = new Map<number, Set<string>>();
    for (const [left, right, width] of [...context.gfm, ...context.common]) {
      for (let p = 0; p < width; p++) {
        for (const position of [left + p, right + p]) {
          const set = matches.get(position) ?? new Set<string>();
          set.add(key(left, right, width));
          matches.set(position, set);
        }
      }
    }
    context.delimiterMatches = matches;
  }
  const target = key(i, j, 2);
  for (const position of [i, i + 1, j, j + 1]) {
    for (const pair of context.delimiterMatches.get(position) ?? []) if (pair !== target) return MANUAL;
  }
  context.opaque ??= opaqueOf(text);
  const tries: [middle: string, how: string][] = [];
  if (inner.length >= 3 && BRACKETS[inner[0]] && closeOf(inner) === inner.length - 1) {
    tries.push([`${inner[0]}**${inner.slice(1, -1)}**${inner[inner.length - 1]}`, 'かっこの内側だけを太字にする']);
  }
  if (inner.length >= 2 && '。、．，！？!?'.includes(inner[inner.length - 1])) {
    tries.push([`**${inner.slice(0, -1)}**${inner[inner.length - 1]}`, '句読点を太字の外に出す']);
  }
  let bodyStart = 0;
  let bodyEnd = inner.length;
  while (bodyStart < bodyEnd && isWs(inner[bodyStart])) bodyStart++;
  while (bodyEnd > bodyStart && isWs(inner[bodyEnd - 1])) bodyEnd--;
  const body = inner.slice(bodyStart, bodyEnd);
  const left = canOpen(cpBefore(text, i), cpAt(body, 0)) ? '' : ' ';
  const right = canClose(cpBefore(body, body.length), cpAt(text, j + 2)) ? '' : ' ';
  tries.push([`${left}**${body}**${right}`, body !== inner && !(left || right) ? '太字の内側の空白を取る' : '文字に接する側に半角スペースを入れる']);
  for (const [middle, how] of tries) {
    const candidate = text.slice(0, i) + middle + text.slice(j + 2);
    const t0 = i + middle.indexOf('**');
    const t1 = i + middle.lastIndexOf('**');
    const runs = starRuns(candidate);
    if (!sameOpaque(opaqueOf(candidate), context.opaque)) continue;
    if (runs.length === 2 && context.runs.length === 2) {
      if (key(...runs[0], ...runs[1]) === key(t0, t0 + 2, t1, t1 + 2) && localPairOk(candidate, t0, t1)) return { middle, how };
      continue;
    }
    const [gfm, , emphasisGfm] = delimiterParse(candidate, punctGfm, runs);
    const [common, , emphasisCommon] = delimiterParse(candidate, punctNew, runs);
    const delta = candidate.length - text.length;
    const hasTarget = (pairs: Span[]): boolean => pairs.some(([a, b]) => a === t0 && b === t1);
    if (hasTarget(gfm) && hasTarget(common)
      && preservesOtherEmphasis(context.gfm, emphasisGfm, i, j, delta)
      && preservesOtherEmphasis(context.common, emphasisCommon, i, j, delta)) return { middle, how };
  }
  return MANUAL;
}

const short = (s: string): string => {
  const cs = Array.from(s);
  return cs.length <= 30 ? s : `${cs.slice(0, 12).join('')}…${cs.slice(-12).join('')}`;
};

const before4 = (s: string, i: number): string => Array.from(s.slice(Math.max(0, i - 8), i)).slice(-4).join('');
const after4 = (s: string, j: number): string => Array.from(s.slice(j, j + 8)).slice(0, 4).join('');

/**
 * Locations of ** that fail to render bold, with fix suggestions. startLine is the line number of text's first line.
 * Code, HTML blocks, link reference definitions, inline atoms and leading frontmatter are skipped. Bold spanning lines
 * is handled per leaf block (paragraph, list item, quote, ...).
 */
export function boldProblems(
  text: unknown,
  { startLine = 1, skipFrontmatter = true }: { startLine?: number; skipFrontmatter?: boolean } = {},
): BoldProblem[] {
  const src = String(text);
  if (!src.includes('**')) return [];
  const analysis = analyzeMarkdown(src, skipFrontmatter);
  const out: BoldProblem[] = [];
  const masks = analysis.maskSpans;
  let maskIndex = 0;
  for (const block of analysis.blocks) {
    if (OPAQUE_BLOCKS.has(block.kind)) continue;
    const rows = block.lines;
    const begin = rows[0].start;
    const last = rows[rows.length - 1];
    const finish = last.start + last.raw.length;
    const blockText = src.slice(begin, finish);
    if (!blockText.includes('**')) continue;
    const offsets = rows.map((row) => row.start - begin);
    while (maskIndex < masks.length && masks[maskIndex][1] <= begin) maskIndex++;
    const blockMasks: Span[] = [];
    for (let index = maskIndex; index < masks.length; index++) {
      const [left, right] = masks[index];
      if (left >= finish) break;
      blockMasks.push([Math.max(left, begin) - begin, Math.min(right, finish) - begin]);
    }
    const { pairs, gfm, common, context } = boldScan(blockText, runsFromMasks(blockText, blockMasks));
    for (const [i, j] of pairs) {
      if (gfm.has(key(i, j)) && common.has(key(i, j))) continue;
      const { middle, how } = boldFix(blockText, i, j, context);
      const pre = before4(blockText, i);
      const post = after4(blockText, j + 2);
      out.push({
        line: rows[offsets.findLastIndex((o) => o <= i)].line + startLine - 1,
        found: pre + short(blockText.slice(i, j + 2)) + post,
        suggest: middle === null ? '' : pre + short(middle) + post,
        how,
      });
    }
  }
  return out;
}
