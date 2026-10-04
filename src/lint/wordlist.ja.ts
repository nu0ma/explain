// Word lists for the Japanese STE checks.

export interface VerbosePattern {
  re: RegExp;
  label: string;
  /** Builds the suggested rewrite; `noun` is the noun right before the match ('' when none). */
  fix: (noun: string) => string;
}

export interface HedgePattern {
  re: RegExp;
  label: string;
}

export interface EmphasisWord {
  word: string;
  fix: string;
}

// Verbose verb phrases -> rewrites. When a noun is available, the suggestion uses the preceding noun (e.g. 確認を行う -> 確認する).
// Longer patterns are matched first, and ranges already matched are not counted again by shorter ones.
export const JA_VERBOSE: readonly VerbosePattern[] = Object.freeze([
  { re: /実施を行(?:う|い|っ|わ)/g, label: '実施を行う', fix: () => '実施する' },
  { re: /することができ(?:る|ます|ない|ません)?/g, label: 'することができる', fix: (noun: string) => `${noun}できる` },
  { re: /させていただ(?:く|き|け|い)/g, label: 'させていただく', fix: (noun: string) => (noun ? `${noun}する` : 'する') },
  { re: /を行います/g, label: 'を行います', fix: (noun: string) => (noun ? `${noun}します` : '〜します') },
  { re: /を行(?:う|っ|わ|い|え)/g, label: 'を行う', fix: (noun: string) => (noun ? `${noun}する` : '〜する') },
  { re: /を実施(?:する|します|した|して|し)/g, label: 'を実施する', fix: (noun: string) => (noun ? `${noun}する` : '〜する') },
  { re: /ということ/g, label: 'ということ', fix: () => 'こと（または削る）' },
]);

// Hedging expressions. No warning when the line contains 「推測：」.
export const JA_HEDGES: readonly HedgePattern[] = Object.freeze([
  { re: /と考えられ(?:る|ます)/g, label: 'と考えられる' },
  { re: /と思われ(?:る|ます)/g, label: 'と思われる' },
  { re: /かもしれ(?:ない|ません)/g, label: 'かもしれない' },
  { re: /と言え(?:る|ます)/g, label: 'と言える' },
]);

// Emphatic / exaggerating words -> how to fix them.
export const JA_EMPHASIS: readonly EmphasisWord[] = Object.freeze([
  { word: '非常に', fix: '削るか、数値で示す' },
  { word: '極めて', fix: '削るか、数値で示す' },
  { word: 'とても', fix: '削るか、数値で示す' },
  { word: '大変', fix: '削るか、数値で示す' },
  { word: '必ずしも', fix: 'どんな条件で成り立たないかを書く' },
  { word: '重要である', fix: 'なぜ重要か、何が起きるかを書く' },
]);
