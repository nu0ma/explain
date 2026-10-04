// STE（Simplified Technical English）の考え方を日本語に当てはめた文章検査。原稿の説明文だけを対象にする。
// 規則：文の長さ、段落の文の数、冗長な動詞句、ぼかし表現、強調・誇張、「の」の連続。すべて警告で、厳しさは style で決める。
// AI が書いた日本語に多い語・比喩の動詞・定型句・絵文字も警告する（一覧は yomiyasu から移植。wordlist.yomiyasu.js）。
// 対象外：コードとインラインコード、~~取り消し線~~（悪い例の提示）、状態が no の表の行、見出し、callout 以外の部品。

import { JA_VERBOSE, JA_HEDGES, JA_EMPHASIS } from './wordlist.ja.js';
import { JA_SLOP_WORDS, JA_METAPHOR_VERBS, JA_FILLERS, EMOJI } from './wordlist.yomiyasu.js';
import { isCJK } from '../svg/text.js';

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
  return `L${w.line} [${w.rule}] ${w.message}${w.suggestion ? ` → ${w.suggestion}` : ''}`;
}

export function lintDoc(doc) {
  const warnings = [];
  const blocks = [...doc.intro, ...doc.panels.flatMap((p) => p.blocks)];
  for (const b of blocks) {
    if (b.type === 'md') lintMarkdown(b.text, b.line, warnings);
    else if (b.lang === 'callout') lintMarkdown(b.text, b.line + 1, warnings);
  }
  return warnings;
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

function lintMarkdown(text, startLine, out) {
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
    if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t)) return flush();
    const guess = GUESS.test(t);
    if (t.startsWith('|')) {
      flush();
      if (/^\|?[\s:|-]+\|?$/.test(t)) return;
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.some((c) => /^(no|✗|✘)(\s|$)/.test(c))) return;
      cells.forEach((c) => checkUnit(clean(c.replace(/^(ok|warn|✓|✔|⚠)(\s|$)/, '')), line, 'descriptive', guess, out));
      return;
    }
    const list = t.match(/^(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (list) {
      flush();
      checkUnit(clean(list[3]), line, list[2] ? 'procedural' : 'descriptive', guess, out);
      return;
    }
    const body = clean(t.replace(/^>\s*/, ''));
    const n = checkUnit(body, line, 'descriptive', guess, out);
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
  const lexical = [...verbose(text), ...(guess ? [] : hedges(text)), ...emphasis(text), ...aiStyle(text, sentences)];
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

// AI が書いた日本語に多い表現。定型句は文の頭か終わりにあるときだけ数える。
function aiStyle(text, sentences) {
  const words = JA_SLOP_WORDS.flatMap(({ re, label }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'slop-word', message: `AI の文章に多い語「${label}」`, suggestion: '文字どおりの意味でなければ、ふだんの言葉に置き換える',
  })));
  const verbs = JA_METAPHOR_VERBS.flatMap(({ re, label }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'metaphor-verb', message: `比喩の動詞「${m[0]}」（${label}）`, suggestion: '何が起きるかを、ふだんの動詞で書く',
  })));
  let offset = 0;
  const fillers = sentences.flatMap((s) => {
    const at = text.indexOf(s, offset);
    offset = at + s.length;
    return JA_FILLERS.filter(({ re }) => re.test(s)).map(({ label }) => ({
      index: at, rule: 'filler', message: `定型の前置き・締め「${label}」：「${preview(s)}」`, suggestion: '削って本題から書く',
    }));
  });
  const emoji = [...text.matchAll(EMOJI)].map((m) => ({
    index: m.index, rule: 'emoji', message: `絵文字「${m[0]}」`, suggestion: '削るか、言葉で書く',
  }));
  return [...words, ...verbs, ...fillers, ...emoji];
}

function emphasis(text) {
  return EMPHASIS_RE.flatMap(({ re, word, fix }) => [...text.matchAll(re)].map((m) => ({
    index: m.index, rule: 'emphasis', message: `強調・誇張「${word}」`, suggestion: fix,
  })));
}
