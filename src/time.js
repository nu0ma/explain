// 日時の表記：ページに出す「2026-10-04 13:40」、出力ファイル名の「20261004-134012」、ログの「13:40:12」。

const pad = (n) => String(n).padStart(2, '0');

function parts(d) {
  return { y: d.getFullYear(), mo: pad(d.getMonth() + 1), da: pad(d.getDate()), h: pad(d.getHours()), mi: pad(d.getMinutes()), s: pad(d.getSeconds()) };
}

export function timestamp(d = new Date()) {
  const { y, mo, da, h, mi } = parts(d);
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

export function fileStamp(d = new Date()) {
  const { y, mo, da, h, mi, s } = parts(d);
  return `${y}${mo}${da}-${h}${mi}${s}`;
}

export function clock(d = new Date()) {
  const { h, mi, s } = parts(d);
  return `${h}:${mi}:${s}`;
}
