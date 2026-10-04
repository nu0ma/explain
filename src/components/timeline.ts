import { mdInline } from '../markdown.ts';
import { esc } from '../svg/text.ts';
import { ComponentError, contentLines, fields } from './error.ts';
import type { Component } from './types.ts';

type TimelineItem = { when: string; title: string; detail: string; hi: boolean };

export default {
  name: 'timeline',
  summary: '時系列・段階の移り変わり',
  syntax: `\`\`\`timeline [h|v]
時期 | 見出し | 説明（省略可）
*時期 | 見出し        ← * で始めるとその項目を強調する
\`\`\`
- 6 項目以下は横、7 項目以上は縦に並べる。引数 h / v で向きを固定できる。`,
  example: '```timeline\n4/1 | 設計レビュー\n4/8 | 実装\n*4/15 | リリース | 本番に反映\n```',
  tips: `- 障害の経緯やリリースの段階のように、時間の順に意味があるものに使う。
- 日付と時刻は入力にある値を使う。分からない時期は書かない。
- 読者に見てほしい転機の項目に*を付ける。`,
  render(text, { args }) {
    const items = contentLines(text).map(({ text: t, line }): TimelineItem => {
      const parts = fields(t);
      if (parts.length < 2 || !parts[1]) throw new ComponentError(`timeline の行は 時期 | 見出し | 説明 の形で書いてください："${t}"`, line);
      const hi = parts[0].startsWith('*');
      return { when: hi ? parts[0].slice(1).trim() : parts[0], title: parts[1], detail: parts[2] ?? '', hi };
    });
    if (!items.length) throw new ComponentError('timeline には 1 項目以上必要です', 1);
    const vertical = /\bv(ertical)?\b/.test(args) || (!/\bh(orizontal)?\b/.test(args) && items.length > 6);
    const lis = items.map((it) => `<li class="am-tl-item${it.hi ? ' am-tl-item--hi' : ''}"><span class="am-tl-when">${esc(it.when)}</span><span class="am-tl-dot"></span><span class="am-tl-title">${mdInline(it.title)}</span>${it.detail ? `<span class="am-tl-text">${mdInline(it.detail)}</span>` : ''}</li>`);
    return vertical
      ? `<ol class="am-timeline am-timeline--v">${lis.join('')}</ol>`
      : `<ol class="am-timeline am-timeline--h" style="--n: ${items.length}">${lis.join('')}</ol>`;
  },
} satisfies Component;
