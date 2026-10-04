// Prose checks that apply the ideas of STE (Simplified Technical English) to Japanese. Only the manuscript's prose is checked.
// Rules: sentence length, sentences per paragraph, verbose verb phrases, hedging, emphasis/exaggeration, and chains of 「の」.
// All are warnings; strictness is set by style.
// Also checks patterns common in AI-written Japanese (rules ported from yomiyasu; see yomiyasu.ts). info findings do not
// block generation even with strict.
// Skipped: code and inline code, ~~strikethrough~~ (bad examples), table rows with status no, headings, components other than callout.

import { JA_VERBOSE, JA_HEDGES, JA_EMPHASIS } from './wordlist.ja.ts';
import { checkLine, checkEmoji, checkHeading, checkSentenceEnds, checkMetrics, checkBold } from './yomiyasu.ts';
import type { LintWarning, Sentence, TextMetrics } from './yomiyasu.ts';
import type { Block, ParsedDoc } from '../parse.ts';
import { isCJK } from '../svg/text.ts';

export type { LintRule, LintWarning, Severity } from './yomiyasu.ts';

/** Sentence kind; procedural (numbered list items) has a stricter length limit. */
export type SentenceKind = 'procedural' | 'descriptive';

/** A lexical finding before the line number is attached; `index` orders findings within a unit. */
type LexicalFinding = Omit<LintWarning, 'line' | 'severity'> & { index: number };

interface LintContext {
  sentences: Sentence[];
  metrics: TextMetrics;
}

export const LIMITS: Readonly<Record<SentenceKind, number>> = Object.freeze({ procedural: 35, descriptive: 45 });
export const MAX_SENTENCES = 6;
const NO_CHAIN_MIN = 3; // warn on 3 or more 「の」 (A の B の C の D)

const PUNCT = /[，。！？；：、（）「」『』“”‘’《》【】・…〜\u3000]/;
const WORD = /[A-Za-z0-9_][\w'’./-]*/g;
// One element of a noun phrase: a run of characters without whitespace, punctuation, brackets or common particles.
const ELEMENT_CHAR = '[^\\s、。，．！？「」『』（）()\\[\\]・:：,.をはがにでへもやとの]';
const ELEMENT = `${ELEMENT_CHAR}+`;
// The lookbehind starts a match only at the first character of an element. Without it, a long run without 「の」 was retried from every position.
const NO_CHAIN = new RegExp(`(?<!${ELEMENT_CHAR})(?:${ELEMENT}の){${NO_CHAIN_MIN},}${ELEMENT}`, 'g');
const NOUN_BEFORE = /([一-鿿゠-ヿ々A-Za-z0-9]+)$/;
const GUESS = /推測[：:]/;
const EMPHASIS_RE = JA_EMPHASIS.map((e) => ({
  ...e,
  // 「大変更」「大変化」「大変動」 are not exaggeration, so exclude them.
  re: new RegExp(e.word === '大変' ? '大変(?![更化動])' : e.word, 'g'),
}));

// Splits text into sentences on 。！？ (closing brackets stay with the preceding sentence). Callers split on newlines by passing one line at a time.
export function splitSentences(text: unknown): string[] {
  const parts = String(text).match(/[^。！？]+(?:[。！？]+[」』）)]*|$)|[。！？]+/g) ?? [];
  return parts.map((s) => s.trim()).filter((s) => s && !/^[。！？」』）)]+$/.test(s));
}

// Sentence length: each full-width character (excluding punctuation) counts as 1, and each English word, number or identifier counts as 1.
export function sentenceLength(sentence: string): number {
  const cjk = [...sentence].filter((c) => isCJK(c) && !PUNCT.test(c)).length;
  const words = sentence.match(WORD)?.length ?? 0;
  return cjk + words;
}

