import { mdInline } from '../markdown.ts';
import { esc } from '../svg/text.ts';
import { ComponentError, contentLines } from './error.ts';
import { parseAttrs } from '../parse.ts';

export default {
  name: 'kv',
  summary: 'キーと値の表・表題欄（メタ情報）',
  syntax: `\`\`\`kv [cols=2]
キー: 値
* 幅広のキー: 値    ← * で始めると 1 行全体を使い、文字が大きくなる
\`\`\`
- 最初のコロン（: か ：）で分ける。値の中にはコロンを書いてよい。`,
  example: '```kv cols=2\n* Title: Simplified Technical English\nSpecification: ASD-STE100\nOwner: ASD\n```',
  render(text, { args }) {
    const cols = Math.max(1, Math.min(Number(parseAttrs(args).cols) || 2, 6));
    const cells = contentLines(text).map(({ text: t, line }) => {
      const wide = t.startsWith('*');
      const body = wide ? t.slice(1).trim() : t;
      const m = body.match(/^([^:：]+)[:：]\s*(.*)$/);
      if (!m) throw new ComponentError(`kv の行にコロンがありません："${t}"。キー: 値 の形で書いてください`, line);
      return `<div class="am-kv-cell${wide ? ' am-kv-cell--wide' : ''}"><dt>${esc(m[1].trim())}</dt><dd>${mdInline(m[2])}</dd></div>`;
    });
    if (!cells.length) throw new ComponentError('kv には キー: 値 の行が 1 行以上必要です', 1);
    return `<dl class="am-kv" style="--kv-cols: ${cols}">${cells.join('')}</dl>`;
  },
};
