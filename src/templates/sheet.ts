// sheet: drawing board. Panels with letter IDs are laid out on a grid. The blueprint theme adds coordinate rulers to the frame (decoration only).
import { panelHtml, headHtml } from './panel.ts';
import type { TemplateInput } from './panel.ts';
import type { Attrs } from '../parse.ts';

const ruler = (side: string, labels: ReadonlyArray<string | number>): string =>
  `<div class="am-ruler am-ruler--${side}" aria-hidden="true">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;

// Simulate the grid in reading order. When the next panel does not fit in the columns left after a panel, widen that panel to fill the row so no gap remains.
// Panels that span several rows make row filling complex, so the author's layout is used as is.
export function fillRows(panels: ReadonlyArray<{ attrs: Attrs }>, cols: number): number[] {
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

export function sheet({ meta, introHtml, panels }: TemplateInput): string {
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
