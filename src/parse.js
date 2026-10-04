// 原稿の解析：frontmatter → meta、`## ` 見出し → パネル（slot）、パネル本体 → Markdown ブロックとコードブロック。
// 構造を切り分けるだけで描画はしない。行番号はすべて原稿ファイルの 1 始まりの行番号で、エラー表示と STE 検査に使う。

export class ParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
  }
}

export const CHOICES = Object.freeze({
  template: ['sheet', 'doc', 'video'],
  theme: ['blueprint', 'shadcn'],
  style: ['off', '80', 'strict'],
  mode: ['auto', 'light', 'dark'],
  static: ['true', 'false'],
});

const DEFAULT_META = Object.freeze({
  template: 'sheet',
  theme: 'blueprint',
  style: '80',
  mode: 'auto',
  cols: 3,
  title: '',
});

const NUMERIC_KEYS = new Set(['cols', 'span']);
const FENCE_OPEN = /^(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;
const PANEL_HEADING = /^##\s+(.+?)\s*$/;
const ATTR_BLOCK = /\s*\{([^{}]*)\}\s*$/;
const PANEL_ID = /^([A-Z][0-9]?)\s+(.+)$/;
const ATTR_TOKEN = /([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g;

// コマンドラインの引数で meta を上書きする。undefined のキーは飛ばし、選択肢のあるキーは値を確かめる。
/**
 * @param {Record<string, any>} meta
 * @param {Record<string, any>} overrides
 * @param {Readonly<Record<string, readonly string[]>>} [allowed]
 */
export function applyOverrides(meta, overrides, allowed = CHOICES) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (allowed[key] && !allowed[key].includes(String(value))) {
      throw new ParseError(`${key} の値 "${value}" は使えません。選択肢：${allowed[key].join(' | ')}`, 0);
    }
    meta[key] = value;
  }
}

// defaults：ユーザー設定の既定値（theme / mode / style など）。原稿の frontmatter に明示した値が優先される。
// choices で一部のキーの選択肢を広げられる（動画の原稿では theme: 3b1b も使える）。
export function parseDoc(source, { defaults = {}, choices = {} } = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const { meta, bodyStart } = parseFrontmatter(lines, { ...DEFAULT_META, ...defaults }, { ...CHOICES, ...choices });
  const sections = splitSections(lines, bodyStart);
  const { intro, titleLine } = extractTitle(sections.intro, meta);
  const panels = assignIds(sections.panels);
  // titleLine：本文の先頭の "# 題名" から題名を取ったときの行番号（frontmatter の title なら null）。
  return { meta, intro, panels, titleLine };
}

function parseFrontmatter(lines, base, allowed) {
  if (lines[0]?.trim() !== '---') return { meta: { ...base }, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) throw new ParseError('frontmatter が閉じていません。終わりの行 --- がありません', 1);

  const entries = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i].replace(/\s+#.*$/, '').trim();
    if (!raw || raw.startsWith('#')) continue;
    const m = raw.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) throw new ParseError(`frontmatter を解析できません："${lines[i]}"。key: value の形で書いてください`, i + 1);
    entries[m[1]] = { value: coerce(m[1], unquote(m[2])), line: i + 1 };
  }

  const meta = { ...base };
  for (const [key, { value, line }] of Object.entries(entries)) {
    if (allowed[key] && !allowed[key].includes(String(value))) {
      throw new ParseError(`${key} の値 "${value}" は使えません。選択肢：${allowed[key].join(' | ')}`, line);
    }
    meta[key] = allowed[key] ? String(value) : value;
  }
  return { meta, bodyStart: end + 1 };
}

function splitSections(lines, start) {
  const intro = [];
  const panels = [];
  let current = { blocks: intro };
  let mdBuf = null;
  const flushMd = () => {
    if (mdBuf && mdBuf.lines.some((l) => l.trim())) {
      current.blocks.push({ type: 'md', text: mdBuf.lines.join('\n'), line: mdBuf.line });
    }
    mdBuf = null;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flushMd();
      const close = findFenceClose(lines, i, fence[1]);
      if (close === -1) throw new ParseError(`コードブロック ${fence[1]}${fence[2]} が閉じていません`, i + 1);
      current.blocks.push({
        type: 'fence',
        lang: fence[2].toLowerCase(),
        args: fence[3].trim(),
        text: lines.slice(i + 1, close).join('\n'),
        line: i + 1,
      });
      i = close;
      continue;
    }
    const heading = line.match(PANEL_HEADING);
    if (heading) {
      flushMd();
      current = { ...parseHeading(heading[1]), line: i + 1, blocks: [] };
      panels.push(current);
      continue;
    }
    if (!mdBuf) mdBuf = { line: i + 1, lines: [] };
    mdBuf.lines.push(line);
  }
  flushMd();
  return { intro, panels };
}

function findFenceClose(lines, openIdx, marker) {
  const closeRe = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
  for (let j = openIdx + 1; j < lines.length; j++) {
    if (closeRe.test(lines[j])) return j;
  }
  return -1;
}

function parseHeading(text) {
  let rest = text;
  let attrs = {};
  const attrMatch = rest.match(ATTR_BLOCK);
  if (attrMatch) {
    attrs = parseAttrs(attrMatch[1]);
    rest = rest.slice(0, attrMatch.index);
  }
  const idMatch = rest.match(PANEL_ID);
  return idMatch
    ? { id: idMatch[1], title: idMatch[2].trim(), attrs }
    : { id: null, title: rest.trim(), attrs };
}

export function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(ATTR_TOKEN)) {
    attrs[m[1]] = m[2] === undefined ? true : coerce(m[1], unquote(m[2]));
  }
  return attrs;
}

function extractTitle(intro, meta) {
  if (meta.title || intro[0]?.type !== 'md') return { intro, titleLine: null };
  const [first, ...rest] = intro;
  const lines = first.text.split('\n');
  const idx = lines.findIndex((l) => l.trim());
  const m = lines[idx]?.match(/^#\s+(.+)$/);
  if (!m) return { intro, titleLine: null };
  meta.title = m[1].trim();
  const titleLine = first.line + idx;
  const remaining = lines.slice(idx + 1);
  if (!remaining.some((l) => l.trim())) return { intro: rest, titleLine };
  return { intro: [{ ...first, text: remaining.join('\n'), line: first.line + idx + 1 }, ...rest], titleLine };
}

function assignIds(panels) {
  const used = new Set(panels.map((p) => p.id).filter(Boolean));
  let code = 'A'.charCodeAt(0);
  const nextFree = () => {
    while (used.has(String.fromCharCode(code))) code++;
    const id = code <= 90 ? String.fromCharCode(code) : `P${code - 64}`;
    used.add(id);
    code++;
    return id;
  };
  return panels.map((p) => (p.id ? p : { ...p, id: nextFree() }));
}

function unquote(v) {
  const s = v.trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function coerce(key, value) {
  if (NUMERIC_KEYS.has(key) && /^\d+$/.test(value)) return Number(value);
  return value;
}
