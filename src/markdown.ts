// Markdown -> HTML for the subset of GFM that scripts use, with two additions: tables are wrapped in a horizontally scrollable box, and status words in cells become badges.
// Blocks: paragraphs, headings (#), thematic breaks, fenced and indented code, blockquotes, nested ordered and unordered lists, GFM tables.
// Inline: code spans, **strong**, *em*, ~~strike~~, [links](url "title"), <autolinks>, bare http(s) URLs, backslash escapes, hard line breaks.
// Raw HTML is not passed through: < and > in text are escaped. html / svg fenced blocks are the way to embed markup.
// Emphasis follows the CommonMark delimiter rules, so **「語」**を (closing after punctuation, followed by a letter) stays literal, as in GitHub.
// The output markup matches what marked produced, so the video player (STEP_SEL in src/runtime/video.js) selects the same elements.

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
  return decorate(renderBlocks(parseBlocks(splitLines(String(text ?? ''))).blocks));
}

export function mdInline(text: unknown): string {
  return inline(String(text ?? '').replace(/\r\n?/g, '\n'));
}

// ---------- escaping and URLs ----------

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text keeps character references (&amp;, &#39;, &copy;) as written; a bare & is escaped.
const escText = (s: string): string => s.replace(/&(?!#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{0,31};)|[<>"']/g, (c) => ESC[c]);
// Code shows the characters exactly as typed, so every & is escaped.
const escCode = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

const codePoint = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

// Browsers decode character references in href and drop control characters and whitespace before reading the scheme.
function urlScheme(url: string): string {
  const decoded = url
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&(?:tab|newline);/gi, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007f]/g, '');
  return /^([a-z][a-z0-9+.-]*):/i.exec(decoded)?.[1].toLowerCase() ?? '';
}

// Links that would run code are not rendered as links: the Markdown source is shown as text instead.
const UNSAFE_SCHEMES = new Set(['javascript', 'vbscript', 'data']);
const isSafeUrl = (url: string): boolean => !UNSAFE_SCHEMES.has(urlScheme(url));

function hrefAttr(url: string): string {
  let encoded: string;
  try {
    encoded = encodeURI(url).replace(/%25/g, '%');
  } catch {
    encoded = url;
  }
  return escText(encoded);
}

const linkHtml = (href: string, title: string | null, body: string): string =>
  `<a href="${hrefAttr(href)}"${title === null ? '' : ` title="${escText(title)}"`}>${body}</a>`;

// ---------- blocks ----------

type Block = { html: string; para: string | null; blankBefore: boolean };

// NUL is reserved for the lazy-line mark below, so it is replaced as CommonMark does.
const splitLines = (src: string): string[] => src.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD').split('\n');

const isBlank = (line: string | undefined): boolean => line === undefined || /^[ \t]*$/.test(line);

// Removes trailing spaces and tabs (a loop: /[ \t]+$/ is quadratic on long runs of spaces inside the text).
function trimEndSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(0, end);
}

// Indentation in columns. A tab advances to the next multiple of 4, as in CommonMark.
function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Removes up to n columns of indentation and keeps the rest of the line (tabs in code stay tabs).
function stripIndent(line: string, n: number): string {
  let col = 0;
  let k = 0;
  while (k < line.length && col < n) {
    if (line[k] === ' ') col++;
    else if (line[k] === '\t') {
      const next = col + 4 - (col % 4);
      if (next > n) return ' '.repeat(next - n) + line.slice(k + 1);
      col = next;
    } else break;
    k++;
  }
  return line.slice(k);
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})([-+*]|(\d{1,9})([.)]))( +|$)(.*)$/;

function fenceOpen(line: string): RegExpExecArray | null {
  const m = FENCE_OPEN.exec(line);
  // A backtick fence's info string cannot contain backticks (otherwise the line is an inline code span).
  if (m && m[2][0] === '`' && m[3].includes('`')) return null;
  return m;
}

// Cells split at pipes that are not escaped. \| stays in the cell text and becomes | before inline parsing.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const DELIM_CELL = /^:?-+:?$/;

// A table starts at a row with a pipe, followed by a delimiter row with the same number of cells.
function tableAligns(header: string, delim: string | undefined): (string | null)[] | null {
  if (delim === undefined || !header.includes('|') || indentOf(header) > 3) return null;
  if (!/^[ |:-]+$/.test(delim) || !delim.includes('-')) return null;
  const cells = splitRow(delim);
  if (!cells.every((c) => DELIM_CELL.test(c)) || cells.length !== splitRow(header).length) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

const startsBlock = (line: string): boolean => indentOf(line) <= 3 && (fenceOpen(line) !== null || ATX.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line));

