// Checks for writing patterns common in AI-written Japanese. The rules are ported from
// scripts/yomiyasu_lint.py in yomiyasu (https://github.com/nanaism/yomiyasu) v2.0.1. The word and regex lists,
// the bold-rendering check, the bold/list frequency, the sentence-end repetition check, and the score follow the original script.
// Changes for explain:
// - The checked scope matches explain's STE checks, including table cells and quotes (video narration).
//   Code, inline code, ~~strikethrough~~, table rows with status no, and HTML blocks are skipped.
// - ✓ ✔ ✗ ✘ ⚠ are excluded from emoji, since explain uses them as table status words (badges). Emoji detection lives in
//   yomiyasu-emoji.ts, which also carries the Unicode license.
// - Severities are kept as in yomiyasu. info findings do not block generation even with style: strict.
// - explain has no document type, so pause_comma (applied only with a document type) is not ported.
//
// The yomiyasu license applies to these lists and checks:
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

import { boldProblems } from './yomiyasu-bold.ts';
import { emojiMatches } from './yomiyasu-emoji.ts';

export { boldPairs, boldProblems } from './yomiyasu-bold.ts';

export type Severity = 'warn' | 'error' | 'info';

export type LintRule =
  | 'sentence-length'
  | 'paragraph-length'
  | 'verbose'
  | 'hedge'
  | 'emphasis'
  | 'no-chain'
  | 'trailing-colon'
  | 'slop-word'
  | 'metaphor-verb'
  | 'translated-term'
  | 'filler'
  | 'summary-restatement'
  | 'meta-intro'
  | 'count-declaration'
  | 'instruction-residue'
  | 'short-mochiron'
  | 'fragment-run'
  | 'negative-parallel'
  | 'negative-parallel-density'
  | 'dash-decoration'
  | 'dash-insertion'
  | 'dash-list-ending'
  | 'emoji'
  | 'heading-colon'
  | 'summary-heading'
  | 'redundant-bracket'
  | 'sentence-end-repeat'
  | 'excess-bold'
  | 'excess-list'
  | 'bold-label-list'
  | 'bold-not-rendered';

/** A lint finding. STE rules leave `severity` unset; yomiyasu rules always set it. */
export interface LintWarning {
  line: number;
  rule: LintRule;
  message: string;
  suggestion: string;
  severity?: Severity;
}

/** A plain-text sentence used for the sentence-end repetition check. `group` is the paragraph it belongs to. */
export interface Sentence {
  line: number;
  text: string;
  group: number;
}

/** Character / line counts used for the bold and list frequency checks. `prose` is the body text length used by the score. */
export interface TextMetrics {
  chars: number;
  lines: number;
  listLines: number;
  bold: number;
  prose: number;
}

/** A line of a paragraph or list, with inline code and decoration removed. */
export interface UnitLine {
  line: number;
  text: string;
}

/** What a line's check needs from the lines around it. */
export interface LineContext {
  /** The source of the line with its markup, for the trailing colon and dashes after a link. */
  raw?: string;
  /** The text of the previous line (for 「もちろん、」 right after a question). */
  before?: string;
  /** The line is in a table, where a dash often means "not applicable". */
  table?: boolean;
  /** 「AでもBでもない。Cだ。」 found across soft line breaks starts on this line. */
  extraNegation?: boolean;
  /** An instruction left over for the AI was found in a sentence of this line. */
  residue?: boolean;
}

/** A `**` pair that does not render as bold, with a suggested fix (`suggest` is '' when none). */
export interface BoldProblem {
  line: number;
  found: string;
  suggest: string;
  how: string;
}

interface Pattern {
  re: RegExp;
  label: string;
}

export const SLOP_WORDS: readonly string[] = Object.freeze([
  // Pseudo-concrete words that fake texture
  '手触り', '肌感', '肌感覚', '体温', '温度感', '熱量', '血の通った', '泥臭い', '泥臭さ',
  // Words that fake insight or evaluation
  '解像度', '腹落ち', 'メンタルモデル', '本質的', '地に足のついた', '等身大',
  // Abstract metaphorical nouns
  '営み', '装置', '土台', '羅針盤', '起爆剤', '触媒',
  '真理', '虚飾', '境地', '美学', '深淵', '冷徹', '禁欲的', '優美', '極致', '宿命',
  '正本',
]);

