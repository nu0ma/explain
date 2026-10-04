// Checks for writing patterns common in AI-written Japanese. All rules are ported from
// scripts/yomiyasu_lint.py in yomiyasu (https://github.com/nanaism/yomiyasu) v1.0.5. The word and regex lists,
// the bold-rendering check, the bold/list frequency, and the sentence-end repetition check follow the original script.
// Changes for explain:
// - The checked scope matches explain's STE checks, including table cells and quotes (video narration).
//   Code, inline code, ~~strikethrough~~, table rows with status no, and HTML blocks are skipped.
// - ✓ ✔ ✗ ✘ ⚠ are excluded from emoji, since explain uses them as table status words (badges).
// - Severities are kept as in yomiyasu. info (「AではなくB」) does not block generation even with style: strict.
//
// The yomiyasu license applies to these lists and checks:
//
// MIT License
//
// Copyright (c) 2026 nanaism
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export type Severity = 'warn' | 'error' | 'info';

export type LintRule =
  | 'sentence-length'
  | 'paragraph-length'
  | 'verbose'
  | 'hedge'
  | 'emphasis'
  | 'no-chain'
  | 'halfwidth-space'
  | 'trailing-colon'
  | 'slop-word'
  | 'metaphor-verb'
  | 'filler'
  | 'negative-parallel'
  | 'emoji'
  | 'redundant-bracket'
  | 'sentence-end-repeat'
  | 'excess-bold'
  | 'excess-list'
  | 'bold-not-rendered';

/** A lint finding. STE rules leave `severity` unset; yomiyasu rules always set it. */
export interface LintWarning {
  line: number;
  rule: LintRule;
  message: string;
  suggestion: string;
  severity?: Severity;
}

/** A plain-text sentence used for the sentence-end repetition check. */
export interface Sentence {
  line: number;
  text: string;
}

/** Character / line counts used for the bold and list frequency checks. */
export interface TextMetrics {
  chars: number;
  lines: number;
  listLines: number;
  bold: number;
}

/** A `**` pair that does not render as bold, with a suggested fix (`suggest` is '' when none). */
export interface BoldProblem {
  line: number;
  found: string;
  suggest: string;
  how: string;
}

interface Pattern {
  re: RegExp;
  label: string;
}

// Emoji (yomiyasu's EMOJI_PATTERN), excluding ✓ ✔ ✗ ✘ ⚠ used as table status words.
const EMOJI = new RegExp(
  '(?![\\u2713\\u2714\\u2717\\u2718\\u26A0])(?:'
  + '[\\u{1F600}-\\u{1F64F}]|[\\u{1F300}-\\u{1F5FF}]|[\\u{1F680}-\\u{1F6FF}]|[\\u{1F700}-\\u{1F77F}]'
  + '|[\\u{1F780}-\\u{1F7FF}]|[\\u{1F800}-\\u{1F8FF}]|[\\u{1F900}-\\u{1F9FF}]|[\\u{1FA00}-\\u{1FA6F}]'
  + '|[\\u{1FA70}-\\u{1FAFF}]|[\\u2600-\\u27BF]|[\\u2300-\\u23FF]|[\\u2B50-\\u2B55])',
  'gu',
);

// Words common in AI writing (yomiyasu's SLOP_WORDS).
export const SLOP_WORDS: readonly string[] = Object.freeze([
  // Pseudo-concrete words that fake texture
  '手触り', '肌感', '肌感覚', '体温', '温度感', '熱量', '血の通った', '泥臭い', '泥臭さ',
  // Words that fake insight or evaluation
  '解像度', '腹落ち', 'メンタルモデル', '本質的', '地に足のついた', '等身大',
  // Abstract metaphorical nouns
  '営み', '装置', '意思決定OS', '土台', '羅針盤', '起爆剤', '触媒',
  // Coinages that inflate experiences
  '真理', '虚飾', '境地', '美学', '深淵', '冷徹', '禁欲的', '優美', '極致', '宿命',
  // Words that surged in 2026 (context-dependent, but worth checking)
  '正本',
]);