// Lines that end a paragraph without a blank line.
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i];
  if (indentOf(line) > 3) return false;
  if (fenceOpen(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const li = LIST_ITEM.exec(line);
  // Only a non-empty bullet or an ordered item that starts at 1 can interrupt a paragraph.
  if (li && li[6].trim() !== '' && (li[3] === undefined || li[3] === '1')) return true;
  return tableAligns(line, lines[i + 1]) !== null;
}

// A container (blockquote or list item) marks a line it takes in only as a possible lazy continuation with LAZY.
// Inside the container, only a paragraph can take a marked line. Any other block stops at it, and parseBlocks returns
// the index, so the container ends before that line and its parent reads the line again without the mark.
const LAZY = '\u0000';
const isLazy = (line: string): boolean => line.startsWith(LAZY);
const unlazy = (line: string): string => (isLazy(line) ? line.slice(1) : line);
const lazyLine = (line: string): string => LAZY + unlazy(line);

type Parsed = { blocks: Block[]; end: number };

// Quotes and lists nested deeper than this are read as paragraphs, so the recursion stays shallow.
const MAX_DEPTH = 32;

function parseBlocks(lines: string[], depth = 0): Parsed {
  const blocks: Block[] = [];
  let i = 0;
  let blankBefore = false;
  const push = (html: string, para: string | null = null): void => {
    blocks.push({ html, para, blankBefore });
    blankBefore = false;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isLazy(line)) break;
    if (isBlank(line)) {
      blankBefore = true;
      i++;
      continue;
    }

    // Indented code (cannot interrupt a paragraph, so it only starts here).
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && !isLazy(lines[i]) && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) body.push(stripIndent(lines[i++], 4));
      while (body.length && isBlank(body[body.length - 1])) {
        body.pop();
        i--;
      }
      push(`<pre><code>${escCode(body.join('\n'))}\n</code></pre>\n`);
      continue;
    }

    const fence = fenceOpen(line);
    if (fence) {
      const [, ind, marker, info] = fence;
      const body: string[] = [];
      i++;
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      while (i < lines.length && !isLazy(lines[i]) && !close.test(lines[i])) body.push(stripIndent(lines[i++], ind.length));
      // Skip the closing fence. An unclosed fence runs to the end of its container.
      if (i < lines.length && !isLazy(lines[i])) i++;
      const lang = unescapePunct(info.trim().split(/\s+/)[0]);
      const cls = lang ? ` class="language-${escCode(lang)}"` : '';
      const code = body.length ? `${escCode(body.join('\n'))}\n` : '';
      push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const level = atx[1].length;
      push(`<h${level}>${inline(headingText(atx[2] ?? ''))}</h${level}>\n`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      push('<hr>\n');
      i++;
      continue;
    }

    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const start = i;
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE.test(l)) inner.push(l.replace(QUOTE, ''));
        // A plain line right after quoted text may continue a paragraph in the quote (lazy continuation).
        else if (!isBlank(l) && !isBlank(inner[inner.length - 1]) && !interrupts(lines, i)) inner.push(lazyLine(l));
        else break;
        i++;
      }
      const { blocks: body, end } = parseBlocks(inner, depth + 1);
      i = start + end;
      push(`<blockquote>\n${renderBlocks(body)}</blockquote>\n`);
      continue;
    }

    if (depth < MAX_DEPTH && LIST_ITEM.test(line)) {
      i = parseList(lines, i, push, depth);
      continue;
    }

    const aligns = tableAligns(line, lines[i + 1]);
    if (aligns) {
      i = parseTable(lines, i, aligns, push);
      continue;
    }

    // Paragraph. Lines marked as lazy by a container continue it.
    const para: string[] = [line.replace(/^[ \t]+/, '')];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && (isLazy(lines[i]) || !interrupts(lines, i))) para.push(unlazy(lines[i++]).replace(/^[ \t]+/, ''));
    const body = inline(trimEndSpaces(para.join('\n')));
    push(`<p>${body}</p>\n`, body);
  }
  return { blocks, end: i };
}

