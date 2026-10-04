// AI が書いた日本語に多い書き方の検査。yomiyasu（https://github.com/nanaism/yomiyasu）v1.0.5 の
// scripts/yomiyasu_lint.py の規則をすべて移植した。語と正規表現の一覧、太字が表示されるかの判定、
// 太字・箇条書きの頻度、文末の繰り返しの判定は元のスクリプトに合わせている。explain に合わせて変えたところ：
// - 検査する範囲は explain の STE 検査と同じにする。表のセルと引用（動画のナレーション）も見る。
//   コード、インラインコード、~~取り消し線~~、状態が no の表の行、HTML のブロックは見ない。
// - 絵文字から ✓ ✔ ✗ ✘ ⚠ を除く。explain では表の状態語（バッジ）の書き方として使う。
// - 重大度は yomiyasu のまま持つ。info（「AではなくB」）は style: strict でも生成を止めない。
//
// この一覧と判定には yomiyasu のライセンスが適用される：
//
// MIT License
//
// Copyright (c) 2026 nanaism
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// 絵文字（yomiyasu の EMOJI_PATTERN）。表の状態語に使う ✓ ✔ ✗ ✘ ⚠ は除く。
const EMOJI = new RegExp(
  '(?![\\u2713\\u2714\\u2717\\u2718\\u26A0])(?:'
  + '[\\u{1F600}-\\u{1F64F}]|[\\u{1F300}-\\u{1F5FF}]|[\\u{1F680}-\\u{1F6FF}]|[\\u{1F700}-\\u{1F77F}]'
  + '|[\\u{1F780}-\\u{1F7FF}]|[\\u{1F800}-\\u{1F8FF}]|[\\u{1F900}-\\u{1F9FF}]|[\\u{1FA00}-\\u{1FA6F}]'
  + '|[\\u{1FA70}-\\u{1FAFF}]|[\\u2600-\\u27BF]|[\\u2300-\\u23FF]|[\\u2B50-\\u2B55])',
  'gu',
);

// AI の文章に多い語（yomiyasu の SLOP_WORDS）。
export const SLOP_WORDS = Object.freeze([
  // 質感を装う疑似具体語
  '手触り', '肌感', '肌感覚', '体温', '温度感', '熱量', '血の通った', '泥臭い', '泥臭さ',
  // 認知・評価を装う語
  '解像度', '腹落ち', 'メンタルモデル', '本質的', '地に足のついた', '等身大',
  // 抽象比喩名詞
  '営み', '装置', '意思決定OS', '土台', '羅針盤', '起爆剤', '触媒',
  // 体験を大げさにする造語
  '真理', '虚飾', '境地', '美学', '深淵', '冷徹', '禁欲的', '優美', '極致', '宿命',
  // 2026 年に急に増えた語（文脈によるが要点検）
  '正本',
]);

// 比喩の動詞と、AI が好む動詞（yomiyasu の METAPHOR_VERB_PATTERNS）。
const KOWARERU = '比喩動詞「壊れる」';
const SILENTLY = '英語直訳「静かに壊れる (silently fail)」';
export const METAPHOR_VERBS = Object.freeze([
  { re: /(地味に|よく|じわじわ)効[かきくけいた]/, label: '比喩動詞「効く」の過剰使用' },
  { re: /(データ|仕様|設計|環境|ビルド|システム|秩序)が(静かに)?壊れ/, label: KOWARERU },
  { re: /静かに(壊れ|落ち|失敗|沈黙)/g, label: SILENTLY },
  { re: /黙って(無視|捨て|スキップ|破棄)/, label: '英語直訳「黙って無視される」' },
  { re: /側に倒[すしせ]/, label: '判断を方向で表現する「〜側に倒す」' },
  { re: /時間[をに]溶か[したす]/, label: '比喩動詞「時間を溶かす」' },
  { re: /(1つずつ|一つずつ)潰[していく]/, label: '比喩動詞「潰す」' },
  { re: /(実装|詳細|コード|設計|内部|仕組み|領域|本質)(に|まで|へ)踏み込[んむみま]/, label: '比喩動詞「踏み込む」' },
  { re: /動かしながら引き返[すし]/, label: '比喩動詞「引き返す」' },
  { re: /代わりに添え[るた]/, label: '比喩動詞「添える」' },
  { re: /(議論|意見|結論|方向性|価格|話題|検討)が[^。！？!?]*?収斂/, label: '比喩動詞「収斂する」' },
  { re: /した瞬間に?/, label: '英語直訳「〜した瞬間 (the moment ...)」' },
  { re: /(前提|基盤)が崩れ[るた]/, label: '抽象比喩「前提が崩れる」' },
  { re: /文化が醸成/, label: '非生物主語「文化が醸成される」' },
  { re: /プロセスが定着/, label: '非生物主語「プロセスが定着する」' },
  { re: /事例が残した/, label: '非生物主語「事例が残した」' },
]);