// Metaphorical verbs and verbs AI favors (yomiyasu's METAPHOR_VERB_PATTERNS).
const KOWARERU = '比喩動詞「壊れる」';
const SILENTLY = '英語直訳「静かに壊れる (silently fail)」';
export const METAPHOR_VERBS: readonly Pattern[] = Object.freeze([
  { re: /(地味に|よく|じわじわ)効[かきくけいた]/, label: '比喩動詞「効く」の過剰使用' },
  { re: /(データ|仕様|設計|環境|ビルド|システム|秩序)が(静かに)?壊れ/, label: KOWARERU },
  { re: /静かに(壊れ|落ち|失敗|沈黙)/g, label: SILENTLY },
  { re: /黙って(無視|捨て|スキップ|破棄)/, label: '英語直訳「黙って無視される」' },
  { re: /側に倒[すしせ]/, label: '判断を方向で表現する「〜側に倒す」' },
  { re: /時間[をに]溶か[したす]/, label: '比喩動詞「時間を溶かす」' },
  { re: /(1つずつ|一つずつ)潰[していく]/, label: '比喩動詞「潰す」' },
  { re: /(実装|詳細|コード|設計|内部|仕組み|領域|本質)(に|まで|へ)踏み込[んむみま]/, label: '比喩動詞「踏み込む」' },
  { re: /動かしながら引き返[すし]/, label: '比喩動詞「引き返す」' },
  { re: /代わりに添え[るた]/, label: '比喩動詞「添える」' },
  { re: /(議論|意見|結論|方向性|価格|話題|検討)が[^。！？!?]*?収斂/, label: '比喩動詞「収斂する」' },
  { re: /した瞬間に?/, label: '英語直訳「〜した瞬間 (the moment ...)」' },
  { re: /(前提|基盤)が崩れ[るた]/, label: '抽象比喩「前提が崩れる」' },
  { re: /文化が醸成/, label: '非生物主語「文化が醸成される」' },
  { re: /プロセスが定着/, label: '非生物主語「プロセスが定着する」' },
  { re: /事例が残した/, label: '非生物主語「事例が残した」' },
]);

// Stock openers and closers (yomiyasu's FILLER_PATTERNS), matched at the start or end of a line.
export const FILLERS: readonly Pattern[] = Object.freeze([
  { re: /^(まず|ここで)?重要なのは、?/, label: '前置フィラー「重要なのは」' },
  { re: /^結論から言うと、?/, label: '前置フィラー「結論から言うと」' },
  { re: /^正直に言うと、?/, label: '前置フィラー「正直に言うと」' },
  { re: /^避けたいのは、?/, label: '前置フィラー「避けたいのは」' },
  { re: /いかがでした(でしょうか|か)?[？?。]?$/, label: '定型クロージング「いかがでしたでしょうか」' },
  { re: /ぜひ(参考|試し|活用)(に)?して(みて)?ください[！!。]?/, label: '定型クロージング「ぜひ〜してみてください」' },
  { re: /〜に他なりません/, label: '過剰な自己ラベリング「〜に他なりません」' },
]);

const NEGATIVE_PARALLEL = /([^。、]+)ではなく、?([^。、]+)/;
const REDUNDANT_BRACKET = /（(素の出力|いわゆる|概要|詳細|感謝と設計への反映)）/;
const HALFWIDTH_SPACE = /([ぁ-んァ-ヶ一-龥])\s+([a-zA-Z0-9_-]{2,})\s+([ぁ-ん])/u;
const SENTENCE_ENDS = ['です', 'ます', 'でした', 'ました', 'である', 'だ', 'だろう'];

const DO = {
  slop: '文脈上いらない比喩や大げさな飾りなら、ふだんの言葉に置き換える。文字どおりの意味なら残してよい',
  metaphor: '不自然な比喩なら、ふだんの動詞や客観的な書き方にする。文字どおりの動作や状態の変化なら残してよい',
  filler: 'ただの前置きや飾りなら削り、本題から書く。評価そのものを担うなら述語に移して残す',
  negative: '否定を外しても主張が変わらないなら肯定文にする。誤解の訂正や見方の切り替えなら残してよい',
};