export function formatWarning(w: Omit<LintWarning, 'suggestion'> & { suggestion?: string }): string {
  return `L${w.line} [${w.rule}]${w.severity === 'info' ? '（参考）' : ''} ${w.message}${w.suggestion ? ` → ${w.suggestion}` : ''}`;
}

// Warnings that block generation with style: strict (excluding info).
export const blockingWarnings = (warnings: readonly LintWarning[]): LintWarning[] => warnings.filter((w) => w.severity !== 'info');

export function lintDoc(doc: ParsedDoc): LintWarning[] {
  const warnings: LintWarning[] = [];
  // Aggregates for document-wide rules (sentence-end repetition, bold and list frequency).
  const ctx: LintContext = { sentences: [], metrics: { chars: 0, lines: 0, listLines: 0, bold: 0 } };
  const lintBlocks = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.type !== 'md' && b.lang !== 'callout') continue;
      const start = b.type === 'md' ? b.line : b.line + 1;
      lintMarkdown(b.text, start, warnings, ctx);
      warnings.push(...checkBold(b.text, start));
    }
  };
  if (doc.titleLine) {
    warnings.push(...checkEmoji(doc.meta.title, doc.titleLine), ...checkHeading(doc.meta.title, doc.titleLine));
    countPlain(`# ${doc.meta.title}`, ctx.metrics);
  }
  lintBlocks(doc.intro);
  for (const p of doc.panels) {
    warnings.push(...checkEmoji(p.title, p.line), ...checkHeading(p.title, p.line));
    countPlain(`## ${p.title}`, ctx.metrics);
    lintBlocks(p.blocks);
  }
  warnings.push(...checkSentenceEnds(ctx.sentences), ...checkMetrics(ctx.metrics));
  // Sort by line number (within a line, keep the order in which checks ran).
  return warnings.map((w, i) => [w, i] as const).sort((a, b) => a[0].line - b[0].line || a[1] - b[1]).map(([w]) => w);
}

