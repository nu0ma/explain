// Sentence annotations: set sentences in a monospace font and draw a bracket under each annotated part. Notes are staggered into rows by horizontal position so they do not overlap.
import { esc, measure } from '../svg/text.ts';
import { ComponentError, contentLines, fields } from './error.ts';
import type { Component } from './types.ts';

type AnnotGroup = { title: string; meta: string; lines: string[]; captions: string[] };
// Occupied [start, end] ranges per row.
type Rows = Array<Array<[number, number]>>;

const SEG = /\[([^\]]+)\]\{(!?)([^}]*)\}/g;
const TEXT_SIZE = 14;
const NOTE_SIZE = 11;
const NOTE_GAP = 10;

export default {
  name: 'annot',
  summary: '文の部分ごとの注釈（下線の括弧と注釈）',
  syntax: `\`\`\`annot
# 小見出し | 右側の補足（省略可）
文の本文、[注釈をつける部分]{注釈}、[誤りの部分]{!赤い注釈}。
> 下の説明（省略可）
\`\`\`
- # で 1 組を始める。1 組に複数の文を書ける。注釈が重なるときは自動で段をずらす。`,
  example: '```annot\n# 1 手順の文 | 18 字、上限 35\n[設定ファイル]{対象}を[開く]{!「開封する」は使わない}。\n> 1 文に 1 つの指示だけを書く\n```',
  render(text) {
    const groups: AnnotGroup[] = [];
    let group: AnnotGroup | null = null;
    const ensure = (): AnnotGroup => group ?? (group = pushGroup(groups, {}));
    for (const { text: t, line } of contentLines(text)) {
      if (t.startsWith('#')) {
        const [title, meta = ''] = fields(t.replace(/^#+\s*/, ''));
        group = pushGroup(groups, { title, meta });
      } else if (t.startsWith('>')) {
        ensure().captions.push(t.replace(/^>\s*/, ''));
      } else {
        ensure().lines.push(sentenceHtml(t, line));
      }
    }
    if (!groups.length) throw new ComponentError('annot には文が 1 つ以上必要です', 1);
    return groups.map(groupHtml).join('');
  },
} satisfies Component;

function pushGroup(groups: AnnotGroup[], { title = '', meta = '' }: { title?: string; meta?: string }): AnnotGroup {
  const g: AnnotGroup = { title, meta, lines: [], captions: [] };
  groups.push(g);
  return g;
}

function groupHtml(g: AnnotGroup): string {
  const head = g.title || g.meta
    ? `<div class="am-annot-head"><span>${esc(g.title)}</span>${g.meta ? `<span class="am-annot-meta">${esc(g.meta)}</span>` : ''}</div>`
    : '';
  const lines = g.lines.map((l) => `<div class="am-annot-scroll">${l}</div>`).join('');
  const caps = g.captions.map((c) => `<div class="am-annot-caption">${esc(c)}</div>`).join('');
  return `<div class="am-annot">${head}${lines}${caps}</div>`;
}

function sentenceHtml(sentence: string, line: number): string {
  const stripped = sentence.replace(SEG, '');
  if (/\[[^\]]*\]\{|\]\{[^}]*$/.test(stripped)) {
    throw new ComponentError(`annot の注釈が閉じていません。[部分]{注釈} の形で書いてください："${sentence}"`, line);
  }
  const rows: Rows = [];
  let out = '';
  let plain = '';
  let last = 0;
  for (const m of sentence.matchAll(SEG)) {
    const before = sentence.slice(last, m.index);
    out += esc(before);
    plain += before;
    const [, seg, bang, note] = m;
    const x = measure(plain, TEXT_SIZE, { mono: true });
    const noteHtml = note.trim()
      ? `<span class="am-seg-n" style="--row: ${placeNote(rows, x, x + measure(note, NOTE_SIZE) + NOTE_GAP)}">${esc(note.trim())}</span>`
      : '';
    out += `<span class="am-seg${bang ? ' am-seg--err' : ''}"><span class="am-seg-t">${esc(seg)}</span>${noteHtml}</span>`;
    plain += seg;
    last = m.index + m[0].length;
  }
  out += esc(sentence.slice(last));
  const wrapCls = rows.length ? '' : ' am-annot-line--wrap';
  return `<div class="am-annot-line${wrapCls}" style="--rows: ${rows.length}">${out}</div>`;
}

// Greedy placement: use the first row where the note does not overlap an existing one.
function placeNote(rows: Rows, start: number, end: number): number {
  const idx = rows.findIndex((ranges) => ranges.every(([s, e]) => end <= s || start >= e));
  if (idx !== -1) {
    rows[idx].push([start, end]);
    return idx;
  }
  rows.push([[start, end]]);
  return rows.length - 1;
}
