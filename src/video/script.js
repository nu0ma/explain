// 動画の原稿：parseDoc のパネル分割を使い回す。"## " のパネル 1 つが場面 1 つ。パネル内の > で始まる行がナレーションで、
// 1 行が 1 拍。ナレーション中の [名前] でカメラが同じ名前の要素に寄る。それ以外（部品や Markdown）が画面になる。
import { parseDoc, ParseError, CHOICES } from '../parse.js';
import { isCJK } from '../svg/text.js';

const NARRATION = /^\s*>\s?(.*)$/;
const FOCUS = /\[([^\]\n]+)\]/g;

// 動画のテーマ：ページの 2 つのテーマに、ダークの 3b1b を加える。
export const VIDEO_THEMES = Object.freeze([...CHOICES.theme, '3b1b']);

export function parseVideo(source, { defaults = {} } = {}) {
  const doc = parseDoc(source, { defaults: { ...defaults, template: 'video' }, choices: { theme: VIDEO_THEMES } });
  const intro = splitNarration(doc.intro);
  const scenes = doc.panels.map((p) => {
    const { blocks, beats } = splitNarration(p.blocks);
    if (!beats.length) throw new ParseError(`場面 "${p.title}" にナレーションがありません。各場面に > ナレーション を 1 行以上書いてください`, p.line);
    return { id: p.id, title: p.title, line: p.line, attrs: p.attrs, blocks, beats };
  });
  if (!scenes.length) throw new ParseError('動画の原稿には場面（## 場面の題名）が 1 つ以上必要です', 1);
  return { meta: doc.meta, doc, intro: intro.blocks, introBeats: intro.beats, scenes };
}

// Markdown ブロックからナレーションの行を取り出す。残りの Markdown は画面の内容にする。
function splitNarration(blocks) {
  const beats = [];
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'md') {
      out.push(b);
      continue;
    }
    const rest = [];
    b.text.split('\n').forEach((raw, i) => {
      const m = raw.match(NARRATION);
      if (m && m[1].trim()) beats.push(beat(m[1].trim(), b.line + i));
      else if (!m) rest.push(raw);
    });
    if (rest.some((l) => l.trim())) out.push({ ...b, text: rest.join('\n') });
  }
  return { blocks: out, beats };
}

function beat(raw, line) {
  const focus = [...raw.matchAll(FOCUS)].map((m) => m[1].trim());
  return { raw, text: raw.replace(FOCUS, '$1'), focus: focus[0] ?? null, line };
}

// 音声がないときは文字数から読み上げ時間を見積もる。日本語は 1 秒に約 5 字、英単語は 1 秒に約 2.6 語。
export function estimateSeconds(text) {
  let cjk = 0;
  let latin = '';
  for (const ch of text) {
    if (isCJK(ch)) cjk++;
    latin += isCJK(ch) ? ' ' : ch;
  }
  const words = latin.match(/[A-Za-z0-9][\w'’-]*/g)?.length ?? 0;
  return Math.max(1.6, cjk / 5 + words / 2.6 + 0.3);
}

export const TIMING = Object.freeze({
  title: 2.4,      // ナレーションがないときのタイトル画面の表示時間
  transition: 0.9, // 場面の切り替え（場面をまたぐ変形を含む）
  gap: 0.35,       // ナレーションの文と文の間
  tail: 0.8,       // 場面の最後の文の後に残す時間
  outro: 1.5,      // 最後に残す時間
});

// 各拍の長さをタイムラインに並べる。durations[i] はタイトル画面と各場面のナレーションに順に対応する（平らに並べた順）。
export function buildTimeline(video, durations) {
  let t = 0;
  let k = 0;
  const lay = (beats) => beats.map((b) => {
    const dur = durations[k++];
    const start = t;
    t += dur + TIMING.gap;
    return { text: b.text, focus: b.focus, start: round(start), end: round(start + dur) };
  });

  const titleBeats = lay(video.introBeats);
  if (!titleBeats.length) t = TIMING.title;
  const title = { start: 0, end: round(t), beats: titleBeats };

  const scenes = video.scenes.map((s) => {
    const start = t;
    t += TIMING.transition;
    const beats = lay(s.beats);
    t += TIMING.tail - TIMING.gap;
    return { title: s.title, start: round(start), end: round(t), beats };
  });
  t += TIMING.outro;
  return { duration: round(t), title, scenes };
}

export const allBeats = (video) => [...video.introBeats, ...video.scenes.flatMap((s) => s.beats)];

const round = (x) => Math.round(x * 1000) / 1000;
