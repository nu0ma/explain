// 部品の構文エラー。line はコードブロック内の相対行番号（1 始まり）。原稿の行番号への換算は render.js が行う。
export class ComponentError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.name = 'ComponentError';
    this.line = line;
  }
}

// コードブロックの本文を空でない行に分け、相対行番号を残す。// で始まる行はコメントとして飛ばす。
export function contentLines(text) {
  return String(text)
    .split('\n')
    .map((raw, i) => ({ raw, text: raw.trim(), line: i + 1 }))
    .filter((l) => l.text && !l.text.startsWith('//'));
}

// | で欄に分け、前後の空白を除く。
export function fields(text) {
  return text.split('|').map((s) => s.trim());
}
