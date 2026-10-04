// doc：1 段組の解説。上から順に読む。パネルが 3 枚以上なら左に目次を出す。
import { panelHtml, headHtml } from './panel.ts';
import { esc } from '../svg/text.ts';

export function doc({ meta, introHtml, panels }) {
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