// 前置きと締めの定型句（yomiyasu の FILLER_PATTERNS）。行の頭か終わりで照合する。
export const FILLERS = Object.freeze([
  { re: /^(まず|ここで)?重要なのは、?/, label: '前置フィラー「重要なのは」' },
  { re: /^結論から言うと、?/, label: '前置フィラー「結論から言うと」' },
  { re: /^正直に言うと、?/, label: '前置フィラー「正直に言うと」' },
  { re: /^避けたいのは、?/, label: '前置フィラー「避けたいのは」' },
  { re: /いかがでした(でしょうか|か)?[？?。]?$/, label: '定型クロージング「いかがでしたでしょうか」' },
  { re: /ぜひ(参考|試し|活用)(に)?して(みて)?ください[！!。]?/, label: '定型クロージング「ぜひ〜してみてください」' },
  { re: /〜に他なりません/, label: '過剰な自己ラベリング「〜に他なりません」' },
]);

const NEGATIVE_PARALLEL = /([^。、]+)ではなく、?([^。、]+)/;
const REDUNDANT_BRACKET = /（(素の出力|いわゆる|概要|詳細|感謝と設計への反映)）/;
const HALFWIDTH_SPACE = /([ぁ-んァ-ヶ一-龥])\s+([a-zA-Z0-9_-]{2,})\s+([ぁ-ん])/u;
const SENTENCE_ENDS = ['です', 'ます', 'でした', 'ました', 'である', 'だ', 'だろう'];

const DO = {
  slop: '文脈上いらない比喩や大げさな飾りなら、ふだんの言葉に置き換える。文字どおりの意味なら残してよい',
  metaphor: '不自然な比喩なら、ふだんの動詞や客観的な書き方にする。文字どおりの動作や状態の変化なら残してよい',
  filler: 'ただの前置きや飾りなら削り、本題から書く。評価そのものを担うなら述語に移して残す',
  negative: '否定を外しても主張が変わらないなら肯定文にする。誤解の訂正や見方の切り替えなら残してよい',
};

const warn = (line, rule, message, suggestion, severity = 'warn') => ({ line, rule, message, suggestion, severity });

// 1 行（見出しを除く）の語と言い回しを検査する。text はインラインコードや装飾を取り除いたもの。
export function checkLine(text, line) {
  const out = [];
  if (HALFWIDTH_SPACE.test(text)) {
    out.push(warn(line, 'halfwidth-space', '英単語の前後に半角空白があります', '日本語の助詞と空白なしでつなげる'));
  }
  if (/[：:]$/.test(text) && !text.startsWith('http')) {
    out.push(warn(line, 'trailing-colon', '文末がコロン（：）です', '句点（。）で終えるか、前置きを省く'));
  }
  for (const word of SLOP_WORDS) {
    if (text.includes(word)) out.push(warn(line, 'slop-word', `AI の文章に多い語「${word}」`, DO.slop));
  }
  // 「〜が壊れる」と「静かに壊れる」が同じ動詞に二重に当たらないようにする（yomiyasu と同じ）。
  let kowareru = null;
  for (const { re, label } of METAPHOR_VERBS) {
    if (label === SILENTLY && kowareru) {
      const m = [...text.matchAll(re)].find((x) => !(kowareru[0] <= x.index && x.index + x[0].length <= kowareru[1]));
      if (m) out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
      continue;
    }
    const m = text.match(re);
    if (!m) continue;
    if (label === KOWARERU) kowareru = [m.index, m.index + m[0].length];
    out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
  }
  for (const { re, label } of FILLERS) {
    if (re.test(text)) out.push(warn(line, 'filler', label, DO.filler));
  }
  if (NEGATIVE_PARALLEL.test(text)) {
    out.push(warn(line, 'negative-parallel', '「AではなくB」の構文です', DO.negative, 'info'));
  }
  return out;
}

