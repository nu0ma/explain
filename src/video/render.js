// 動画の原稿 → 1 ファイルの再生ページ。画面はページの部品を使い回す。タイムラインは各ナレーションの音声の長さ（または見積もり）で決まる。
// 再生ページの render(t) は決定的で、同じ時刻には必ず同じフレームを描く。MP4 の書き出しではこれをフレームごとに呼ぶ。
import { renderBlocks, LintError, timestamp } from '../render.js';
import { pageCss } from '../themes/index.js';
import { lintDoc } from '../lint/ste.js';
import { esc } from '../svg/text.js';
import { VERSION, VIDEO_CSS, VIDEO_JS } from '../assets.js';
import { parseVideo, buildTimeline, estimateSeconds, allBeats, VIDEO_THEMES } from './script.js';
import { CHOICES, ParseError } from '../parse.js';
import { synthAll, mixTrack, SAMPLE_RATE } from './tts.js';

// 再生ページのコントロールの文言。
export const VIDEO_UI = Object.freeze({ play: '再生', pause: '一時停止', chapters: 'チャプター', seek: '再生位置' });

// provider が null なら字幕だけを出し、長さは文字数から見積もる。
// encodeAudio(wav) は埋め込む音声を { mime, data } に変える（null を返せば WAV のまま）。省略すると WAV を埋め込む。
export async function renderVideo(source, { provider = null, cacheDir, defaults = {}, overrides = {}, onProgress, encodeAudio = null } = {}) {
  const video = parseVideo(source, { defaults });
  const { meta } = video;
  // コマンドラインの引数は原稿と設定より優先する。
  const allowed = { ...CHOICES, theme: VIDEO_THEMES };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (allowed[key] && !allowed[key].includes(String(value))) {
      throw new ParseError(`${key} の値 "${value}" は使えません。選択肢：${allowed[key].join(' | ')}`, 0);
    }
    meta[key] = value;
  }

  if (meta.static === 'true') throw new ParseError('動画の再生には JavaScript が必要なため、static: true は使えません', 0);

  // ナレーションは 1 行が 1 拍なので、何行続いても「長すぎる段落」とはみなさない。
  const warnings = meta.style === 'off' ? [] : lintDoc(video.doc).filter((w) => w.rule !== 'paragraph-length');
  if (meta.style === 'strict' && warnings.length) throw new LintError(warnings);

  const beats = allBeats(video);
  let clips = null;
  let durations;
  if (provider) {
    onProgress?.(`音声合成：${provider.name}、${beats.length} 文`);
    clips = await synthAll(beats.map((b) => b.text), provider, { cacheDir });
    durations = clips.map((c) => c.length / SAMPLE_RATE);
  } else {
    durations = beats.map((b) => estimateSeconds(b.text));
  }
  const timeline = buildTimeline(video, durations);
  const flat = [...timeline.title.beats, ...timeline.scenes.flatMap((s) => s.beats)];
  const wav = clips ? mixTrack(clips, flat.map((b) => b.start), timeline.duration) : null;
  const audio = wav && ((encodeAudio && await encodeAudio(wav)) || { mime: 'audio/wav', data: wav });

  const stats = { panels: video.scenes.length, components: {} };
  const ctx = { seq: 0, stats };
  const data = {
    duration: timeline.duration,
    fps: 30,
    segments: [timeline.title, ...timeline.scenes].map((s, i) => ({
      start: s.start,
      end: s.end,
      title: i === 0 ? meta.title : s.title,
      beats: s.beats.map((b, k) => ({ ...b, html: captionHtml(beatsOf(video, i)[k].raw) })),
    })),
  };
  const total = video.scenes.length;
  const scenesHtml = [
    titleScene(meta, renderBlocks(video.intro, ctx), { scenes: total, duration: timeline.duration }),
    ...video.scenes.map((s, i) => scene(s, i, total, renderBlocks(s.blocks, ctx))),
  ].join('\n');

  const html = shell({ meta, scenesHtml, data, audio, source });
  return { html, wav, warnings, stats, meta, duration: timeline.duration, beats: beats.length };
}

const beatsOf = (video, i) => (i === 0 ? video.introBeats : video.scenes[i - 1].beats);