const warn = (line: number, rule: LintRule, message: string, suggestion: string, severity: Severity = 'warn'): LintWarning => ({ line, rule, message, suggestion, severity });

// Checks the words and phrasing of one line (not a heading). text has inline code and decoration removed.
export function checkLine(text: string, line: number): LintWarning[] {
  const out: LintWarning[] = [];
  if (HALFWIDTH_SPACE.test(text)) {
    out.push(warn(line, 'halfwidth-space', '英単語の前後に半角空白があります', '日本語の助詞と空白なしでつなげる'));
  }
  if (/[：:]$/.test(text) && !text.startsWith('http')) {
    out.push(warn(line, 'trailing-colon', '文末がコロン（：）です', '句点（。）で終えるか、前置きを省く'));
  }
  for (const word of SLOP_WORDS) {
    if (text.includes(word)) out.push(warn(line, 'slop-word', `AI の文章に多い語「${word}」`, DO.slop));
  }
  // Keep 「〜が壊れる」 and 「静かに壊れる」 from both hitting the same verb (same as yomiyasu).
  let kowareru: [number, number] | null = null;
  for (const { re, label } of METAPHOR_VERBS) {
    if (label === SILENTLY && kowareru) {
      const [ka, kb] = kowareru;
      const m = [...text.matchAll(re)].find((x) => !(ka <= x.index && x.index + x[0].length <= kb));
      if (m) out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
      continue;
    }
    const m = text.match(re);
    if (!m) continue;
    if (label === KOWARERU && m.index !== undefined) kowareru = [m.index, m.index + m[0].length];
    out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
  }
  for (const { re, label } of FILLERS) {
    if (re.test(text)) out.push(warn(line, 'filler', label, DO.filler));
  }
  if (NEGATIVE_PARALLEL.test(text)) {
    out.push(warn(line, 'negative-parallel', '「AではなくB」の構文です', DO.negative, 'info'));
  }
  return out;
}

// Emoji (every line, including headings and tables).
export function checkEmoji(raw: string, line: number): LintWarning[] {
  const found = raw.match(EMOJI);
  return found ? [warn(line, 'emoji', `絵文字（${found.slice(0, 3).join(' ')}）があります`, '飾りを外し、言葉で書く')] : [];
}

// Parenthetical asides in headings that add no information.
export function checkHeading(text: string, line: number): LintWarning[] {
  return REDUNDANT_BRACKET.test(text) ? [warn(line, 'redundant-bracket', '見出しに情報の増えない補足のかっこがあります', 'かっこを削る')] : [];
}

// Places where the same sentence ending repeats 3+ times. sentences are { line, text } in document order.
export function checkSentenceEnds(sentences: readonly Sentence[]): LintWarning[] {
  const out: LintWarning[] = [];
  let prev: string | null = null;
  let count = 1;
  for (const { line, text } of sentences) {
    const end = endKind(text.replace(/[。！？\s]+$/, ''));
    if (end && end === prev) {
      count++;
      if (count === 3) out.push(warn(line, 'sentence-end-repeat', `文末の「${end}」が 3 回以上続いています`, '文末の形を変えてリズムを整える'));
    } else {
      count = 1;
    }
    prev = end;
  }
  return out;
}

// Determines the sentence-ending kind, checking in the same order as yomiyasu.
function endKind(s: string): string | null {
  return SENTENCE_ENDS.find((e) => s.endsWith(e)) ?? null;
}