// 絵文字（見出しや表を含むすべての行）。
export function checkEmoji(raw, line) {
  const found = raw.match(EMOJI);
  return found ? [warn(line, 'emoji', `絵文字（${found.slice(0, 3).join(' ')}）があります`, '飾りを外し、言葉で書く')] : [];
}

// 見出しの、情報の増えない補足のかっこ。
export function checkHeading(text, line) {
  return REDUNDANT_BRACKET.test(text) ? [warn(line, 'redundant-bracket', '見出しに情報の増えない補足のかっこがあります', 'かっこを削る')] : [];
}

// 文末の種類が 3 文以上続くところ。sentences は文書の順に並べた { line, text }。
export function checkSentenceEnds(sentences) {
  const out = [];
  let prev = null;
  let count = 1;
  for (const { line, text } of sentences) {
    const end = endKind(text.replace(/[。！？\s]+$/, ''));
    if (end && end === prev) {
      count++;
      if (count === 3) out.push(warn(line, 'sentence-end-repeat', `文末の「${end}」が 3 回以上続いています`, '文末の形を変えてリズムを整える'));
    } else {
      count = 1;
    }
    prev = end;
  }
  return out;
}

// yomiyasu と同じ順で文末の種類を決める。
function endKind(s) {
  return SENTENCE_ENDS.find((e) => s.endsWith(e)) ?? null;
}

// 太字と箇条書きの頻度。地の文が 300 字を超えるときだけ見る。
export function checkMetrics({ chars, lines, listLines, bold }, line = 1) {
  const out = [];
  if (chars <= 300) return out;
  const perThousand = Math.round((bold / chars) * 1000 * 100) / 100;
  const ratio = lines ? listLines / lines : 0;
  if (perThousand > 3.0) {
    out.push(warn(line, 'excess-bold', `太字が多すぎます（1,000 字あたり ${perThousand} 個。目安は 2.5 以下）`, '大事な要点だけを太字にする'));
  }
  if (ratio > 0.25) {
    out.push(warn(line, 'excess-list', `箇条書きの行が多すぎます（${Math.round(ratio * 1000) / 10}%。目安は 20% 以下）`, '考えや論理の流れは地の文で書く'));
  }
  return out;
}

// AI っぽさのスコア（yomiyasu と同じく 100 点から warn と error を 5 点、info を 2 点ずつ引く）。
export function aiScore(warnings) {
  const penalty = warnings.filter((w) => w.severity).reduce((n, w) => n + (w.severity === 'info' ? 2 : 5), 0);
  return Math.max(0, 100 - penalty);
}