export const SLOP_WORD_PATTERNS: readonly Pattern[] = Object.freeze([
  { re: /(?:(?<![ァ-ヴー])|(?<=レビュー)|(?<=リリース)|(?<=チェック)|(?<=デプロイ)|(?<=マージ)|(?<=テスト))(?<!搭乗)(?<!改札)ゲート(?!ウ[ェエ]イ|ボール|キーパー)/, label: 'ゲート' },
  { re: /(?<!推移)(?<!反射)(?<!対称)(?<!凸)(?<!代数)(?<!代数的)閉包(?!演算)/, label: '閉包' },
  { re: /(?<!資産)(?<!住民基本)(?<!会計)(?<!会計の)(?<!行政の)(?<!課税)(?<!土地)(?<!家屋)(?<!備品)(?<!登記)台帳/, label: '台帳' },
  { re: /(思考|意思決定|仕事|人生|組織|チーム|学習|経営)の?OS(?![A-Za-z])/, label: '〜のOS' },
  { re: /本質を突/, label: '本質を突く' },
]);

// Metaphorical verbs and verbs AI favors (yomiyasu's METAPHOR_VERB_PATTERNS).
const KOWARERU = '比喩動詞「壊れる」';
const SILENTLY = '英語直訳「静かに壊れる (silently fail)」';
export const METAPHOR_VERBS: readonly Pattern[] = Object.freeze([
  { re: /(地味に|よく|じわじわ)効[かきくけいた]/, label: '比喩動詞「効く」の過剰使用' },
  { re: /(データ|仕様|設計|環境|ビルド|システム|秩序)が(静かに)?壊れ/, label: KOWARERU },
  { re: /静かに(壊れ|落ち|失敗|沈黙)/g, label: SILENTLY },
  { re: /黙って(無視|捨て|スキップ|破棄)/, label: '英語直訳「黙って無視される」' },
  { re: /側に倒[すしせ]/, label: '判断を方向で表現する「〜側に倒す」' },
  { re: /時間[をに]溶か[さしすせそ]/, label: '比喩動詞「時間を溶かす」' },
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

export const TRANSLATED_TERMS: readonly Pattern[] = Object.freeze([
  { re: /(この|その|あの|新しい|古い|最新の|前の|次の|今の|現在の|以前の)版(では|で|に|から|を|が|へ|の)/, label: '「版」（version）' },
  { re: /(?<![一-龥ァ-ヴーA-Za-z0-9])版を(上げ|下げ|更新|戻)/, label: '「版」（version）' },
  { re: /(?<!原点)(?<!への)(?<!先祖)(?<!平均)回帰(が|を)(出|発生|起こ|起き|生じ|防)/, label: '「回帰」（regression）' },
]);

const OVERSTATEMENT = /とも?(?:言|い)(?:い切|いき)?っても(?:過言|言い過ぎ|言いすぎ|いいすぎ)(?:では(?:ありません|ない)|じゃ(?:ありません|ない))(?:です)?(?:でしょう|だろう|かもしれ(?:ません|ない)|と(?:思|おも)(?:います|う)|ね|よ)?(?:[（(][^）)]*[）)])?[。！？!?]?$/;

export const FILLERS: readonly (Pattern & { keep?: string })[] = Object.freeze([
  { re: /^(まず|ここで)?(重要|大切|大事)なのは、?/, label: '前置フィラー「重要なのは」' },
  { re: /^結論から(言|い)(う|い|え)|^結論から申し上げ/, label: '前置フィラー「結論から言うと」' },
  { re: /^正直に言うと、?/, label: '前置フィラー「正直に言うと」' },
  { re: /^本音を言うと、?/, label: '前置フィラー「本音を言うと」' },
  { re: /^避けたいのは、?/, label: '前置フィラー「避けたいのは」' },
  { re: /^ポイントは、/, label: '前置フィラー「ポイントは、」' },
  { re: /見落とされがち|面白いのはここ|まさにそこがポイント/, label: '自己ラベル「見落とされがち」など' },
  { re: /いかがでした(でしょうか|か)?[？?。]?$/, label: '定型クロージング「いかがでしたでしょうか」', keep: 'メールや手紙の結びの挨拶なら残してよい' },
  { re: /ぜひ(?:参考にして|試して|活用して)(?:みて)?ください[！!。]?/, label: '定型クロージング「ぜひ〜してみてください」', keep: '書き手が実際に勧めている内容なら残してよい' },
  {
    re: /参考に(なれ|な)ば幸い|お役に立て(れ)?ば幸い|ぜひご(活用|参考に)ください|まずは小さく(始め|はじめ)(?:ましょう|てみましょう|てください|てみてください|てみませんか|て(?:みて)?はいかが(?:ですか|でしょうか)|る(?:ことが(?:大切|大事|重要)|のがおすすめ)です)[。！？!?]?$/,
    label: '定型クロージング「参考になれば幸いです」など',
    keep: 'メールや手紙の結びの挨拶や、書き手が実際に勧めている内容なら残してよい',
  },
  { re: /に(?:他|ほか)なりません/, label: '過剰な自己ラベリング「〜に他なりません」' },
  { re: /^ご質問ありがとうございます/, label: 'チャット応答の名残「ご質問ありがとうございます」', keep: 'チャットやメールの返信そのものなら残してよい' },
  { re: /見ていきましょう[。！!]?$|深掘りしていきます/, label: '定型導入「それでは見ていきましょう」など' },
  {
    re: /^(必要なら|ご希望があれば|よろしければ)、?(次に|続けて|この後(?!の))[^。！？!?]*(?:ます|ましょう)(?:か|よ|ね|よね)?(?:（[^。！？!?（）]*）)?[。！？!?]?$/,
    label: 'チャット応答の名残「必要なら次に〜します」',
    keep: '書き手が読み手に実際に申し出ている案内なら残してよい',
  },
  {
    re: OVERSTATEMENT,
    label: '文末の付け足し「〜と言っても過言ではありません」',
    keep: '事実を淡々と書く。裏付けのある事実の強調や、引用・会話・表現そのものへの言及なら残してよい',
  },
]);

const INFO_SENTENCES: readonly { re: RegExp; rule: LintRule; message: string; suggestion: string }[] = Object.freeze([
  {
    re: /^(まとめると|総じて)、/,
    rule: 'summary-restatement',
    message: '言い直しの締め（「まとめると」「総じて」）です',
    suggestion: '本文の繰り返しなら削る。新しい情報や結論の絞り込み、長い文書の要約なら残す。削るときも、そこにしかない数値や条件は落とさない',
  },
  {
    re: /^本記事では/,
    rule: 'meta-intro',
    message: '「本記事では」で始まる案内です',
    suggestion: '続く本文と同じ内容の予告なら削る。長い文書の目次の役割なら残す',
  },
  {
    re: /(ポイント|理由|観点|コツ|方法)は(3|三|３)つ(です|あります)|以下の(3|三|３)つの(観点|ポイント)/,
    rule: 'count-declaration',
    message: '数の宣言（「ポイントは3つです」など）です',
    suggestion: '宣言した数と続く項目の数が合えば、宣言の文を中身とまとめるか削る。項目を数に合わせて足したり削ったりしない',
  },
]);

const DASH_CHARS = '—―─━';
const DASH_RUN = /[—―─━]+/;
const DASH_RUN_ALL = /[—―─━]+/g;
const DIAGRAM_CHARS = /[│┃├┣└┗┌┏┐┓┘┛┬┳┴┻┼╋╭╮╰╯]/;
const LIST_ITEM = '[^、。！？!?\\s—―─━]{1,12}';
const DASH_LIST_ENDING = new RegExp(`(?:^|(?<=[。！？!?]))\\s*${LIST_ITEM}(?:、[ \\t　]*${LIST_ITEM}){2,}[ \\t　]*[—―─━]+(?:[。．.]|$)`);
const DASH_INSERTION = /[—―─━]{1,2}[^—―─━。\n]{1,40}[—―─━]{1,2}/;
const ATTRIBUTION_LABEL = /^(?:出典|引用元|著者|Source|Author)\s*[:：]/i;
const ATTRIBUTION_BOOK = /^[一-龥々ァ-ヴーA-Za-z .・'’-]+『[^』]+』(?:[ \t　]*(?:（[^）]*）|\([^)]*\)))*[。.]?$/;
const ATTRIBUTION_ENGLISH = /^[A-Z][A-Za-z.'’−-]*(?:[ \t]+[A-Z][A-Za-z.'’−-]*)+,[ \t]+\S/;
const NON_ROUTE_ENDINGS = ['人間', '時間', '期間', '空間', '世間', '仲間', '手間', '目線', '視線', '動線', '光線', '伏線', '生命線', '方便', '利便', '不便'];
const LINK_ATTRIBUTION = /\][ \t]*[—―─━]+/g;
/** yomiyasu shows at most this many dash findings per document; the score counts all of them. */
export const DASH_FINDING_LIMIT = 3;