// 字幕：[名前] を強調語にする。
export function captionHtml(raw) {
  return raw.split(/(\[[^\]\n]+\])/).map((part) => {
    const m = part.match(/^\[([^\]]+)\]$/);
    return m ? `<b>${esc(m[1])}</b>` : esc(part);
  }).join('');
}

function titleScene(meta, introHtml, { scenes, duration }) {
  const mmss = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`;
  const cells = [['DRAWN', 'explain'], ['DATE', timestamp().slice(0, 10)], ['SCENES', String(scenes)], ['DURATION', mmss]];
  const block = `<div class="amv-titleblock">${cells.map(([k, v]) => `<div><b>${k}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
  return `<section class="amv-scene amv-scene--title" data-i="0">
<div class="amv-title-wrap"><h1 class="amv-title">${esc(meta.title || '無題')}</h1>${meta.subtitle ? `<p class="amv-subtitle">${esc(meta.subtitle)}</p>` : ''}${introHtml ? `<div class="amv-intro">${introHtml}</div>` : ''}${block}</div>
</section>`;
}

function scene(s, i, total, body) {
  const pad = (n) => String(n).padStart(2, '0');
  return `<section class="amv-scene" data-i="${i + 1}">
<header class="amv-scene-head"><span class="amv-scene-n">${esc(s.id)}</span><span class="amv-scene-title">${esc(s.title)}</span><span class="amv-scene-meta">SHEET ${pad(i + 1)} / ${pad(total)}</span></header>
<div class="amv-body"><div class="amv-fit">${body}</div></div>
</section>`;
}

// 図面の外枠と座標の目盛り（blueprint テーマのときだけ表示）。カメラの外に固定する。
function sheetFrame() {
  const ruler = (side, labels) => `<div class="amv-ruler amv-ruler--${side}">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  const nums = [1, 2, 3, 4, 5, 6, 7, 8];
  const letters = ['A', 'B', 'C', 'D'];
  return `<div class="amv-sheet" aria-hidden="true">${ruler('top', nums)}${ruler('bottom', nums)}${ruler('left', letters)}${ruler('right', letters)}</div>`;
}

// 3b1b はダーク専用。auto は再生する OS の配色に従う（MP4 の書き出しではライトに固定する）。
export function videoMode(meta) {
  if (meta.theme === '3b1b') return 'dark';
  return ['light', 'dark'].includes(meta.mode) ? meta.mode : 'auto';
}

function shell({ meta, scenesHtml, data, audio, source }) {
  const ui = VIDEO_UI;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja" data-theme="${esc(meta.theme)}" data-mode="${videoMode(meta)}" data-video>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="explain ${VERSION}">
<title>${esc(meta.title || '無題')}</title>
<style>
${pageCss()}
${VIDEO_CSS}
</style>
</head>
<body>
<div class="amv-viewport">
<div class="amv-stage">
${sheetFrame()}
<div class="amv-camera">
${scenesHtml}
<div class="amv-overlay"></div>
</div>
<div class="amv-caption"><span></span></div>
<button class="amv-bigplay" type="button" aria-label="${esc(ui.play)}">▶</button>
</div>
</div>
<div class="amv-controls">
<button class="amv-btn" type="button" data-amv="toggle" data-play="${esc(ui.play)}" data-pause="${esc(ui.pause)}" aria-label="${esc(ui.play)}">▶</button>
<span class="amv-time">0:00 / 0:00</span>
<div class="amv-track"><input class="amv-seek" type="range" min="0" step="0.01" value="0" aria-label="${esc(ui.seek)}"><div class="amv-marks" role="group" aria-label="${esc(ui.chapters)}"></div></div>
<span class="amv-brand">explain ${VERSION} · ${esc(timestamp())}</span>
</div>
<script type="application/json" id="amv-data">${json}</script>
${audio ? `<audio id="amv-audio" preload="auto" src="data:${audio.mime};base64,${audio.data.toString('base64')}"></audio>` : ''}
<textarea id="am-source" hidden readonly aria-hidden="true">${esc(source)}</textarea>
<script>
${VIDEO_JS}</script>
</body>
</html>
`;
}
