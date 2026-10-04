// Manuscript parsing: frontmatter -> meta, `## ` headings -> panels (slots), panel bodies -> Markdown blocks and code blocks.
// Only splits the structure; no rendering. All line numbers are 1-based lines of the manuscript file, used for error display and STE checks.

/** A frontmatter / override value. Only `cols` and `span` are coerced to numbers. */
export type MetaValue = string | number | boolean;

export interface Meta {
  template: string;
  theme: string;
  style: string;
  mode: string;
  cols: number | string;
  title: string;
  static?: string;
  subtitle?: string;
  [key: string]: MetaValue | undefined;
}

/** Heading attributes such as `{span=2 bare}`. A bare key becomes `true`. */
export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface MdBlock {
  type: 'md';
  text: string;
  line: number;
}

export interface FenceBlock {
  type: 'fence';
  lang: string;
  args: string;
  text: string;
  line: number;
}

export type Block = MdBlock | FenceBlock;

export interface Panel {
  id: string;
  title: string;
  attrs: Attrs;
  line: number;
  blocks: Block[];
}

export interface ParsedDoc {
  meta: Meta;
  intro: Block[];
  panels: Panel[];
  /** Line of the leading `# Title` in the body, or null when the title came from frontmatter. */
  titleLine: number | null;
}

export type Choices = Readonly<Record<string, readonly string[]>>;

export interface ParseDocOptions {
  defaults?: Partial<Record<string, MetaValue>>;
  choices?: Choices;
}

export class ParseError extends Error {
  line: number;

  constructor(message: string, line: number) {
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
}) satisfies Choices;

const DEFAULT_META: Readonly<Meta> = Object.freeze({
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

// Overrides meta with command-line arguments. Skips undefined values and validates keys that have choices.
export function applyOverrides(
  meta: Record<string, MetaValue | undefined>,
  overrides: Readonly<Record<string, MetaValue | undefined>>,
  allowed: Choices = CHOICES,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const options = allowed[key];
    if (options && !options.includes(String(value))) {
      throw new ParseError(`${key} の値 "${value}" は使えません。選択肢：${options.join(' | ')}`, 0);
    }
    meta[key] = value;
  }
}

// defaults: user-configured defaults (theme / mode / style, etc.). Values set explicitly in the frontmatter win.
// choices widens the allowed values for some keys (video manuscripts also accept theme: 3b1b).
export function parseDoc(source: unknown, { defaults = {}, choices = {} }: ParseDocOptions = {}): ParsedDoc {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const { meta, bodyStart } = parseFrontmatter(lines, { ...DEFAULT_META, ...defaults }, { ...CHOICES, ...choices });
  const sections = splitSections(lines, bodyStart);
  const { intro, titleLine } = extractTitle(sections.intro, meta);
  const panels = assignIds(sections.panels);
  // titleLine: line number when the title came from a leading "# Title" in the body (null for a frontmatter title).
  return { meta, intro, panels, titleLine };
}

function parseFrontmatter(lines: string[], base: Meta, allowed: Choices): { meta: Meta; bodyStart: number } {
  if (lines[0]?.trim() !== '---') return { meta: { ...base }, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) throw new ParseError('frontmatter が閉じていません。終わりの行 --- がありません', 1);

  const entries: Record<string, { value: string | number; line: number }> = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i].replace(/\s+#.*$/, '').trim();
    if (!raw || raw.startsWith('#')) continue;
    const m = raw.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) throw new ParseError(`frontmatter を解析できません："${lines[i]}"。key: value の形で書いてください`, i + 1);
    entries[m[1]] = { value: coerce(m[1], unquote(m[2])), line: i + 1 };
  }

  const meta: Meta = { ...base };
  for (const [key, { value, line }] of Object.entries(entries)) {
    const options = allowed[key];
    if (options && !options.includes(String(value))) {
      throw new ParseError(`${key} の値 "${value}" は使えません。選択肢：${options.join(' | ')}`, line);
    }
    meta[key] = options ? String(value) : value;
  }
  return { meta, bodyStart: end + 1 };
}

/** A panel before `assignIds` fills in missing ids. */
type RawPanel = Omit<Panel, 'id'> & { id: string | null };

function splitSections(lines: string[], start: number): { intro: Block[]; panels: RawPanel[] } {
  const intro: Block[] = [];
  const panels: RawPanel[] = [];
  let current: { blocks: Block[] } = { blocks: intro };
  let mdBuf: { line: number; lines: string[] } | null = null;
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
      const panel: RawPanel = { ...parseHeading(heading[1]), line: i + 1, blocks: [] };
      panels.push(panel);
      current = panel;
      continue;
    }
    if (!mdBuf) mdBuf = { line: i + 1, lines: [] };
    mdBuf.lines.push(line);
  }
  flushMd();
  return { intro, panels };
}

function findFenceClose(lines: string[], openIdx: number, marker: string): number {
  const closeRe = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
  for (let j = openIdx + 1; j < lines.length; j++) {
    if (closeRe.test(lines[j])) return j;
  }
  return -1;
}

function parseHeading(text: string): { id: string | null; title: string; attrs: Attrs } {
  let rest = text;
  let attrs: Attrs = {};
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

export function parseAttrs(text: string): Attrs {
  const attrs: Attrs = {};
  for (const m of text.matchAll(ATTR_TOKEN)) {
    attrs[m[1]] = m[2] === undefined ? true : coerce(m[1], unquote(m[2]));
  }
  return attrs;
}

function extractTitle(intro: Block[], meta: Meta): { intro: Block[]; titleLine: number | null } {
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

function assignIds(panels: RawPanel[]): Panel[] {
  const used = new Set(panels.map((p) => p.id).filter(Boolean));
  let code = 'A'.charCodeAt(0);
  const nextFree = () => {
    while (used.has(String.fromCharCode(code))) code++;
    const id = code <= 90 ? String.fromCharCode(code) : `P${code - 64}`;
    used.add(id);
    code++;
    return id;
  };
  return panels.map((p) => (p.id ? { ...p, id: p.id } : { ...p, id: nextFree() }));
}

function unquote(v: string): string {
  const s = v.trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function coerce(key: string, value: string): string | number {
  if (NUMERIC_KEYS.has(key) && /^\d+$/.test(value)) return Number(value);
  return value;
}
