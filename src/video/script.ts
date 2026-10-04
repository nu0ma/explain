// Video scripts reuse parseDoc's panel split: each "## " panel is one scene. Lines in a panel starting with > are narration,
// one line per beat. A [name] in narration moves the camera to the element of that name. Everything else (components, Markdown) is the screen.
import { parseDoc, ParseError, CHOICES } from '../parse.ts';
import { isCJK } from '../svg/text.ts';

type Doc = ReturnType<typeof parseDoc>;
type ParseOptions = NonNullable<Parameters<typeof parseDoc>[1]>;
type Panel = Doc['panels'][number];
export type Block = Doc['intro'][number];

export interface Beat {
  raw: string;
  text: string;
  focus: string | null;
  line: number;
}

export interface Scene {
  id: Panel['id'];
  title: Panel['title'];
  line: Panel['line'];
  attrs: Panel['attrs'];
  blocks: Block[];
  beats: Beat[];
}

export interface Video {
  meta: Doc['meta'];
  doc: Doc;
  intro: Block[];
  introBeats: Beat[];
  scenes: Scene[];
}

export interface TimedBeat {
  text: string;
  focus: string | null;
  start: number;
  end: number;
}

export interface Segment {
  title?: string;
  start: number;
  end: number;
  beats: TimedBeat[];
}

export interface SceneSegment extends Segment {
  title: string;
}

export interface Timeline {
  duration: number;
  title: Segment;
  scenes: SceneSegment[];
}

const NARRATION = /^\s*>\s?(.*)$/;
const FOCUS = /\[([^\]\n]+)\]/g;

// Video themes: the two page themes plus the dark 3b1b.
export const VIDEO_THEMES = Object.freeze([...CHOICES.theme, '3b1b']);

export function parseVideo(source: string, { defaults = {} }: { defaults?: ParseOptions['defaults'] } = {}): Video {
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

// Extracts narration lines from Markdown blocks. The remaining Markdown becomes screen content.
function splitNarration(blocks: readonly Block[]): { blocks: Block[]; beats: Beat[] } {
  const beats: Beat[] = [];
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type !== 'md') {
      out.push(b);
      continue;
    }
    const rest: string[] = [];
    b.text.split('\n').forEach((raw, i) => {
      const m = raw.match(NARRATION);
      if (m && m[1].trim()) beats.push(beat(m[1].trim(), b.line + i));
      else if (!m) rest.push(raw);
    });
    if (rest.some((l) => l.trim())) out.push({ ...b, text: rest.join('\n') });
  }
  return { blocks: out, beats };
}

function beat(raw: string, line: number): Beat {
  const focus = [...raw.matchAll(FOCUS)].map((m) => m[1].trim());
  return { raw, text: raw.replace(FOCUS, '$1'), focus: focus[0] ?? null, line };
}

// Without audio, estimates speaking time from the text: about 5 Japanese characters or 2.6 English words per second.
export function estimateSeconds(text: string): number {
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
  title: 2.4,      // how long the title screen shows when it has no narration
  transition: 0.9, // scene change, including the cross-scene morph
  gap: 0.35,       // pause between narration sentences
  tail: 0.8,       // time kept after the last sentence of a scene
  outro: 1.5,      // time kept at the very end
});

// Lays out each beat's duration on the timeline. durations[i] follows the title narration and then each scene's narration, flattened in order.
export function buildTimeline(video: Pick<Video, 'introBeats' | 'scenes'>, durations: readonly number[]): Timeline {
  let t = 0;
  let k = 0;
  const lay = (beats: readonly Beat[]): TimedBeat[] => beats.map((b) => {
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

export const allBeats = (video: Pick<Video, 'introBeats' | 'scenes'>): Beat[] => [...video.introBeats, ...video.scenes.flatMap((s) => s.beats)];

const round = (x: number) => Math.round(x * 1000) / 1000;
