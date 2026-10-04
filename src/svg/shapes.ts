// Shared helpers for SVG fragments: number formatting, smooth polylines, arrow markers, multi-line text.
import { esc } from './text.ts';

export type Point = { x: number; y: number };

export const f = (n: number): string => String(Math.round(n * 10) / 10);

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Quadratic curves through the midpoints of each segment. The ends are straight and the corners are smooth.
export function smoothPath(points: readonly Point[]): string {
  const [first, ...rest] = points;
  if (rest.length === 1) return `M${f(first.x)},${f(first.y)} L${f(rest[0].x)},${f(rest[0].y)}`;
  const parts = [`M${f(first.x)},${f(first.y)}`];
  const m0 = mid(points[0], points[1]);
  parts.push(`L${f(m0.x)},${f(m0.y)}`);
  for (let i = 1; i < points.length - 1; i++) {
    const m = mid(points[i], points[i + 1]);
    parts.push(`Q${f(points[i].x)},${f(points[i].y)} ${f(m.x)},${f(m.y)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L${f(last.x)},${f(last.y)}`);
  return parts.join(' ');
}

export function arrowDefs(uid: string): string {
  return `<defs><marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="am-arrow" d="M0,0 L10,5 L0,10 z"/></marker></defs>`;
}

// Lay out multi-line text centered vertically around (cx, cy).
export function textLines(lines: readonly string[], cx: number, cy: number, lineHeight: number, attrs = ''): string {
  const top = cy - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map((line, i) => `<text x="${f(cx)}" y="${f(top + i * lineHeight)}" text-anchor="middle" dominant-baseline="central"${attrs}>${esc(line)}</text>`)
    .join('');
}

export function svgOpen(width: number, height: number, label: string): string {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`;
}