const FRAGMENT_RUN = /(?:^|(?<=[。！？]))(?:[^。！？、\s「」『』]{1,4}[。！]){3,}/;
const QUOTED_SEGMENT = /「[^「」]*」|『[^『』]*』|\[[^[\]]*\]/g;

const NOT_IDIOM = '(?<!何)(?<!なん)(?<!まんざら)(?<!とん)';
const NEGATION_CONCLUSION_END = '(?:[うくぐすつぬぶむるいだた]|だけ)(?:よね|よ|ね)?';
const NEGATION_NEGATIVE_END = '(?:[な無]い|[な無]かった|ません(?:でした)?)(?:(?:の|ん)(?:だ|です|だった|でした|である|であった)|です|でした|でしょう|だろう|であろう)?(?:よね|よ|ね)?';
const NEGATION_EXTRA = new RegExp(
  `(?:[^。、]{1,15}(?:では|じゃ)ない。[^。]{0,15}|[^。、]{1,15}(?<!それ)(?<!今)(?<!いつ)(?<!誰)(?<!何)でも、[^。、]{1,15})${NOT_IDIOM}でもない。`
  + `(?![^。！？!?]{0,40}${NEGATION_NEGATIVE_END}[。！!])[^。！？!?]{1,40}${NEGATION_CONCLUSION_END}[。！!]`,
);
const NEGATION_EXTRA_ALL = new RegExp(NEGATION_EXTRA.source, 'g');
const NEGATION_JANAI = /^(?:(?:でも|しかし|つまり|ただ|ただし|けれども?|けど|だが|それでも|だから)、)?(?![い良]いじゃない、|すごいじゃない、|凄いじゃない、)[^。、]{1,15}じゃない、[^。]{1,30}(?:です|だ)(?:よ|ね|よね)?[。！!]?$/;
const NEGATION_ALSO = /ではなく、?[^。]{1,40}?(?<!どこに)(?<!誰に)(?<!だれに)(?<!何)(?<!なん)(?<!いつ)でも(ある|あります|あった|ありました)/g;
// Only tested for a match, so one character on each side is enough. Capturing whole runs made long lines quadratic.
const NEGATIVE_PARALLEL = /[^。、]ではなく、?[^。、]/;