// The heading text without the optional closing sequence of #.
function headingText(raw: string): string {
  const s = raw.trim();
  let k = s.length;
  while (k > 0 && s[k - 1] === '#') k--;
  if (k === 0) return '';
  return k < s.length && (s[k - 1] === ' ' || s[k - 1] === '\t') ? s.slice(0, k).trim() : s;
}

function renderBlocks(blocks: Block[]): string {
  return blocks.map((b) => b.html).join('');
}

function parseTable(lines: string[], start: number, aligns: (string | null)[], push: (html: string) => void): number {
  const row = (cells: string[], tag: 'th' | 'td'): string => {
    const tds = aligns.map((align, k) => {
      const text = (cells[k] ?? '').replace(/\\\|/g, '|');
      return `<${tag}${align ? ` align="${align}"` : ''}>${inline(text)}</${tag}>\n`;
    });
    return `<tr>\n${tds.join('')}</tr>\n`;
  };
  const head = row(splitRow(lines[start]), 'th');
  let i = start + 2;
  let body = '';
  // The table ends at a blank line or at a line that starts another block.
  while (i < lines.length && !isLazy(lines[i]) && !isBlank(lines[i]) && !startsBlock(lines[i])) body += row(splitRow(lines[i++]), 'td');
  push(`<table>\n<thead>\n${head}</thead>\n${body ? `<tbody>${body}</tbody>` : ''}</table>\n`);
  return i;
}

const listKind = (m: RegExpExecArray): string => (m[3] !== undefined ? `ol${m[4]}` : `ul${m[2]}`);

function parseList(lines: string[], start: number, push: (html: string) => void, depth: number): number {
  const first = LIST_ITEM.exec(lines[start])!;
  const kind = listKind(first);
  const ordered = first[3] !== undefined;
  const startNum = ordered ? Number(first[3]) : 1;
  const items: Parsed[] = [];
  let loose = false;
  let i = start;

  for (;;) {
    const m = LIST_ITEM.exec(lines[i])!;
    // Content starts after the marker and 1-4 spaces. With 5 or more spaces (indented code) or none, it starts after one space.
    const markerEnd = m[1].length + m[2].length;
    const empty = m[6] === '';
    const width = markerEnd + (empty || m[5].length > 4 ? 1 : m[5].length);
    const itemStart = empty && isBlank(lines[i + 1] ?? '') ? i + 1 : i;
    const itemLines: string[] = itemStart === i ? [empty ? '' : lines[i].slice(width)] : [];
    i++;

    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A blank line stays in the item only if the item continues after it.
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && itemLines.length && !isLazy(lines[j]) && indentOf(lines[j]) >= width) {
          for (; i < j; i++) itemLines.push('');
          continue;
        }
        break;
      }
      if (!isLazy(l) && indentOf(l) >= width) itemLines.push(stripIndent(l, width));
      // A plain line right after the item's text may continue its paragraph. A list marker starts the next item or another list.
      else if (itemLines.length && !isBlank(itemLines[itemLines.length - 1]) && !LIST_ITEM.test(unlazy(l)) && !interrupts(lines, i)) itemLines.push(lazyLine(l));
      else break;
      i++;
    }

    const item = parseBlocks(itemLines, depth + 1);
    items.push(item);
    if (item.blocks.some((b, n) => n > 0 && b.blankBefore)) loose = true;
    // A lazy line that no paragraph took is not part of the item: the list ends before it.
    if (item.end < itemLines.length) {
      i = itemStart + item.end;
      break;
    }

    // Blank lines between this item and the next one of the same list make the list loose.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    const next = j < lines.length && !isLazy(lines[j]) ? LIST_ITEM.exec(lines[j]) : null;
    if (!next || listKind(next) !== kind) break;
    if (j > i) loose = true;
    i = j;
  }

  const lis = items.map(({ blocks }) => `<li>${loose ? renderBlocks(blocks) : blocks.map((b) => b.para ?? b.html).join('')}</li>\n`);
  const tag = ordered ? 'ol' : 'ul';
  push(`<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>\n${lis.join('')}</${tag}>\n`);
  return i;
}

// ---------- inline ----------

// Delimiter runs (* _ ~~) are resolved by the CommonMark emphasis algorithm, then every node renders to HTML.
type Delim = {
  char: '*' | '_' | '~';
  count: number;
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
  open: string;
  close: string;
  active: boolean;
};
type Node = string | Delim;

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
// Bare URLs stop at the first non-ASCII character, so Japanese text right after a URL is not part of it.
const BARE_URL = /https?:\/\/[!-;=?-~]*/y;

