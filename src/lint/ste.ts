// STE（Simplified Technical English）の考え方を日本語に当てはめた文章検査。原稿の説明文だけを対象にする。
// 規則：文の長さ、段落の文の数、冗長な動詞句、ぼかし表現、強調・誇張、「の」の連続。すべて警告で、厳しさは style で決める。
// AI が書いた日本語に多い書き方も検査する（yomiyasu から移植した規則。yomiyasu.js）。info の指摘は strict でも生成を止めない。
// 対象外：コードとインラインコード、~~取り消し線~~（悪い例の提示）、状態が no の表の行、見出し、callout 以外の部品。

import { JA_VERBOSE, JA_HEDGES, JA_EMPHASIS } from './wordlist.ja.ts';
import { checkLine, checkEmoji, checkHeading, checkSentenceEnds, checkMetrics, checkBold } from './yomiyasu.ts';
import { isCJK } from '../svg/text.ts';

export const LIMITS = Object.freeze({ procedural: 35, descriptive: 45 });
export const MAX_SENTENCES = 6;
const NO_CHAIN_MIN = 3; // 「の」が 3 回（A の B の C の D）以上で警告する

const PUNCT = /[，。！？；：、（）「」『』“”‘’《》【】・…〜\u3000]/;
const WORD = /[A-Za-z0-9_][\w'’./-]*/g;
// 名詞句の 1 要素：空白・句読点・括弧・主な助詞を含まない文字の並び。
const ELEMENT = '[^\\s、。，．！？「」『』（）()\\[\\]・:：,.をはがにでへもやとの]+';
const NO_CHAIN = new RegExp(`(?:${ELEMENT}の){${NO_CHAIN_MIN},}${ELEMENT}`, 'g');
const NOUN_BEFORE = /([一-鿿゠-ヿ々A-Za-z0-9]+)$/;
const GUESS = /推測[：:]/;
const EMPHASIS_RE = JA_EMPHASIS.map((e) => ({
  ...e,
  // 「大変更」「大変化」「大変動」は誇張ではないので除く。
  re: new RegExp(e.word === '大変' ? '大変(?![更化動])' : e.word, 'g'),
}));

// 文に分ける。区切りは「。！？」（閉じ括弧は前の文に含める）。改行での区切りは呼び出し側が行ごとに渡して実現する。
export function splitSentences(text) {
  const parts = String(text).match(/[^。！？]+(?:[。！？]+[」』）)]*|$)|[。！？]+/g) ?? [];
  return parts.map((s) => s.trim()).filter((s) => s && !/^[。！？」』）)]+$/.test(s));
}

// 文の長さ。全角文字は句読点を除いて 1 字、英単語・数字・識別子は 1 語を 1 字と数える。
export function sentenceLength(sentence) {
  const cjk = [...sentence].filter((c) => isCJK(c) && !PUNCT.test(c)).length;
  const words = sentence.match(WORD)?.length ?? 0;
  return cjk + words;
}

export function formatWarning(w) {
  return `L${w.line} [${w.rule}]${w.severity === 'info' ? '（参考）' : ''} ${w.message}${w.suggestion ? ` → ${w.suggestion}` : ''}`;
}

// style: strict で生成を止める警告（参考の info は除く）。
export const blockingWarnings = (warnings) => warnings.filter((w) => w.severity !== 'info');

export function lintDoc(doc) {
  const warnings = [];
  // 文書全体で見る規則（文末の繰り返し、太字と箇条書きの頻度）のための集計。
  const ctx = { sentences: [], metrics: { chars: 0, lines: 0, listLines: 0, bold: 0 } };
  const lintBlocks = (blocks) => {
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
  // 行番号の順に並べる（同じ行の中は検査した順のまま）。
  return warnings.map((w, i) => [w, i]).sort((a, b) => a[0].line - b[0].line || a[1] - b[1]).map(([w]) => w);
}

// 太字と箇条書きの頻度の集計（yomiyasu の analyze_markdown_metrics）。引用・表・画像・HTML の行は数えない。
function countPlain(raw, m) {
  const t = raw.trim();
  if (/^(>|\||!\[|\[!\[|<)/.test(t)) return;
  if (t) m.lines++;
  if (/^\s*([-*+]|\d+\.)\s+/.test(raw) && !/[-*+]\s+\[.*?\]\(https?:\/\//.test(raw)) m.listLines++;
  m.bold += raw.match(/\*\*[^*]+\*\*/g)?.length ?? 0;
  m.chars += Array.from(raw.replace(/\s+/g, '')).length;
}

// 文末の繰り返しを見る地の文（yomiyasu の extract_plain_sentences）。見出し・表・引用・リスト・字下げの行は除く。
function collectSentences(raw, line, ctx) {
  const t = raw.trim();
  if (!t || /^(#|\||!\[|\[!\[|<|>)/.test(t) || /^[-*+]\s|^\d+\.\s/.test(t) || /^( {2}|\t)/.test(raw)) return;
  for (const s of t.split(/(?<=[。！？])/)) {
    const text = s.trim();
    if (Array.from(text).length > 3) ctx.sentences.push({ line, text });
  }
}

function clean(text) {
  return text
    .replace(/~~[^~]*~~/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_]{1,3}/g, '');
}

function lintMarkdown(text, startLine, out, ctx) {
  let para = null;
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

const preview = (s) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

// 1 単位の文字列（リスト項目・セル・段落の 1 行）を検査し、文の数を返す。
function checkUnit(text, line, kind, guess, out) {
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

// 冗長な動詞句。長い句から照合し、すでに照合した範囲と重なるものは数えない。
function verbose(text) {
  const taken = [];
  const found = [];
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

function hedges(text) {
  return JA_HEDGES.flatMap(({ re, label }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'hedge', message: `ぼかし表現「${m[0]}」（${label}）`, suggestion: '言い切るか根拠を書く。推測なら行に「推測：」と書く',
  })));
}

function emphasis(text) {
  return EMPHASIS_RE.flatMap(({ re, word, fix }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'emphasis', message: `強調・誇張「${word}」`, suggestion: fix,
  })));
}