// Counts for bold and list frequency (yomiyasu's analyze_markdown_metrics). Quote, table, image and HTML lines are not counted.
function countPlain(raw: string, m: TextMetrics): void {
  const t = raw.trim();
  if (/^(>|\||!\[|\[!\[|<)/.test(t)) return;
  if (t) m.lines++;
  if (/^\s*([-*+]|\d+\.)\s+/.test(raw) && !/[-*+]\s+\[.*?\]\(https?:\/\//.test(raw)) m.listLines++;
  m.bold += raw.match(/\*\*[^*]+\*\*/g)?.length ?? 0;
  m.chars += Array.from(raw.replace(/\s+/g, '')).length;
}

// Collects body sentences for the sentence-end repetition check (yomiyasu's extract_plain_sentences).
// Heading, table, quote, list and indented lines are skipped.
function collectSentences(raw: string, line: number, ctx: LintContext): void {
  const t = raw.trim();
  if (!t || /^(#|\||!\[|\[!\[|<|>)/.test(t) || /^[-*+]\s|^\d+\.\s/.test(t) || /^( {2}|\t)/.test(raw)) return;
  for (const s of t.split(/(?<=[。！？])/)) {
    const text = s.trim();
    if (Array.from(text).length > 3) ctx.sentences.push({ line, text });
  }
}

function clean(text: string): string {
  return text
    .replace(/~~[^~]*~~/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_]{1,3}/g, '');
}

function lintMarkdown(text: string, startLine: number, out: LintWarning[], ctx: LintContext): void {
  let para: { line: number; count: number } | null = null;
  const flush = () => {
    if (para && para.count > MAX_SENTENCES) {
      out.push({ line: para.line, rule: 'paragraph-length', message: `段落が ${para.count} 文あります（上限 ${MAX_SENTENCES}）`, suggestion: '段落を分けるか、リストにする' });
    }
    para = null;
  };
  let inHtml = false;
  text.split('\n').forEach((raw, i) => {
    const line = startLine + i;
    const t = raw.trim();
    if (/^<(div|svg|table|details|figure)/i.test(t)) inHtml = true;
    if (inHtml) {
      if (/<\/(div|svg|table|details|figure)>\s*$/i.test(t)) inHtml = false;
      return flush();
    }
    if (t) out.push(...checkEmoji(t, line));
    countPlain(raw, ctx.metrics);
    collectSentences(raw, line, ctx);
    if (/^#{1,6}\s/.test(t)) out.push(...checkHeading(t, line));
    if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t)) return flush();
    if (/^(!\[|\[!\[|<)/.test(t)) return flush();
    const guess = GUESS.test(t);
    if (t.startsWith('|')) {
      flush();
      if (/^\|?[\s:|-]+\|?$/.test(t)) return;
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.some((c) => /^(no|✗|✘)(\s|$)/.test(c))) return;
      cells.forEach((c) => {
        const cell = clean(c.replace(/^(ok|warn|✓|✔|⚠)(\s|$)/, ''));
        checkUnit(cell, line, 'descriptive', guess, out);
        out.push(...checkLine(cell, line));
      });
      return;
    }
    const list = t.match(/^(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (list) {
      flush();
      const item = clean(list[3]);
      checkUnit(item, line, list[2] ? 'procedural' : 'descriptive', guess, out);
      out.push(...checkLine(item, line));
      return;
    }
    const body = clean(t.replace(/^>\s*/, ''));
    const n = checkUnit(body, line, 'descriptive', guess, out);
    out.push(...checkLine(body, line));
    if (!para) para = { line, count: 0 };
    para.count += n;
  });
  flush();
}

const preview = (s: string): string => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

// Checks one unit of text (a list item, a cell, or one line of a paragraph) and returns its sentence count.
function checkUnit(text: string, line: number, kind: SentenceKind, guess: boolean, out: LintWarning[]): number {
  const sentences = splitSentences(text);
  for (const s of sentences) {
    const count = sentenceLength(s);
    const limit = LIMITS[kind];
    if (count > limit) {
      out.push({ line, rule: 'sentence-length', message: `${kind === 'procedural' ? '手順の文' : '文'}が ${count} 字です（上限 ${limit}）：「${preview(s)}」`, suggestion: '文を分ける' });
    }
  }
  const lexical = [...verbose(text), ...(guess ? [] : hedges(text)), ...emphasis(text)];
  out.push(...lexical.sort((a, b) => a.index - b.index).map(({ index, ...w }) => ({ line, ...w })));
  for (const m of text.matchAll(NO_CHAIN)) {
    const n = (m[0].match(/の/g) ?? []).length;
    out.push({ line, rule: 'no-chain', message: `「の」が ${n} 回続いています：「${preview(m[0])}」`, suggestion: '「の」を減らすか、文を分ける' });
  }
  return sentences.length;
}

// Verbose verb phrases. Longer phrases are matched first; matches overlapping an already matched range are not counted.
function verbose(text: string): LexicalFinding[] {
  const taken: [start: number, end: number][] = [];
  const found: LexicalFinding[] = [];
  for (const { re, label, fix } of JA_VERBOSE) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      const noun = text.slice(0, start).match(NOUN_BEFORE)?.[1] ?? '';
      found.push({ index: start, rule: 'verbose', message: `冗長な表現「${noun}${m[0]}」（${label}）`, suggestion: fix(noun) });
    }
  }
  return found;
}

function hedges(text: string): LexicalFinding[] {
  return JA_HEDGES.flatMap(({ re, label }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'hedge', message: `ぼかし表現「${m[0]}」（${label}）`, suggestion: '言い切るか根拠を書く。推測なら行に「推測：」と書く',
  })));
}

function emphasis(text: string): LexicalFinding[] {
  return EMPHASIS_RE.flatMap(({ re, word, fix }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'emphasis', message: `強調・誇張「${word}」`, suggestion: fix,
  })));
}