function charBefore(s: string, i: number): string {
  if (i <= 0) return '';
  const code = s.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1];
}

const charAt = (s: string, i: number): string => (i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : '');

function runLength(s: string, i: number): number {
  let j = i;
  while (s[j] === s[i]) j++;
  return j - i;
}

function stickyMatch(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

// Trailing punctuation is not part of a bare URL, and a closing parenthesis only when it is unbalanced (GFM autolinks).
function trimUrl(url: string): string {
  let open = 0;
  let close = 0;
  for (const c of url) {
    if (c === '(') open++;
    else if (c === ')') close++;
  }
  let end = url.length;
  for (;;) {
    const c = url[end - 1];
    if (`?!.,:*_~'";`.includes(c)) end--;
    else if (c === ')' && open < close) {
      end--;
      close--;
    } else return url.slice(0, end);
  }
}

// Start positions of the backtick runs in s, by run length.
type Runs = Map<number, number[]>;

function backtickRuns(s: string): Runs {
  const runs: Runs = new Map();
  for (let i = s.indexOf('`'); i >= 0; ) {
    const n = runLength(s, i);
    const list = runs.get(n);
    if (list) list.push(i);
    else runs.set(n, [i]);
    i = s.indexOf('`', i + n);
  }
  return runs;
}

// A code span that opens at i with len backticks closes at the next run of exactly len backticks. Returns -1 when there is none.
function codeSpanEnd(runs: Runs, i: number, len: number): number {
  const list = runs.get(len) ?? [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < i + len) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : -1;
}

// Pairs every [ with its ], skipping backslash escapes and code spans, in one pass.
function matchBrackets(s: string, runs: Runs): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const n = runLength(s, i);
      const end = codeSpanEnd(runs, i, n);
      i = (end < 0 ? i + n : end + n) - 1;
    } else if (c === '[') stack.push(i);
    else if (c === ']' && stack.length) pairs.set(stack.pop()!, i);
  }
  return pairs;
}

const unescapePunct = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const SPACE = /[ \t\n]/;

// Parses (destination "title") right after the link text. Returns null when it is not a valid link tail.
function linkTail(s: string, start: number): { href: string; title: string | null; end: number } | null {
  if (s[start] !== '(') return null;
  let i = start + 1;
  while (SPACE.test(s[i] ?? '')) i++;
  let href: string;
  if (s[i] === '<') {
    const end = s.indexOf('>', i);
    if (end < 0 || /[\n<]/.test(s.slice(i + 1, end))) return null;
    href = s.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    const from = i;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) i++;
      else if (c <= ' ') break;
      // Like cmark, give up on more than 32 nested parentheses, so a long run of "(" stays linear.
      else if (c === '(' && ++depth > 32) return null;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    href = s.slice(from, i);
  }
  const afterDest = i;
  while (SPACE.test(s[i] ?? '')) i++;
  let title: string | null = null;
  if (i > afterDest && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const closeCh = s[i] === '(' ? ')' : s[i];
    let j = i + 1;
    for (; j < s.length && s[j] !== closeCh; j++) if (s[j] === '\\') j++;
    if (j >= s.length) return null;
    title = unescapePunct(s.slice(i + 1, j));
    i = j + 1;
    while (SPACE.test(s[i] ?? '')) i++;
  }
  if (s[i] !== ')') return null;
  return { href: unescapePunct(href), title, end: i + 1 };
}