// Bold and list frequency. Only checked when the body text exceeds 300 characters.
export function checkMetrics({ chars, lines, listLines, bold }: TextMetrics, line = 1): LintWarning[] {
  const out: LintWarning[] = [];
  if (chars <= 300) return out;
  const perThousand = Math.round((bold / chars) * 1000 * 100) / 100;
  const ratio = lines ? listLines / lines : 0;
  if (perThousand > 3.0) {
    out.push(warn(line, 'excess-bold', `太字が多すぎます（1,000 字あたり ${perThousand} 個。目安は 2.5 以下）`, '大事な要点だけを太字にする'));
  }
  if (ratio > 0.25) {
    out.push(warn(line, 'excess-list', `箇条書きの行が多すぎます（${Math.round(ratio * 1000) / 10}%。目安は 20% 以下）`, '考えや論理の流れは地の文で書く'));
  }
  return out;
}

// AI-likeness score: like yomiyasu, start at 100 and subtract 5 per warn/error and 2 per info.
export function aiScore(warnings: readonly Pick<LintWarning, 'severity'>[]): number {
  const penalty = warnings.filter((w) => w.severity).reduce((n, w) => n + (w.severity === 'info' ? 2 : 5), 0);
  return Math.max(0, 100 - penalty);
}

// ---- Whether bold renders (yomiyasu's bold_problems) ----
// When the character just inside ** is punctuation (「」（）` etc.) and the one just outside is a letter, ** is not
// treated as a bold marker and is shown literally. Only forms that render bold in both newer CommonMark (Unicode S
// counts as punctuation) and GitHub GFM (P only) count as rendered.
// Fix suggestions are tried in order: bold only inside the brackets -> move punctuation outside the bold -> add a
// half-width space on the side touching a letter.

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const BRACKETS: Record<string, string> = { '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '〔': '〕', '［': '］', '[': ']', '〈': '〉', '《': '》', '“': '”', '‘': '’', '＜': '＞' };

const isWs = (ch: string | undefined): boolean => ch === '' || /^\s$/u.test(String(ch));
const punctGfm = (ch: string): boolean => ch !== '' && (ASCII_PUNCT.has(ch) || /^\p{P}$/u.test(ch));
const punctNew = (ch: string): boolean => ch !== '' && /^[\p{P}\p{S}]$/u.test(ch);
const canOpen = (prev: string, nxt: string): boolean => [punctGfm, punctNew].every((p) => !isWs(nxt) && (!p(nxt) || isWs(prev) || p(prev)));
const canClose = (prev: string, nxt: string): boolean => [punctGfm, punctNew].every((p) => !isWs(prev) && (!p(prev) || isWs(nxt) || p(nxt)));
const at = (s: string, p: number): string => (p >= 0 && p < s.length ? s[p] : '');

type Span = [start: number, end: number];

function codeSpans(text: string): Span[] {
  const runs = [...text.matchAll(/`+/g)].map((m): Span => [m.index, m.index + m[0].length]);
  const spans: Span[] = [];
  for (let k = 0; k < runs.length; k++) {
    const [s, e] = runs[k];
    for (let m = k + 1; m < runs.length; m++) {
      if (runs[m][1] - runs[m][0] === e - s) {
        spans.push([s, runs[m][1]]);
        k = m;
        break;
      }
    }
  }
  return spans;
}

export function boldPairs(text: string): Span[] {
  const code = codeSpans(text);
  const pos: number[] = [];
  for (const m of text.matchAll(/(?<!\*)\*\*(?!\*)/g)) {
    const p = m.index;
    if (code.some(([a, b]) => a <= p && p < b)) continue;
    const bs = text.slice(0, p).match(/\\*$/)?.[0].length ?? 0;
    if (bs % 2 === 1) continue;
    pos.push(p);
  }
  const pairs: Span[] = [];
  const used = new Set<number>();
  // Pass 1: decide opener/closer from whitespace around **, then pair them with a stack.
  const stack: number[] = [];
  for (const p of pos) {
    const open = !isWs(at(text, p + 2));
    const close = !isWs(at(text, p - 1));
    if (close && stack.length) {
      const opener = stack.pop();
      if (opener !== undefined && opener + 2 < p) {
        pairs.push([opener, p]);
        used.add(opener);
        used.add(p);
      }
    } else if (open) {
      stack.push(p);
    }
  }
  // Pass 2: pair candidates that failed to open/close only because of inner whitespace.
  const unpaired = pos.filter((p) => !used.has(p));
  let idx = 0;
  while (idx < unpaired.length - 1) {
    const p1 = unpaired[idx];
    const p2 = unpaired[idx + 1];
    if (pairs.some(([a, b]) => (p1 < a && a < p2) || (p1 < b && b < p2))) {
      idx++;
      continue;
    }
    const inner = text.slice(p1 + 2, p2);
    if (inner.trim() !== '' && (isWs(inner[0]) || isWs(inner.at(-1)))) {
      pairs.push([p1, p2]);
      idx += 2;
      continue;
    }
    idx++;
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

const pairOk = (text: string, i: number, j: number): boolean => canOpen(at(text, i - 1), at(text, i + 2)) && canClose(at(text, j - 1), at(text, j + 2));

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

function boldFix(text: string, i: number, j: number, k: number): { middle: string | null; how: string } {
  const inner = text.slice(i + 2, j);
  const tries: [middle: string, how: string][] = [];
  if (inner.length >= 3 && BRACKETS[inner[0]] && closeOf(inner) === inner.length - 1) {
    tries.push([`${inner[0]}**${inner.slice(1, -1)}**${inner.at(-1)}`, 'かっこの内側だけを太字にする']);
  }
  if (inner.length >= 2 && '。、．，！？!?'.includes(inner.at(-1) ?? '')) {
    tries.push([`**${inner.slice(0, -1)}**${inner.at(-1)}`, '句読点を太字の外に出す']);
  }
  const body = isWs(at(text, i + 2)) || isWs(at(text, j - 1)) ? inner.trim() : inner;
  const left = canOpen(at(text, i - 1), body.slice(0, 1)) ? '' : ' ';
  const right = canClose(body.slice(-1), at(text, j + 2)) ? '' : ' ';
  tries.push([`${left}**${body}**${right}`, body !== inner && !(left || right) ? '太字の内側の空白を取る' : '文字に接する側に半角スペースを入れる']);
  for (const [middle, how] of tries) {
    const cand = text.slice(0, i) + middle + text.slice(j + 2);
    const pairs = boldPairs(cand);
    if (k < pairs.length && pairOk(cand, pairs[k][0], pairs[k][1])) return { middle, how };
  }
  return { middle: null, how: '手で直す' };
}

// A line's list marker, quote depth, and the content inside them.
function lineContainers(line: string): { isList: boolean; depth: number; content: string } {
  const list = line.match(/^\s{0,3}(?:[*+-]|\d+[.)])\s+/);
  const rem = list ? line.slice(list[0].length) : line;
  let depth = 0;
  let p = 0;
  for (;;) {
    p += rem.slice(p).match(/^\s{0,3}/)?.[0].length ?? 0;
    if (rem[p] !== '>') break;
    depth++;
    p++;
    if (rem[p] === ' ') p++;
  }
  return { isList: Boolean(list), depth, content: rem.slice(p) };
}

// For long bold text, show only the parts to fix (both ends). Length is counted in code points (same as yomiyasu).
const short = (s: string): string => {
  const cs = Array.from(s);
  return cs.length <= 30 ? s : `${cs.slice(0, 12).join('')}…${cs.slice(-12).join('')}`;
};

// Locations of ** that fail to render bold, with fix suggestions. startLine is the line number of text's first line.
// Code blocks, inline code, HTML lines and leading frontmatter are skipped. Bold spanning lines is handled per block (paragraph, list, quote, ...).
export function boldProblems(
  text: unknown,
  { startLine = 1, skipFrontmatter = true }: { startLine?: number; skipFrontmatter?: boolean } = {},
): BoldProblem[] {
  const lines = String(text).split('\n');
  let start = 0;
  if (skipFrontmatter && lines[0]?.replace(/\r$/, '') === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.replace(/\r$/, '') === '---');
    if (end !== -1) start = end + 1;
  }
  type NumberedLine = [lineNo: number, text: string];
  const blocks: NumberedLine[][] = [];
  let cur: NumberedLine[] = [];
  let fence: [char: string, length: number] | null = null;
  let curDepth = 0;
  let inTable = false;
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
    curDepth = 0;
    inTable = false;
  };
  for (let no = start; no < lines.length; no++) {
    const line = lines[no].replace(/\r$/, '');
    const lineNo = no + 1;
    const { isList, depth, content } = lineContainers(line);
    const m = content.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence[1] && !m[2].trim()) fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      flush();
      fence = [m[1][0], m[1].length];
      continue;
    }
    if (!content.trim() || content.trimStart().startsWith('<')) {
      flush();
      continue;
    }
    if (/^\s{0,3}(?:(\*)\s*(?:\1\s*){2,}|(-)\s*(?:\2\s*){2,}|(_)\s*(?:\3\s*){2,})\s*$/.test(content)) {
      flush();
      continue;
    }
    // GFM table delimiter row (including ones without outer |). The previous line becomes its own block as the header row.
    if (/^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(content)) {
      const hdr = cur.pop();
      if (hdr) {
        flush();
        blocks.push([hdr]);
      } else {
        flush();
      }
      inTable = true;
      continue;
    }
    if (cur.length && /^\s{0,3}(=+|-+)\s*$/.test(content)) {
      flush();
      continue;
    }
    if (/^\s{0,3}#{1,6}(\s+|$)/.test(content)) {
      flush();
      blocks.push([[lineNo, line]]);
      continue;
    }
    if (content.startsWith('|') || (inTable && content.includes('|'))) {
      flush();
      blocks.push([[lineNo, line]]);
      inTable = true;
      continue;
    }
    inTable = false;
    if (isList || /^\s{0,3}(?:[*+-]|\d+[.)])\s+/.test(content)) {
      flush();
      curDepth = depth;
      cur.push([lineNo, line]);
      continue;
    }
    // Split when the quote depth changes (a depth-0 line right after a quote counts as a continuation).
    if (cur.length && depth !== curDepth && !(curDepth > 0 && depth === 0)) {
      flush();
      curDepth = depth;
    }
    if (!cur.length) curDepth = depth;
    cur.push([lineNo, line]);
  }
  flush();

  const out: BoldProblem[] = [];
  for (const block of blocks) {
    const blockText = block.map(([, l]) => l).join('\n');
    const offsets = [0];
    for (const [, l] of block.slice(0, -1)) offsets.push((offsets.at(-1) ?? 0) + l.length + 1);
    const lineOf = (idx: number): number => block[offsets.findLastIndex((o) => o <= idx)][0];
    boldPairs(blockText).forEach(([i, j], k) => {
      if (pairOk(blockText, i, j)) return;
      const { middle, how } = boldFix(blockText, i, j, k);
      const pre = Array.from(blockText.slice(0, i)).slice(-4).join('');
      const post = Array.from(blockText.slice(j + 2)).slice(0, 4).join('');
      out.push({
        line: lineOf(i) + startLine - 1,
        found: pre + short(blockText.slice(i, j + 2)) + post,
        suggest: middle === null ? '' : pre + short(middle) + post,
        how,
      });
    });
  }
  return out;
}

// Warnings are printed on one line, so newlines inside multi-line bold are shown as ↵.
const oneLine = (s: string): string => s.replace(/\n/g, '↵');

export function checkBold(text: string, startLine: number): LintWarning[] {
  return boldProblems(text, { startLine, skipFrontmatter: false }).map((p) => warn(
    p.line, 'bold-not-rendered', `太字の印（**）が記号に接していて、太字にならず ** がそのまま表示されます：「${oneLine(p.found)}」`,
    p.suggest ? `${p.how}：「${oneLine(p.suggest)}」` : p.how, 'error',
  ));
}
