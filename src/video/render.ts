// Video script -> single-file player page. The screen reuses page components. The timeline follows each narration's audio length (or an estimate).
// The player's render(t) is deterministic: the same time always draws the same frame. MP4 export calls it once per frame.
import { renderBlocks, LintError } from '../render.ts';
import { timestamp } from '../time.ts';
import { pageCss } from '../themes/index.ts';
import { lintDoc, blockingWarnings } from '../lint/ste.ts';
import { esc } from '../svg/text.ts';
import { VERSION, VIDEO_CSS, VIDEO_JS } from '../assets.ts';
import { parseVideo, buildTimeline, estimateSeconds, allBeats, VIDEO_THEMES } from './script.ts';
import { CHOICES, ParseError, applyOverrides } from '../parse.ts';
import { synthAll, mixTrack, SAMPLE_RATE } from './tts.ts';
import type { EncodedAudio, TtsProvider } from './tts.ts';
import type { Video } from './script.ts';

type Meta = Video['meta'];
type RenderContext = Parameters<typeof renderBlocks>[1];
type Warning = ReturnType<typeof lintDoc>[number];

export interface RenderVideoOptions {
  provider?: TtsProvider | null;
  cacheDir?: string;
  defaults?: NonNullable<Parameters<typeof parseVideo>[1]>['defaults'];
  overrides?: Parameters<typeof applyOverrides>[1];
  onProgress?: (msg: string) => void;
  encodeAudio?: ((wav: Buffer) => Promise<EncodedAudio | null>) | null;
}

export interface RenderedVideo {
  html: string;
  wav: Buffer | null;
  warnings: Warning[];
  stats: { panels: number; components: Record<string, number> };
  meta: Meta;
  duration: number;
  beats: number;
}

interface PlayerSegment {
  start: number;
  end: number;
  title: string | undefined;
  beats: { text: string; focus: string | null; reveal: number | null; start: number; end: number; html: string }[];
}

interface PlayerData {
  duration: number;
  fps: number;
  segments: PlayerSegment[];
}

// Labels for the player controls.
export const VIDEO_UI = Object.freeze({ play: '再生', pause: '一時停止', chapters: 'チャプター', seek: '再生位置' });

// With a null provider, only captions are shown and durations are estimated from the text length.
// encodeAudio(wav) converts the embedded audio to { mime, data } (returning null keeps the WAV). When omitted, the WAV is embedded.
export async function renderVideo(
  source: string,
  { provider = null, cacheDir, defaults = {}, overrides = {}, onProgress, encodeAudio = null }: RenderVideoOptions = {},
): Promise<RenderedVideo> {
  const video = parseVideo(source, { defaults });
  const { meta } = video;
  // Command-line arguments take precedence over the script and the config.
  applyOverrides(meta, overrides, { ...CHOICES, theme: VIDEO_THEMES });

  if (meta.static === 'true') throw new ParseError('動画の再生には JavaScript が必要なため、static: true は使えません', 0);

  // Each narration line is one beat, so any number of consecutive lines is not a "paragraph too long".
  const warnings = meta.style === 'off' ? [] : lintDoc(video.doc).filter((w) => w.rule !== 'paragraph-length');
  if (meta.style === 'strict' && blockingWarnings(warnings).length) throw new LintError(blockingWarnings(warnings));

  const beats = allBeats(video);
  let clips: Int16Array[] | null = null;
  let durations: number[];
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
  const ctx: RenderContext = { seq: 0, stats };
  const data: PlayerData = {
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

const beatsOf = (video: Video, i: number) => (i === 0 ? video.introBeats : video.scenes[i - 1].beats);

// Captions: [name] becomes emphasized text.
export function captionHtml(raw: string): string {
  return raw.split(/(\[[^\]\n]+\])/).map((part) => {
    const m = part.match(/^\[([^\]]+)\]$/);
    return m ? `<b>${esc(m[1])}</b>` : esc(part);
  }).join('');
}

function titleScene(meta: Meta, introHtml: string, { scenes, duration }: { scenes: number; duration: number }): string {
  const mmss = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`;
  const cells = [['DRAWN', 'explain'], ['DATE', timestamp().slice(0, 10)], ['SCENES', String(scenes)], ['DURATION', mmss]];
  const block = `<div class="amv-titleblock">${cells.map(([k, v]) => `<div><b>${k}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
  return `<section class="amv-scene amv-scene--title" data-i="0">
<div class="amv-title-wrap"><h1 class="amv-title">${esc(meta.title || '無題')}</h1>${meta.subtitle ? `<p class="amv-subtitle">${esc(meta.subtitle)}</p>` : ''}${introHtml ? `<div class="amv-intro">${introHtml}</div>` : ''}${block}</div>
</section>`;
}

function scene(s: Video['scenes'][number], i: number, total: number, body: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `<section class="amv-scene" data-i="${i + 1}">
<header class="amv-scene-head"><span class="amv-scene-n">${esc(s.id)}</span><span class="amv-scene-title">${esc(s.title)}</span><span class="amv-scene-meta">SHEET ${pad(i + 1)} / ${pad(total)}</span></header>
<div class="amv-body"><div class="amv-fit">${body}</div></div>
</section>`;
}

// Drawing sheet border and coordinate rulers (shown only with the blueprint theme), fixed outside the camera.
function sheetFrame(): string {
  const ruler = (side: string, labels: readonly (string | number)[]) => `<div class="amv-ruler amv-ruler--${side}">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  const nums = [1, 2, 3, 4, 5, 6, 7, 8];
  const letters = ['A', 'B', 'C', 'D'];
  return `<div class="amv-sheet" aria-hidden="true">${ruler('top', nums)}${ruler('bottom', nums)}${ruler('left', letters)}${ruler('right', letters)}</div>`;
}

// 3b1b is dark only. auto follows the viewer's OS color scheme (MP4 export pins it to light).
export function videoMode(meta: { theme?: unknown; mode?: unknown }): 'light' | 'dark' | 'auto' {
  if (meta.theme === '3b1b') return 'dark';
  return meta.mode === 'light' || meta.mode === 'dark' ? meta.mode : 'auto';
}

function shell({ meta, scenesHtml, data, audio, source }: { meta: Meta; scenesHtml: string; data: PlayerData; audio: EncodedAudio | null; source: string }): string {
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
