// SVG 断片を作る共通ツール：数値の整形、なめらかな折れ線、矢印の marker、複数行の文字。
import { esc } from './text.ts';

export const f = (n) => String(Math.round(n * 10) / 10);

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 各折れ点の中点を通る 2 次曲線。両端は直線で、角はなめらかにする。
export function smoothPath(points) {
  const [first, ...rest] = points;
  if (rest.length === 1) return `M${f(first.x)},${f(first.y)} L${f(rest[0].x)},${f(rest[0].y)}`;
  const parts = [`M${f(first.x)},${f(first.y)}`];
  const m0 = mid(points[0], points[1]);
  parts.push(`L${f(m0.x)},${f(m0.y)}`);
  for (let i = 1; i < points.length - 1; i++) {
    const m = mid(points[i], points[i + 1]);
    parts.push(`Q${f(points[i].x)},${f(points[i].y)} ${f(m.x)},${f(m.y)}`);
  }
  const last = points.at(-1);
  parts.push(`L${f(last.x)},${f(last.y)}`);
  return parts.join(' ');
}

export function arrowDefs(uid) {
  return `<defs><marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="am-arrow" d="M0,0 L10,5 L0,10 z"/></marker></defs>`;
}

// (cx, cy) を中心に、複数行の文字を上下中央にそろえて並べる。
export function textLines(lines, cx, cy, lineHeight, attrs = '') {
  const top = cy - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map((line, i) => `<text x="${f(cx)}" y="${f(top + i * lineHeight)}" text-anchor="middle" dominant-baseline="central"${attrs}>${esc(line)}</text>`)
    .join('');
}

export function svgOpen(width, height, label) {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`;
}
