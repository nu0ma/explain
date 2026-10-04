// doc: single-column explainer, read top to bottom. With 3 or more panels, a table of contents appears on the left.
import { panelHtml, headHtml } from './panel.ts';
import type { TemplateInput } from './panel.ts';
import { esc } from '../svg/text.ts';

export function doc({ meta, introHtml, panels }: TemplateInput): string {
  const withToc = panels.length >= 3;
  const toc = withToc
    ? `<nav class="am-toc" aria-label="目次">${panels.map((p) => `<a href="#panel-${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</a>`).join('')}</nav>`
    : '';
  return `<main class="am-doc">
${headHtml(meta, introHtml)}
<div class="am-doc-layout${withToc ? '' : ' am-doc-layout--notoc'}">
${toc}<div class="am-doc-body">
${panels.map((p) => panelHtml(p, { grid: false })).join('\n')}
</div>
</div>
</main>`;
}