const SHORT_MOCHIRON = /^(もちろん|勿論)、[^。！？!?、「」『』]{1,10}[。！!]$/;
const MOCHIRON_ANSWER = /^(もちろん|勿論)、(大丈夫|構いません|かまいません|いいですよ|いいよ|できます|可能です|です|だ)/;
const QUESTION_CLOSERS = '」』）)"\'*_';
const QUESTION_SUFFIXES = ['ですか', 'ますか', 'ませんか', 'でしょうか', 'だろうか', 'のか', 'ないか', 'うか', 'くか', 'ぐか', 'すか', 'つか', 'ぬか', 'ぶか', 'むか', 'るか', 'たか', 'いいか', 'よいか'];
const WH_QUESTION = /なぜ|どうして(?!も)|どのよう(?:に|な)|いつ(?!でも|も|か(?!ら))|どこ(?!でも|も|か(?!ら))|誰(?!でも|も|か(?!ら))|何(?!でも|も|か(?!ら))|どれ(?!でも|も|か(?!ら))|どの(?![^。！？!?、]{1,12}でも)/;

const WRITING_ACTION = /(?:書(?:きます|く|いてみます|いていきます)|(?:説明|紹介|解説)し(?:ます|ていきます)|まとめ(?:ます|る|ていきます)|お伝えし(?:ます|ていきます)|述べ(?:ます|る)|振り返(?:ります|る|っていきます)|お話し?し(?:ます|ていきます)|お届けします|話していきます)[。！？!?]?$/;
const RESIDUE_OPENER = '^(?:この記事|本記事|本稿|このブログ|ここ|以下|今回)(?:では|は)';
const RESIDUE_OPENER_RE = new RegExp(RESIDUE_OPENER);
const WRITING_STYLE = /(?:トーン|文体|口調)で|(?:専門用語|箇条書き)を\s*(?:できるだけ|なるべく)?(?:使わず|用いず|避け)|(?:AI|ＡＩ)(?:っぽさ|らしさ)(?:が出ないよう|を(?:抑え|なく|避け))|飾らない言葉で|語り口で|トーンを意識|(?<![0-9０-９])[0-9０-９]+文?字(?:程度|以内|前後)?で/;
const WRITING_LIMIT = /に(?:絞って|限定して|焦点を(?:当てて|絞って))|触れず|扱わず|立ち入らず|[はを]抜きにして/;
const SCOPE_EXCLUSION = new RegExp(`${RESIDUE_OPENER}[^。！？!?]*(?:扱いません|扱わない|触れません|触れない|省きます|省く|割愛します|省略します)[。！？!?]?$`);
const READER_SCOPE = /^(?:この|本)?(?:マニュアル|手順書|ガイド|論文|研究)(?:では|は)/;
const SCOPE_REFERENCE = /参照|ご覧|別途|付録|後述|後ほど|別の?[^。！？!?]{0,8}(?:記事|ページ|章|節|報告書?|資料|文書|ガイド)|(?:後|次|前)の(?:章|節)|第[0-9０-９一二三四五六七八九十]+章/;

const REDUNDANT_BRACKET = /（(素の出力|いわゆる|概要|詳細|感謝と設計への反映)）/;
const SUMMARY_HEADING = /^(まとめ|おわりに)$/;
const BOLD_LABEL_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\*\*[^*]+?(?:\*\*\s*[:：]|[:：]\s*\*\*)/;
const SENTENCE_ENDS = ['です', 'ます', 'でした', 'ました', 'である', 'だ', 'だろう', 'でしょう', 'ですね'];
const SENTENCE_BREAK = /(?<=[。！？!?])/;

