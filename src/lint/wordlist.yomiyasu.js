// AI が書いた日本語に多い語と句の一覧。yomiyasu（https://github.com/nanaism/yomiyasu）v1.0.5 の
// scripts/yomiyasu_lint.py にある SLOP_WORDS、METAPHOR_VERB_PATTERNS、FILLER_PATTERNS、EMOJI_PATTERN から、
// 技術文書で誤検出の少ないものを選んで移植した。外したもの：
// - 文字どおりの意味でよく使う語（体温、装置、土台、触媒、正本、本質的、メンタルモデルなど）と、単独の「解像度」
// - 「データが壊れる」など、技術文書では文字どおりの意味になる「〜が壊れる」と「した瞬間」
// - 「AではなくB」（yomiyasu でも info の扱い。技術文書では正確な対比によく使う）
// - ✓ ✗ ⚠ ⌘ などの記号（表の状態語やキーの表記に使う）。絵文字として表示される文字だけを対象にする
//
// 移植した一覧には yomiyasu のライセンスが適用される：
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

// 質感や評価を装う語、大げさな抽象名詞。「解像度」は「解像度が高い／を上げる」の形だけを数える。
export const JA_SLOP_WORDS = Object.freeze([
  { re: /手触り/g, label: '手触り' },
  { re: /肌感覚?/g, label: '肌感' },
  { re: /温度感/g, label: '温度感' },
  { re: /熱量/g, label: '熱量' },
  { re: /血の通った/g, label: '血の通った' },
  { re: /泥臭[いさく]/g, label: '泥臭い' },
  { re: /解像度(?:が[^。、]{0,4}?(?:高|上が|低)|を[^。、]{0,4}?(?:上げ|高め))/g, label: '解像度が高い' },
  { re: /腹落ち/g, label: '腹落ち' },
  { re: /地に足のついた/g, label: '地に足のついた' },
  { re: /等身大/g, label: '等身大' },
  { re: /意思決定OS/g, label: '意思決定OS' },
  { re: /羅針盤/g, label: '羅針盤' },
  { re: /起爆剤/g, label: '起爆剤' },
  { re: /真理/g, label: '真理' },
  { re: /虚飾/g, label: '虚飾' },
  { re: /境地/g, label: '境地' },
  { re: /美学/g, label: '美学' },
  { re: /深淵/g, label: '深淵' },
  { re: /極致/g, label: '極致' },
  { re: /宿命/g, label: '宿命' },
]);

// 比喩の動詞と、英語を直訳した言い回し。
export const JA_METAPHOR_VERBS = Object.freeze([
  { re: /(?:地味に|よく|じわじわ)効[かきくけいた]/g, label: '効く' },
  { re: /静かに(?:壊れ|落ち|失敗|沈黙)/g, label: '静かに壊れる（silently fail の直訳）' },
  { re: /黙って(?:無視|捨て|スキップ|破棄)/g, label: '黙って無視される' },
  { re: /側に倒[すしせ]/g, label: '〜側に倒す' },
  { re: /時間[をに]溶か[さしたす]/g, label: '時間を溶かす' },
  { re: /(?:1つずつ|一つずつ)潰[さしすせ]/g, label: '潰す' },
  { re: /(?:実装|詳細|コード|設計|内部|仕組み|領域|本質)(?:に|まで|へ)踏み込[んむみま]/g, label: '踏み込む' },
  { re: /動かしながら引き返[すし]/g, label: '引き返す' },
  { re: /代わりに添え[るた]/g, label: '添える' },
  { re: /(?:議論|意見|結論|方向性|価格|話題|検討)が[^。！？!?]*?収斂/g, label: '収斂する' },
  { re: /(?:前提|基盤)が崩れ[るた]/g, label: '前提が崩れる' },
  { re: /文化が醸成/g, label: '文化が醸成される' },
  { re: /プロセスが定着/g, label: 'プロセスが定着する' },
  { re: /事例が残した/g, label: '事例が残した' },
]);

// 前置きと締めの定型句。文の頭か終わりにあるときだけ数える。
export const JA_FILLERS = Object.freeze([
  { re: /^(?:まず|ここで)?重要なのは/, label: '重要なのは' },
  { re: /^結論から言うと/, label: '結論から言うと' },
  { re: /^正直に言うと/, label: '正直に言うと' },
  { re: /^避けたいのは/, label: '避けたいのは' },
  { re: /いかがでした(?:でしょうか|か)?[？?。]?$/, label: 'いかがでしたでしょうか' },
  { re: /ぜひ(?:参考|試し|活用)(?:に)?して(?:みて)?ください[！!。]?$/, label: 'ぜひ〜してみてください' },
  { re: /に(?:他|ほか)なりません[。]?$/, label: '〜に他なりません' },
]);

// 絵文字として表示される文字（✓ ✗ ⚠ ⌘ などの記号は含まない）。
export const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/gu;
