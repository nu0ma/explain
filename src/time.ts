// Date/time formats: "2026-10-04 13:40" on pages, "20261004-134012" in output file names, "13:40:12" in logs.

const pad = (n: number): string => String(n).padStart(2, '0');

function parts(d: Date) {
  return { y: d.getFullYear(), mo: pad(d.getMonth() + 1), da: pad(d.getDate()), h: pad(d.getHours()), mi: pad(d.getMinutes()), s: pad(d.getSeconds()) };
}

export function timestamp(d: Date = new Date()): string {
  const { y, mo, da, h, mi } = parts(d);
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

export function fileStamp(d: Date = new Date()): string {
  const { y, mo, da, h, mi, s } = parts(d);
  return `${y}${mo}${da}-${h}${mi}${s}`;
}

export function clock(d: Date = new Date()): string {
  const { h, mi, s } = parts(d);
  return `${h}:${mi}:${s}`;
}