const DO = {
  slop: '文脈上いらない比喩や大げさな飾りなら、ふだんの言葉に置き換える。文字どおりの意味なら残してよい',
  metaphor: '不自然な比喩なら、ふだんの動詞や客観的な書き方にする。文字どおりの動作や状態の変化なら残してよい',
  translated: 'ソフトウェアの話なら「バージョン」「リグレッション」など現場で定着した言い方にする。出版物の「版」や回帰テストなどの用語は残してよい',
  filler: 'ただの前置きや飾りなら削り、本題から書く。評価そのものを担うなら述語に移して残す',
  negative: '否定を外しても主張が変わらないなら肯定文にする。誤解の訂正や見方の切り替えなら残してよい',
  negation: '否定した内容を誰も主張していないなら、言い切る文だけにする。思い込みを正す否定なら一つの文にまとめて残す',
  dash: '読点や助詞、かっこでつなぐか、文を分ける。小説や随筆で書き手が文体として使っているものや引用は残してよい',
};

const warn = (line: number, rule: LintRule, message: string, suggestion: string, severity: Severity = 'warn'): LintWarning => ({ line, rule, message, suggestion, severity });

const sentencesOf = (text: string): string[] => text.split(SENTENCE_BREAK).map((s) => s.trim()).filter(Boolean);

function maskQuoted(text: string): string {
  const closing: Record<string, string> = { '「': '」', '『': '』', '[': ']' };
  const stacks: Record<string, number[]> = { '」': [], '』': [], ']': [] };
  const changes: number[] = Array.from({ length: text.length + 1 }, () => 0);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (closing[ch]) stacks[closing[ch]].push(i);
    else if (stacks[ch]?.length) {
      changes[stacks[ch].pop() as number]++;
      changes[i + 1]--;
    }
  }
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    depth += changes[i];
    out += depth ? ' ' : text[i];
  }
  return out;
}

function maskRouteDashes(text: string): string {
  const noun = (ch: string): boolean => (ch >= '一' && ch <= '龥') || (ch >= 'ァ' && ch <= 'ヴ') || 'ー々'.includes(ch);
  const out = [...text];
  for (const m of text.matchAll(DASH_RUN_ALL)) {
    const left = m.index;
    const right = left + m[0].length;
    if (right - left !== 1 || left === 0 || right === text.length || !noun(text[left - 1]) || !noun(text[right])) continue;
    let end = right;
    while (end < text.length && noun(text[end])) end++;
    const dest = text.slice(right, end);
    for (let i = 0; i < dest.length; i++) {
      if (!'間線便'.includes(dest[i])) continue;
      const head = dest.slice(0, i + 1);
      const suffix = head.endsWith('区間') ? 2 : 1;
      if (i + 1 > suffix && !NON_ROUTE_ENDINGS.some((e) => head.endsWith(e))) {
        out[left] = ' ';
        break;
      }
    }
  }
  return out.join('');
}

function isDashAttribution(text: string): boolean {
  const t = text.trim();
  if (!t || !DASH_CHARS.includes(t[0])) return false;
  const credit = t.replace(/^[—―─━ \t　]+/, '');
  return ATTRIBUTION_LABEL.test(credit) || ATTRIBUTION_BOOK.test(credit) || ATTRIBUTION_ENGLISH.test(credit);
}

function checkDash(raw: string, line: number): LintWarning[] {
  if (!DASH_RUN.test(raw)) return [];
  let text = isDashAttribution(raw) ? raw.trimStart().replace(/^[—―─━]+/, '') : raw;
  text = maskRouteDashes(maskQuoted(text.replace(LINK_ATTRIBUTION, ']'))).trim();
  const rest = text.replace(/^[—―─━ 　]+|[—―─━ 　]+$/g, '');
  if (!DASH_RUN.test(text) || DIAGRAM_CHARS.test(text) || !rest) return [];
  if ([...rest].every((ch) => /[\p{P}\p{S}\p{Z}]/u.test(ch) || DASH_CHARS.includes(ch))) return [];
  if (DASH_LIST_ENDING.test(text)) {
    return [warn(line, 'dash-list-ending', '名詞を読点で並べ、末尾をダッシュ（──）で閉じています', '何についての列挙かを述語で言い切る。述語が文脈から分からなければ、推測で補わず書き手に確かめる')];
  }
  if (DASH_INSERTION.test(text)) return [warn(line, 'dash-insertion', '補足や言い換えをダッシュで挟んでいます', DO.dash)];
  return [warn(line, 'dash-decoration', 'ダッシュ（—、―、── など）があります', DO.dash)];
}

