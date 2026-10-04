// Video scripts reuse parseDoc's panel split: each "## " panel is one scene. Lines in a panel starting with > are narration,
// one line per beat. A [name] in narration moves the camera to the element of that name. Everything else (components, Markdown) is the screen.
// Two directives override the automatic timing: "> (pause 1.5s)" holds the screen silently, and "> (+2) text" makes that beat reveal 2 steps.
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
  // Seconds of silence before this beat, from "(pause Ns)" lines.
  before: number;
  // Steps this beat reveals, from a "(+N)" prefix. null leaves it to the automatic mapping.
  reveal: number | null;
}

export interface Scene {
  id: Panel['id'];
  title: Panel['title'];
  line: Panel['line'];
  attrs: Panel['attrs'];
  blocks: Block[];
  beats: Beat[];
  // Seconds of silence after the last beat, from "(pause Ns)" lines at the end of the scene.
  after: number;
}

export interface Video {
  meta: Doc['meta'];
  doc: Doc;
  intro: Block[];
  introBeats: Beat[];
  introAfter: number;
  scenes: Scene[];
}

export interface TimedBeat {
  text: string;
  focus: string | null;
  reveal: number | null;
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
const PAUSE = /^\(\s*(?:pause|間)\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\)$/i;
const REVEAL = /^\(\+(\d+)\)\s*/;
const MAX_PAUSE = 30;

// Video themes: the two page themes plus the dark 3b1b.
export const VIDEO_THEMES = Object.freeze([...CHOICES.theme, '3b1b']);

export function parseVideo(source: string, { defaults = {} }: { defaults?: ParseOptions['defaults'] } = {}): Video {
  const doc = parseDoc(source, { defaults: { ...defaults, template: 'video' }, choices: { theme: VIDEO_THEMES } });
  const intro = splitNarration(doc.intro);
  const scenes = doc.panels.map((p) => {
    const { blocks, beats, after } = splitNarration(p.blocks);
    if (!beats.length) throw new ParseError(`場面 "${p.title}" にナレーションがありません。各場面に > ナレーション を 1 行以上書いてください`, p.line);
    return { id: p.id, title: p.title, line: p.line, attrs: p.attrs, blocks, beats, after };
  });
  if (!scenes.length) throw new ParseError('動画の原稿には場面（## 場面の題名）が 1 つ以上必要です', 1);
  return { meta: doc.meta, doc, intro: intro.blocks, introBeats: intro.beats, introAfter: intro.after, scenes };
}

// Extracts narration lines from Markdown blocks. The remaining Markdown becomes screen content.
// A pause line adds silence before the next beat, or after the last beat when no beat follows.
function splitNarration(blocks: readonly Block[]): { blocks: Block[]; beats: Beat[]; after: number } {
  const beats: Beat[] = [];
  const out: Block[] = [];
  let pending = 0;
  for (const b of blocks) {
    if (b.type !== 'md') {
      out.push(b);
      continue;
    }
    const rest: string[] = [];
    b.text.split('\n').forEach((raw, i) => {
      const m = raw.match(NARRATION);
      const line = b.line + i;
      const said = m?.[1].trim();
      if (!m) rest.push(raw);
      else if (!said) return;
      else if (PAUSE.test(said)) pending += pauseSeconds(said, line);
      else {
        beats.push(beat(said, line, pending));
        pending = 0;
      }
    });
    if (rest.some((l) => l.trim())) out.push({ ...b, text: rest.join('\n') });
  }
  return { blocks: out, beats, after: pending };
}

function pauseSeconds(said: string, line: number): number {
  const sec = Number(said.match(PAUSE)?.[1]);
  if (!(sec > 0 && sec <= MAX_PAUSE)) throw new ParseError(`間の長さは 0 より長く ${MAX_PAUSE} 秒以下にしてください："${said}"`, line);
  return sec;
}

function beat(said: string, line: number, before: number): Beat {
  const r = said.match(REVEAL);
  const raw = r ? said.slice(r[0].length) : said;
  if (!raw.trim()) throw new ParseError(`(+N) のあとにナレーションの文を書いてください："${said}"`, line);
  const focus = [...raw.matchAll(FOCUS)].map((m) => m[1].trim());
  return { raw, text: raw.replace(FOCUS, '$1'), focus: focus[0] ?? null, line, before, reveal: r ? Number(r[1]) : null };
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
// Pauses written in the script are added on top of the fixed gaps.
type TimelineInput = Pick<Video, 'introBeats'> & Partial<Pick<Video, 'introAfter'>> & {
  scenes: readonly (Pick<Scene, 'title' | 'beats'> & Partial<Pick<Scene, 'after'>>)[];
};

export function buildTimeline(video: TimelineInput, durations: readonly number[]): Timeline {
  let t = 0;
  let k = 0;
  const lay = (beats: readonly Beat[]): TimedBeat[] => beats.map((b) => {
    const dur = durations[k++];
    t += b.before ?? 0;
    const start = t;
    t += dur + TIMING.gap;
    return { text: b.text, focus: b.focus, reveal: b.reveal ?? null, start: round(start), end: round(start + dur) };
  });

  const titleBeats = lay(video.introBeats);
  t += video.introAfter ?? 0;
  if (!titleBeats.length) t = Math.max(t, TIMING.title);
  const title = { start: 0, end: round(t), beats: titleBeats };

  const scenes = video.scenes.map((s) => {
    const start = t;
    t += TIMING.transition;
    const beats = lay(s.beats);
    t += TIMING.tail - TIMING.gap + (s.after ?? 0);
    return { title: s.title, start: round(start), end: round(t), beats };
  });
  t += TIMING.outro;
  return { duration: round(t), title, scenes };
}

export const allBeats = (video: Pick<Video, 'introBeats' | 'scenes'>): Beat[] => [...video.introBeats, ...video.scenes.flatMap((s) => s.beats)];

const round = (x: number) => Math.round(x * 1000) / 1000;