// ---- 太字が表示されるか（yomiyasu の bold_problems）----
// ** のすぐ内側が記号（「」（）` など）で、すぐ外側が文字だと、** を太字の印として読まず、** がそのまま表示される。
// 新しい CommonMark（記号に Unicode の S も入る）でも、GitHub の GFM（P だけ）でも太字になる形だけを「表示される」とみなす。
// 直し方の案は、かっこの内側だけを太字にする → 句読点を太字の外に出す → 文字に接する側に半角スペースを入れる、の順に試す。

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const BRACKETS = { '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '〔': '〕', '［': '］', '[': ']', '〈': '〉', '《': '》', '“': '”', '‘': '’', '＜': '＞' };

const isWs = (ch) => ch === '' || /^\s$/u.test(ch);
const punctGfm = (ch) => ch !== '' && (ASCII_PUNCT.has(ch) || /^\p{P}$/u.test(ch));
const punctNew = (ch) => ch !== '' && /^[\p{P}\p{S}]$/u.test(ch);
const canOpen = (prev, nxt) => [punctGfm, punctNew].every((p) => !isWs(nxt) && (!p(nxt) || isWs(prev) || p(prev)));
const canClose = (prev, nxt) => [punctGfm, punctNew].every((p) => !isWs(prev) && (!p(prev) || isWs(nxt) || p(nxt)));
const at = (s, p) => (p >= 0 && p < s.length ? s[p] : '');

function codeSpans(text) {
  const runs = [...text.matchAll(/`+/g)].map((m) => [m.index, m.index + m[0].length]);
  const spans = [];
  for (let k = 0; k < runs.length; k++) {
    const [s, e] = runs[k];
    for (let m = k + 1; m < runs.length; m++) {
      if (runs[m][1] - runs[m][0] === e - s) {
        spans.push([s, runs[m][1]]);
        k = m;
        break;
      }
    }
  }
  return spans;
}

export function boldPairs(text) {
  const code = codeSpans(text);
  const pos = [];
  for (const m of text.matchAll(/(?<!\*)\*\*(?!\*)/g)) {
    const p = m.index;
    if (code.some(([a, b]) => a <= p && p < b)) continue;
    const bs = text.slice(0, p).match(/\\*$/)[0].length;
    if (bs % 2 === 1) continue;
    pos.push(p);
  }
  const pairs = [];
  const used = new Set();
  // 1 段目：** の前後の空白で開き・閉じを決め、スタックで組にする。
  const stack = [];
  for (const p of pos) {
    const open = !isWs(at(text, p + 2));
    const close = !isWs(at(text, p - 1));
    if (close && stack.length) {
      const opener = stack.pop();
      if (opener + 2 < p) {
        pairs.push([opener, p]);
        used.add(opener);
        used.add(p);
      }
    } else if (open) {
      stack.push(p);
    }
  }
  // 2 段目：内側の空白のせいで開き・閉じにならなかった候補を組にする。
  const unpaired = pos.filter((p) => !used.has(p));
  let idx = 0;
  while (idx < unpaired.length - 1) {
    const p1 = unpaired[idx];
    const p2 = unpaired[idx + 1];
    if (pairs.some(([a, b]) => (p1 < a && a < p2) || (p1 < b && b < p2))) {
      idx++;
      continue;
    }
    const inner = text.slice(p1 + 2, p2);
    if (inner.trim() !== '' && (isWs(inner[0]) || isWs(inner.at(-1)))) {
      pairs.push([p1, p2]);
      idx += 2;
      continue;
    }
    idx++;
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

const pairOk = (text, i, j) => canOpen(at(text, i - 1), at(text, i + 2)) && canClose(at(text, j - 1), at(text, j + 2));

function closeOf(s) {
  const o = s[0];
  const c = BRACKETS[o];
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === o) depth++;
    else if (s[k] === c && --depth === 0) return k;
  }
  return -1;
}

function boldFix(text, i, j, k) {
  const inner = text.slice(i + 2, j);
  const tries = [];
  if (inner.length >= 3 && BRACKETS[inner[0]] && closeOf(inner) === inner.length - 1) {
    tries.push([`${inner[0]}**${inner.slice(1, -1)}**${inner.at(-1)}`, 'かっこの内側だけを太字にする']);
  }
  if (inner.length >= 2 && '。、．，！？!?'.includes(inner.at(-1))) {
    tries.push([`**${inner.slice(0, -1)}**${inner.at(-1)}`, '句読点を太字の外に出す']);
  }
  const body = isWs(at(text, i + 2)) || isWs(at(text, j - 1)) ? inner.trim() : inner;
  const left = canOpen(at(text, i - 1), body.slice(0, 1)) ? '' : ' ';
  const right = canClose(body.slice(-1), at(text, j + 2)) ? '' : ' ';
  tries.push([`${left}**${body}**${right}`, body !== inner && !(left || right) ? '太字の内側の空白を取る' : '文字に接する側に半角スペースを入れる']);
  for (const [middle, how] of tries) {
    const cand = text.slice(0, i) + middle + text.slice(j + 2);
    const pairs = boldPairs(cand);
    if (k < pairs.length && pairOk(cand, ...pairs[k])) return { middle, how };
  }
  return { middle: null, how: '手で直す' };
}

// 行のリストの印と引用の深さ、その内側の内容。
function lineContainers(line) {
  const list = line.match(/^\s{0,3}(?:[*+-]|\d+[.)])\s+/);
  const rem = list ? line.slice(list[0].length) : line;
  let depth = 0;
  let p = 0;
  for (;;) {
    p += rem.slice(p).match(/^\s{0,3}/)[0].length;
    if (rem[p] !== '>') break;
    depth++;
    p++;
    if (rem[p] === ' ') p++;
  }
  return { isList: Boolean(list), depth, content: rem.slice(p) };
}

// 長い太字は、直すところ（両端）だけを見せる。文字数はコードポイントで数える（yomiyasu と同じ）。
const short = (s) => {
  const cs = Array.from(s);
  return cs.length <= 30 ? s : `${cs.slice(0, 12).join('')}…${cs.slice(-12).join('')}`;
};

// 太字にならない ** の場所と直し方の案。startLine は text の 1 行目の行番号。
// コードブロック・インラインコード・HTML の行・先頭の設定部分は見ない。段落・リスト・引用などのブロックごとに、複数行の太字も扱う。
export function boldProblems(text, { startLine = 1, skipFrontmatter = true } = {}) {
  const lines = String(text).split('\n');
  let start = 0;
  if (skipFrontmatter && lines[0]?.replace(/\r$/, '') === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.replace(/\r$/, '') === '---');
    if (end !== -1) start = end + 1;
  }
  const blocks = [];
  let cur = [];
  let fence = null;
  let curDepth = 0;
  let inTable = false;
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
    curDepth = 0;
    inTable = false;
  };
  for (let no = start; no < lines.length; no++) {
    const line = lines[no].replace(/\r$/, '');
    const lineNo = no + 1;
    const { isList, depth, content } = lineContainers(line);
    const m = content.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence[1] && !m[2].trim()) fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      flush();
      fence = [m[1][0], m[1].length];
      continue;
    }
    if (!content.trim() || content.trimStart().startsWith('<')) {
      flush();
      continue;
    }
    if (/^\s{0,3}(?:(\*)\s*(?:\1\s*){2,}|(-)\s*(?:\2\s*){2,}|(_)\s*(?:\3\s*){2,})\s*$/.test(content)) {
      flush();
      continue;
    }
    // GFM の表の区切り行（外側の | がないものを含む）。直前の行は表の見出し行として別のブロックにする。
    if (/^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(content)) {
      if (cur.length) {
        const hdr = cur.pop();
        flush();
        blocks.push([hdr]);
      } else {
        flush();
      }
      inTable = true;
      continue;
    }
    if (cur.length && /^\s{0,3}(=+|-+)\s*$/.test(content)) {
      flush();
      continue;
    }
    if (/^\s{0,3}#{1,6}(\s+|$)/.test(content)) {
      flush();
      blocks.push([[lineNo, line]]);
      continue;
    }
    if (content.startsWith('|') || (inTable && content.includes('|'))) {
      flush();
      blocks.push([[lineNo, line]]);
      inTable = true;
      continue;
    }
    inTable = false;
    if (isList || /^\s{0,3}(?:[*+-]|\d+[.)])\s+/.test(content)) {
      flush();
      curDepth = depth;
      cur.push([lineNo, line]);
      continue;
    }
    // 引用の深さが変わったら区切る（直前が引用で、今の行の深さが 0 のときは続きとみなす）。
    if (cur.length && depth !== curDepth && !(curDepth > 0 && depth === 0)) {
      flush();
      curDepth = depth;
    }
    if (!cur.length) curDepth = depth;
    cur.push([lineNo, line]);
  }
  flush();

  const out = [];
  for (const block of blocks) {
    const blockText = block.map(([, l]) => l).join('\n');
    const offsets = [0];
    for (const [, l] of block.slice(0, -1)) offsets.push(offsets.at(-1) + l.length + 1);
    const lineOf = (idx) => block[offsets.findLastIndex((o) => o <= idx)][0];
    boldPairs(blockText).forEach(([i, j], k) => {
      if (pairOk(blockText, i, j)) return;
      const { middle, how } = boldFix(blockText, i, j, k);
      const pre = Array.from(blockText.slice(0, i)).slice(-4).join('');
      const post = Array.from(blockText.slice(j + 2)).slice(0, 4).join('');
      out.push({
        line: lineOf(i) + startLine - 1,
        found: pre + short(blockText.slice(i, j + 2)) + post,
        suggest: middle === null ? '' : pre + short(middle) + post,
        how,
      });
    });
  }
  return out;
}

// 警告は 1 行で出すので、複数行にまたがる太字の改行は ↵ で示す。
const oneLine = (s) => s.replace(/\n/g, '↵');

export function checkBold(text, startLine) {
  return boldProblems(text, { startLine, skipFrontmatter: false }).map((p) => warn(
    p.line, 'bold-not-rendered', `太字の印（**）が記号に接していて、太字にならず ** がそのまま表示されます：「${oneLine(p.found)}」`,
    p.suggest ? `${p.how}：「${oneLine(p.suggest)}」` : p.how, 'error',
  ));
}