const linkText = (raw: string): string => raw.replace(/`[^`]*`/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\]\([^)]*\)/g, ']').replace(/[*_]{1,3}/g, '');

function checkVocabulary(text: string, line: number): LintWarning[] {
  const out: LintWarning[] = [];
  const words = [...SLOP_WORDS.filter((w) => text.includes(w)), ...SLOP_WORD_PATTERNS.filter(({ re }) => re.test(text)).map(({ label }) => label)];
  for (const word of words) out.push(warn(line, 'slop-word', `AI の文章に多い語「${word}」`, DO.slop));
  // Keep 「〜が壊れる」 and 「静かに壊れる」 from both hitting the same verb (same as yomiyasu).
  let kowareru: [number, number] | null = null;
  for (const { re, label } of METAPHOR_VERBS) {
    if (label === SILENTLY && kowareru) {
      const [ka, kb] = kowareru;
      const m = [...text.matchAll(re)].find((x) => !(ka <= x.index && x.index + x[0].length <= kb));
      if (m) out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
      continue;
    }
    const m = text.match(re);
    if (!m) continue;
    if (label === KOWARERU && m.index !== undefined) kowareru = [m.index, m.index + m[0].length];
    out.push(warn(line, 'metaphor-verb', `${label}：「${m[0]}」`, DO.metaphor));
  }
  return out;
}

const questionEnd = (s: string): number => {
  let end = s.length;
  while (end && (/\s/.test(s[end - 1]) || QUESTION_CLOSERS.includes(s[end - 1]))) end--;
  return end;
};

function lastSentence(text: string): string {
  const end = questionEnd(text);
  if (!end) return '';
  const start = Math.max(...[...'。！？!?'].map((mark) => text.lastIndexOf(mark, end - 2))) + 1;
  return text.slice(start, end);
}

function endsWithQuestion(sentence: string): boolean {
  let end = questionEnd(sentence);
  if (!end) return false;
  const explicit = '？?'.includes(sentence[end - 1]);
  if (!explicit && sentence[end - 1] === '。') end--;
  const head = sentence.slice(0, end);
  if (!explicit && (head.endsWith('いくつか') || !QUESTION_SUFFIXES.some((s) => head.endsWith(s)))) return false;
  return !WH_QUESTION.test(head);
}

export function checkLine(text: string, line: number, ctx: LineContext = {}): LintWarning[] {
  const out: LintWarning[] = [];
  if (!ctx.table) out.push(...checkDash(ctx.raw === undefined ? text : linkText(ctx.raw), line));
  const raw = (ctx.raw ?? text).trim();
  if (/[：:]$/.test(raw) && !/^:{3,}$/.test(raw) && !text.startsWith('http')) {
    out.push(warn(line, 'trailing-colon', '文末がコロン（：）です', 'ラベルと値の対応に要るか確かめ、ただの前置きなら句点（。）で終える'));
  }
  out.push(...checkVocabulary(text, line));
  for (const label of new Set(TRANSLATED_TERMS.filter(({ re }) => re.test(text)).map(({ label }) => label))) {
    out.push(warn(line, 'translated-term', `英語の直訳${label}`, DO.translated));
  }
  const sentences = sentencesOf(text);
  const masked = sentencesOf(maskQuoted(text));
  for (const { re, label, keep } of FILLERS) {
    if ((re === OVERSTATEMENT ? masked : sentences).some((s) => re.test(s))) out.push(warn(line, 'filler', label, keep ? `${DO.filler}。${keep}` : DO.filler));
  }
  for (const { re, rule, message, suggestion } of INFO_SENTENCES) {
    if (sentences.some((s) => re.test(s))) out.push(warn(line, rule, message, suggestion, 'info'));
  }
  if (ctx.residue) {
    out.push(warn(line, 'instruction-residue', 'AI への指示が本文に残る形（書き方や除外の予告）です', '書き方や除外の指示を述べる文を削る。読者のための範囲、前提、参照先、用語の定義なら残す', 'info'));
  }
  if (text.includes('もちろん、') || text.includes('勿論、')) {
    const i = sentences.findIndex((s, k) => SHORT_MOCHIRON.test(s) && !MOCHIRON_ANSWER.test(s) && !endsWithQuestion(k ? sentences[k - 1] : lastSentence(ctx.before ?? '')));
    if (i !== -1) {
      out.push(warn(line, 'short-mochiron', '文頭の「もちろん、」のあとに数語だけの短い文が続いています', '先回りして認めるだけなら「もちろん、」を外す。別の語で補ったり理由を足したりしない。問いへの答えや前提の確認なら残す', 'info'));
    }
  }
  if ((text.match(/[。！]/g)?.length ?? 0) >= 3 && FRAGMENT_RUN.test(text.replace(QUOTED_SEGMENT, '「」'))) {
    out.push(warn(line, 'fragment-run', '評価の語だけの短い文が 3 つ以上続いています（「効く。重い。安い。」など）', '何がどうなのかが分かるなら、対象と評価を述語までつなぐ。分からなければ原文を残して書き手に確かめる。書き手が意図した表現なら残してよい', 'info'));
  }
  const negations = text.split('ではなく').length - 1;
  if (negations && negations === [...text.matchAll(NEGATION_ALSO)].length) return out;
  if (NEGATIVE_PARALLEL.test(text)) {
    out.push(warn(line, 'negative-parallel', '「AではなくB」の構文です', DO.negative, 'info'));
  } else if (ctx.extraNegation || (text.includes('でもない。') && NEGATION_EXTRA.test(text)) || (text.includes('じゃない、') && sentences.some((s) => NEGATION_JANAI.test(s)))) {
    out.push(warn(line, 'negative-parallel', '否定を重ねてから言い切る構文です（「AでもBでもない。Cだ。」「Aじゃない、Bです。」）', DO.negation, 'info'));
  }
  return out;
}

export function unitContext(lines: readonly UnitLine[]): Map<number, Pick<LineContext, 'extraNegation' | 'residue'>> {
  const out = new Map<number, Pick<LineContext, 'extraNegation' | 'residue'>>();
  const set = (line: number, key: 'extraNegation' | 'residue') => out.set(line, { ...out.get(line), [key]: true });
  const joined = lines.map((l) => l.text).join('');
  if (joined.includes('でもない。')) {
    const offsets: number[] = [];
    let pos = 0;
    for (const l of lines) {
      offsets.push(pos);
      pos += l.text.length;
    }
    for (const m of joined.matchAll(NEGATION_EXTRA_ALL)) set(lines[offsets.findLastIndex((o) => o <= m.index)].line, 'extraNegation');
  }
  const masked = maskQuoted(lines.map((l) => l.text).join('\n'));
  let offset = 0;
  const records = lines.flatMap((l) => {
    const part = masked.slice(offset, offset + l.text.length);
    offset += l.text.length + 1;
    return sentencesOf(part).map((s) => ({ line: l.line, s }));
  });
  records.forEach(({ line, s }, i) => {
    if (hasInstructionResidue(s, records[i + 1]?.s ?? '')) set(line, 'residue');
  });
  return out;
}

function hasInstructionResidue(sentence: string, following: string): boolean {
  const writing = sentence.match(WRITING_ACTION);
  if (writing && (writing[0].includes('ます') || RESIDUE_OPENER_RE.test(sentence)) && WRITING_STYLE.test(sentence)) return true;
  if (!(SCOPE_EXCLUSION.test(sentence) || (writing && WRITING_LIMIT.test(sentence)))) return false;
  return !(READER_SCOPE.test(sentence) || SCOPE_REFERENCE.test(sentence) || SCOPE_REFERENCE.test(following));
}

export const isBoldLabelItem = (raw: string): boolean => BOLD_LABEL_ITEM.test(raw);

// Emoji (every line, including headings and tables).
export function checkEmoji(raw: string, line: number): LintWarning[] {
  const found = emojiMatches(raw);
  return found.length ? [warn(line, 'emoji', `絵文字（${found.slice(0, 3).join(' ')}）があります`, '飾りを外し、言葉で書く')] : [];
}

export function checkHeading(text: string, line: number): LintWarning[] {
  const plain = text.replace(/^\s*#{1,6}\s*/, '').replace(/`[^`]*`/g, '').replace(/[*_]{1,3}/g, '').trim();
  const out = checkDash(plain, line);
  if (/とは[：:]/.test(plain)) {
    out.push(warn(line, 'heading-colon', '見出しが「Xとは：Y」の形です', 'コロンのあとの語句を落とさず、「Xの仕組みと使い方」のような名詞句にする'));
  }
  if (SUMMARY_HEADING.test(plain)) {
    out.push(warn(line, 'summary-heading', '短い文書に「まとめ」「おわりに」の見出しがあります', '本文の繰り返しなら削る。新しい情報や結論の絞り込み、数値を担うなら残す', 'info'));
  }
  if (REDUNDANT_BRACKET.test(plain)) out.push(warn(line, 'redundant-bracket', '見出しに情報の増えない補足のかっこがあります', 'かっこを削る'));
  out.push(...checkVocabulary(plain, line));
  return out;
}

