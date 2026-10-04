// 上限バー：塗り = 現在値（なければ上限そのもの）、縦線 = 上限。上限を超えると赤くする。バーの長さは値に比例し、目盛りは 0 から始めて途中を省かない。
import { esc } from '../svg/text.js';
import { ComponentError, contentLines, fields } from './error.js';

const NICE_MAX = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const NICE_STEP = [1, 2, 2.5, 5, 10];

export function niceScale(peak) {
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

const round = (n) => Math.round(n * 1000) / 1000;
const pct = (v, max) => `${Math.round((v / max) * 10000) / 100}%`;
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
};

function parseRow(t, line) {
  const [label, spec = '', unit = '', note = ''] = fields(t);
  const [a, b] = spec.split('/').map((s) => s.trim());
  const nums = (b === undefined ? [a] : [a, b]).map((s) => s?.match(NUM)?.[1]);
  if (!spec || nums.some((n) => n === undefined)) {
    throw new ComponentError(`limits の行は ラベル | 現在値 / 上限 | 単位 の形で書いてください："${t}"`, line);
  }
  const [value, limit] = b === undefined ? [null, Number(nums[0])] : nums.map(Number);
  return { label, value, limit, unit, note };
}

function rowHtml({ label, value, limit, unit, note }) {
  const { max, step } = niceScale(Math.max(limit, value ?? 0));
  const shown = value ?? limit;
  const over = value !== null && value > limit;
  const valText = `${value !== null ? `${value} / ` : ''}max ${limit}${unit ? ` ${unit}` : ''}`;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(`<span style="left: ${pct(round(v), max)}">${round(v)}</span>`);
  return `<div class="am-lim${over ? ' is-over' : ''}">
<div class="am-lim-head"><span>${esc(label)}${note ? `<span class="am-lim-note">${esc(note)}</span>` : ''}</span><span class="am-lim-val">${esc(valText)}</span></div>
<div class="am-lim-track"><div class="am-lim-fill" style="width: ${pct(shown, max)}"></div><div class="am-lim-mark" style="left: ${pct(limit, max)}"></div></div>
<div class="am-lim-ticks" aria-hidden="true">${ticks.join('')}</div>
</div>`;
}
