// Limit bars: the fill is the current value (or the limit itself when there is none) and the vertical line is the limit. Over the limit turns red. Bar length is proportional to the value, and the scale starts at 0 with no break.
import { esc } from '../svg/text.ts';
import { ComponentError, contentLines, fields } from './error.ts';
import type { Component } from './types.ts';

type LimitRow = { label: string; value: number | null; limit: number; unit: string; note: string };

const NICE_MAX = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const NICE_STEP = [1, 2, 2.5, 5, 10];

export function niceScale(peak: number): { max: number; step: number } {
  const target = peak * 1.4;
  const pow = 10 ** Math.floor(Math.log10(target));
  const integral = Number.isInteger(peak);
  const nice = NICE_MAX.map((m) => m * pow).find((m) => m >= target - 1e-9) ?? 10 * pow;
  const max = integral ? Math.ceil(nice) : nice;
  const stepPow = 10 ** Math.floor(Math.log10(max));
  const step = [...NICE_STEP.map((s) => (s * stepPow) / 10), ...NICE_STEP.map((s) => s * stepPow)]
    .find((s) => max / s <= 7 && Number.isInteger(round(max / s)) && (integral ? s >= 1 : true)) ?? max;
  return { max: round(max), step: round(step) };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const pct = (v: number, max: number): string => `${Math.round((v / max) * 10000) / 100}%`;
const NUM = /^(?:max\s+)?(-?\d+(?:\.\d+)?)$/i;

export default {
  name: 'limits',
  summary: '値と上限を比べる棒グラフ',
  syntax: `\`\`\`limits
ラベル | 現在値 / 上限 | 単位（省略可） | 備考（省略可）
ラベル | 上限 | 単位          ← 上限だけなら上限まで塗る
\`\`\`
- 現在値が上限を超えると行全体が赤くなる。上限は "max 20" とも書ける。`,
  example: '```limits\n手順の文 | 28 / 35 | 字\n説明の文 | max 45 | 字\n1 段落の文 | 8 / 6 | 文 | 超過\n```',
  render(text) {
    const rows = contentLines(text).map(({ text: t, line }) => parseRow(t, line));
    if (!rows.length) throw new ComponentError('limits には 1 行以上必要です', 1);
    return `<div class="am-limits">${rows.map(rowHtml).join('')}</div>`;
  },
} satisfies Component;

function parseRow(t: string, line: number): LimitRow {
  const [label, spec = '', unit = '', note = ''] = fields(t);
  const [a, b] = spec.split('/').map((s) => s.trim());
  const nums = (b === undefined ? [a] : [a, b]).map((s) => s?.match(NUM)?.[1]);
  const [n0, n1] = nums;
  if (!spec || n0 === undefined || (b !== undefined && n1 === undefined)) {
    throw new ComponentError(`limits の行は ラベル | 現在値 / 上限 | 単位 の形で書いてください："${t}"`, line);
  }
  const [value, limit] = n1 === undefined ? [null, Number(n0)] : [Number(n0), Number(n1)];
  return { label, value, limit, unit, note };
}

function rowHtml({ label, value, limit, unit, note }: LimitRow): string {
  const { max, step } = niceScale(Math.max(limit, value ?? 0));
  const shown = value ?? limit;
  const over = value !== null && value > limit;
  const valText = `${value !== null ? `${value} / ` : ''}max ${limit}${unit ? ` ${unit}` : ''}`;
  const ticks: string[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(`<span style="left: ${pct(round(v), max)}">${round(v)}</span>`);
  return `<div class="am-lim${over ? ' is-over' : ''}">
<div class="am-lim-head"><span>${esc(label)}${note ? `<span class="am-lim-note">${esc(note)}</span>` : ''}</span><span class="am-lim-val">${esc(valText)}</span></div>
<div class="am-lim-track"><div class="am-lim-fill" style="width: ${pct(shown, max)}"></div><div class="am-lim-mark" style="left: ${pct(limit, max)}"></div></div>
<div class="am-lim-ticks" aria-hidden="true">${ticks.join('')}</div>
</div>`;
}