export function checkSentenceEnds(sentences: readonly Sentence[]): LintWarning[] {
  const out: LintWarning[] = [];
  let prev: Sentence | null = null;
  let prevEnd: string | null = null;
  let count = 1;
  for (const s of sentences) {
    const end = endKind(s.text.replace(/[。！？\s]+$/, ''));
    if (end && end === prevEnd && prev?.group === s.group) {
      count++;
      if (count === 3) out.push(warn(s.line, 'sentence-end-repeat', `文末の「${end}」が 3 回以上続いています`, '読みにくくなっていないか確かめ、文末の形を変える。自然な説明や文体なら残してよい'));
    } else {
      count = 1;
    }
    prev = s;
    prevEnd = end;
  }
  return out;
}

// Determines the sentence-ending kind, checking in the same order as yomiyasu.
function endKind(s: string): string | null {
  return SENTENCE_ENDS.find((e) => s.endsWith(e)) ?? null;
}

// Bold and list frequency. Only checked when the body text exceeds 300 characters.
export function checkMetrics({ chars, lines, listLines, bold }: TextMetrics, line = 1): LintWarning[] {
  const out: LintWarning[] = [];
  if (chars <= 300) return out;
  const perThousand = Math.round((bold / chars) * 1000 * 100) / 100;
  const ratio = lines ? listLines / lines : 0;
  if (perThousand > 3.0) {
    out.push(warn(line, 'excess-bold', `太字が多すぎます（1,000 字あたり ${perThousand} 個。目安は 2.0 以下）`, '強調の役割を確かめ、いらない太字だけを外す'));
  }
  if (ratio > 0.25) {
    out.push(warn(line, 'excess-list', `箇条書きの行が多すぎます（${Math.round(ratio * 1000) / 10}%。目安は 15% 以下）`, '項目の役割を確かめ、考えや論理の流れは地の文で書く'));
  }
  return out;
}

