// sheet：図面ボード。英字の番号つきパネルをグリッドに並べる。blueprint テーマでは外枠に座標の目盛りがつく（装飾のみ）。
import { panelHtml, headHtml } from './panel.js';

const ruler = (side, labels) =>
  `<div class="am-ruler am-ruler--${side}" aria-hidden="true">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;

// 読む順にグリッドをシミュレートする。あるパネルの後ろの残り列に次のパネルが入らないときは、そのパネルを広げて行を埋め、空きを残さない。
// rows で複数行にまたがるパネルがあると行の埋まり方が複雑になるので、作者の配置をそのまま使う。
export function fillRows(panels, cols) {
  const spans = panels.map((p) => Math.max(1, Math.min(Number(p.attrs.span) || 1, cols)));
  if (panels.some((p) => Number(p.attrs.rows) > 1)) return spans;
  let used = 0;
  return spans.map((span, i) => {
    if (used + span > cols) used = 0;
    used += span;
    const next = spans[i + 1];
    const fill = next === undefined || used + next > cols ? cols - used : 0;
    used = fill || used === cols ? 0 : used;
    return span + fill;
  });
}

export function sheet({ meta, introHtml, panels }) {
  const cols = Math.max(1, Math.min(Number(meta.cols) || 3, 12));
  const spans = fillRows(panels, cols);
  const placed = panels.map((p, i) => ({ ...p, attrs: { ...p.attrs, span: spans[i] } }));
  const nums = Array.from({ length: 8 }, (_, i) => i + 1);
  const letters = ['A', 'B', 'C', 'D'];
  return `<main class="am-sheet">
${headHtml(meta, introHtml)}
<div class="am-frame">
${ruler('top', nums)}${ruler('bottom', nums)}${ruler('left', letters)}${ruler('right', letters)}
<div class="am-grid" style="--cols: ${cols}">
${placed.map((p) => panelHtml(p, { cols })).join('\n')}
</div>
</div>
</main>`;
}