function inline(src: string, inLink = false): string {
  const nodes: Node[] = [];
  const delims: Delim[] = [];
  const runs = backtickRuns(src);
  const brackets = inLink ? new Map<number, number>() : matchBrackets(src, runs);
  let text = '';
  const flush = (): void => {
    if (text) nodes.push(escText(text));
    text = '';
  };
  const html = (h: string): void => {
    flush();
    nodes.push(h);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (next === '\n') {
        html('<br>');
        i += 2;
      } else if (ASCII_PUNCT.test(next)) {
        html(escCode(next));
        i += 2;
      } else {
        text += c;
        i++;
      }
      continue;
    }

    if (c === '`') {
      const n = runLength(src, i);
      const end = codeSpanEnd(runs, i, n);
      if (end < 0) {
        text += src.slice(i, i + n);
        i += n;
        continue;
      }
      let code = src.slice(i + n, end).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
      html(`<code>${escCode(code)}</code>`);
      i = end + n;
      continue;
    }

    if (c === '<' && !inLink) {
      const auto = stickyMatch(AUTOLINK, src, i);
      if (auto && isSafeUrl(auto[1])) {
        html(linkHtml(auto[1], null, escText(auto[1])));
        i += auto[0].length;
        continue;
      }
    }

    if (c === '[' && brackets.has(i)) {
      const close = brackets.get(i)!;
      const tail = linkTail(src, close + 1);
      if (tail) {
        if (isSafeUrl(tail.href)) html(linkHtml(tail.href, tail.title, inline(src.slice(i + 1, close), true)));
        else text += src.slice(i, tail.end);
        i = tail.end;
        continue;
      }
    }

    // Bare URLs, also right after Japanese text (as marked did), but not inside a word such as xhttp://.
    if ((c === 'h' || c === 'H') && !inLink && !/[A-Za-z0-9]/.test(src[i - 1] ?? '')) {
      const m = stickyMatch(BARE_URL, src, i);
      const url = m ? trimUrl(m[0]) : '';
      if (/^https?:\/\/[^/?#\s]*[A-Za-z0-9]/i.test(url)) {
        html(linkHtml(url, null, escText(url)));
        i += url.length;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const n = runLength(src, i);
      if (c === '~' && n !== 2) {
        text += src.slice(i, i + n);
        i += n;
        continue;
      }
      const before = charBefore(src, i);
      const after = charAt(src, i + n);
      const wsBefore = before === '' || WHITESPACE.test(before);
      const wsAfter = after === '' || WHITESPACE.test(after);
      const pBefore = UNICODE_PUNCT.test(before);
      const pAfter = UNICODE_PUNCT.test(after);
      const left = !wsAfter && (!pAfter || wsBefore || pBefore);
      const right = !wsBefore && (!pBefore || wsAfter || pAfter);
      const d: Delim = {
        char: c,
        count: n,
        origCount: n,
        canOpen: c === '_' ? left && (!right || pBefore) : left,
        canClose: c === '_' ? right && (!left || pAfter) : right,
        open: '',
        close: '',
        active: true,
      };
      flush();
      nodes.push(d);
      delims.push(d);
      i += n;
      continue;
    }

    if (c === '\n') {
      // Two or more trailing spaces make a hard line break. Other trailing spaces are dropped.
      let end = text.length;
      while (text[end - 1] === ' ') end--;
      const hard = text.length - end >= 2;
      text = text.slice(0, end);
      if (hard) html('<br>');
      else text += '\n';
      i++;
      continue;
    }

    text += c;
    i++;
  }
  flush();

  processEmphasis(delims);
  return nodes.map((n) => (typeof n === 'string' ? n : n.close + n.char.repeat(n.count) + n.open)).join('');
}

// CommonMark "process emphasis": match each closer with the nearest possible opener of the same character.
function processEmphasis(delims: Delim[]): void {
  // Once no opener is found for a kind of closer, later closers of that kind do not search below that point again.
  const openersBottom = new Map<string, number>();
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !closer.canClose) continue;
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.origCount % 3}`;
    while (closer.count > 0) {
      const bottom = openersBottom.get(key) ?? -1;
      let oi = ci - 1;
      for (; oi > bottom; oi--) {
        const o = delims[oi];
        if (!o.active || o.char !== closer.char || !o.canOpen) continue;
        if (o.char === '~' && o.count !== closer.count) continue;
        // Rule of 3: a run that can both open and close does not pair with one when the total length is a multiple of 3.
        if ((o.canClose || closer.canOpen) && (o.origCount + closer.origCount) % 3 === 0 && (o.origCount % 3 !== 0 || closer.origCount % 3 !== 0)) continue;
        break;
      }
      if (oi <= bottom) {
        openersBottom.set(key, ci - 1);
        if (!closer.canOpen) closer.active = false;
        break;
      }
      const opener = delims[oi];
      const use = closer.char === '~' || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
      const tag = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      opener.open = `<${tag}>${opener.open}`;
      closer.close = `${closer.close}</${tag}>`;
      opener.count -= use;
      closer.count -= use;
      // Delimiters between the pair can no longer match anything.
      for (let k = oi + 1; k < ci; k++) delims[k].active = false;
      if (opener.count === 0) opener.active = false;
    }
    if (closer.count === 0) closer.active = false;
  }
}