export function documentChecks(warnings: readonly LintWarning[], metrics: TextMetrics, boldLabelLines: readonly number[]): { warnings: LintWarning[]; dashHits: number } {
  let dashHits = 0;
  const out = warnings.filter((w) => {
    if (w.rule === 'summary-heading') return metrics.chars < 2000;
    if (!DASH_RULES.has(w.rule)) return true;
    return ++dashHits <= DASH_FINDING_LIMIT;
  });
  const negations = [...new Set(out.filter((w) => w.rule === 'negative-parallel').map((w) => w.line))];
  if (negations.length >= 3) {
    out.push(warn(negations[2], 'negative-parallel-density', `否定の対比（「AではなくB」など）が文書に ${negations.length} か所あります（行 ${negations.slice(0, 5).join(', ')}）`, '1 か所ずつ役割を確かめ、言い切れば足りる所だけを肯定文にする', 'info'));
  }
  if (boldLabelLines.length >= 3) {
    out.push(warn(boldLabelLines[0], 'bold-label-list', `太字の見出し語とコロンで始まる箇条書きが ${boldLabelLines.length} 行あります（行 ${boldLabelLines.slice(0, 5).join(', ')}）`, '値が日時や数値などの短い事実なら残す。見出し語が抽象的で値が一文の説明なら、地の文にするか太字とコロンを外す', 'info'));
  }
  return { warnings: out, dashHits };
}

const DASH_RULES: ReadonlySet<LintRule> = new Set(['dash-decoration', 'dash-insertion', 'dash-list-ending']);
const DOCUMENT_WEIGHTS: Partial<Record<LintRule, number>> = { 'excess-bold': 2, 'excess-list': 2, 'bold-label-list': 1 };
const SEVERITY_WEIGHTS: Record<Severity, number> = { error: 3, warn: 2, info: 1 };

export function aiScore(warnings: readonly Pick<LintWarning, 'rule' | 'severity'>[], proseChars = 0, dashHits = 0): number {
  const found = warnings.filter((w) => w.severity);
  if (!found.length) return 100;
  let lineWeight = 0;
  let docWeight = 0;
  for (const w of found) {
    const doc = DOCUMENT_WEIGHTS[w.rule];
    if (doc !== undefined) docWeight += doc;
    else if (w.rule !== 'negative-parallel-density' && w.severity) lineWeight += SEVERITY_WEIGHTS[w.severity];
  }
  lineWeight += Math.max(0, dashHits - found.filter((w) => DASH_RULES.has(w.rule)).length) * SEVERITY_WEIGHTS.warn;
  const m = Math.max(proseChars, 1000);
  const num = 100 * 40 * m;
  const den = (40 + docWeight) * m + 1000 * lineWeight;
  return Math.max(1, Math.min(99, Math.floor((2 * num + den) / (2 * den))));
}


// Warnings are printed on one line, so newlines inside multi-line bold are shown as ↵.
const oneLine = (s: string): string => s.replace(/\n/g, '↵');

export function checkBold(text: string, startLine: number): LintWarning[] {
  return boldProblems(text, { startLine, skipFrontmatter: false }).map((p) => warn(
    p.line, 'bold-not-rendered', `太字の印（**）が記号に接していて、太字にならず ** がそのまま表示されます：「${oneLine(p.found)}」`,
    p.suggest ? `${p.how}：「${oneLine(p.suggest)}」` : p.how, 'error',
  ));
}
