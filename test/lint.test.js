import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from '../src/parse.js';
import { lintDoc, splitSentences, sentenceLength, formatWarning } from '../src/lint/ste.js';

const lint = (body) => lintDoc(parseDoc(body));
const rules = (ws) => ws.map((w) => w.rule);

test('splitSentences: 「。！？」で区切り、閉じ括弧は前の文に含める', () => {
  const cases = [
    { req: '先にバルブを閉じる。次にポンプを外す！よいか？', want: ['先にバルブを閉じる。', '次にポンプを外す！', 'よいか？'] },
    { req: '「引用。」と書いた。', want: ['「引用。」', 'と書いた。'] },
    { req: 'version 3.5 を入れる', want: ['version 3.5 を入れる'] },
    { req: '', want: [] },
  ];
  for (const { req, want } of cases) assert.deepEqual(splitSentences(req), want, req);
});

test('sentenceLength: 全角文字は句読点を除いて 1 字、英単語・識別子は 1 語を 1 字と数える', () => {
  const cases = [
    { req: 'Node で動かす。', want: 5 },
    { req: 'src/cli.js を 3 回直す。', want: 6 },
    { req: '、。「」', want: 0 },
  ];
  for (const { req, want } of cases) assert.equal(sentenceLength(req), want, req);
});

test('文の長さ：説明は 45 字、手順（順序付きリスト）は 35 字が上限', () => {
  const cases = [
    { req: `## A\n${'説'.repeat(45)}。`, want: [] },
    { req: `## A\n${'説'.repeat(46)}。`, want: ['sentence-length'] },
    { req: `## A\n1. ${'手'.repeat(35)}`, want: [] },
    { req: `## A\n1. ${'手'.repeat(36)}`, want: ['sentence-length'] },
    { req: `## A\n- ${'手'.repeat(36)}`, want: [] },
  ];
  for (const { req, want } of cases) assert.deepEqual(rules(lint(req)), want, req);
});

test('文の長さ：警告に行番号と上限を出す', () => {
  const [w] = lint(`## A\n一行目。\n${'説'.repeat(46)}。`);
  assert.equal(w.line, 3);
  assert.match(w.message, /^文が 46 字です（上限 45）/);
});

test('段落が 6 文を超えると paragraph-length', () => {
  const ws = lint('## A\n一。二。三。\n四。五。六。七。');
  assert.deepEqual(rules(ws), ['paragraph-length']);
  assert.equal(ws[0].line, 2);
  assert.deepEqual(rules(lint('## A\n一。二。三。\n四。五。六。')), []);
});

test('冗長な動詞句を警告し、言い換え例を出す', () => {
  const cases = [
    { req: '設定の確認を行う。', want: '確認する' },
    { req: '設定の確認を行います。', want: '確認します' },
    { req: '負荷試験を実施する。', want: '負荷試験する' },
    { req: '移行の実施を行う。', want: '実施する' },
    { req: '手順を説明させていただく。', want: '説明する' },
    { req: '設定を保存することができる。', want: '保存できる' },
    { req: '遅いということがわかった。', want: 'こと（または削る）' },
  ];
  for (const { req, want } of cases) {
    const ws = lint(`## A\n${req}`);
    assert.deepEqual(ws.map((w) => [w.rule, w.suggestion]), [['verbose', want]], req);
  }
});

test('冗長な動詞句：「実施を行う」は「を行う」と二重に数えない', () => {
  assert.equal(lint('## A\n移行の実施を行う。').length, 1);
});

test('ぼかし表現を警告する。行に「推測：」があれば警告しない', () => {
  const cases = [
    { req: '原因はキャッシュと考えられる。', want: ['hedge'] },
    { req: '原因はキャッシュと思われます。', want: ['hedge'] },
    { req: '原因はキャッシュかもしれない。', want: ['hedge'] },
    { req: '設計として妥当と言える。', want: ['hedge'] },
    { req: '推測：原因はキャッシュと考えられる。', want: [] },
    { req: '- 推測: 原因はキャッシュかもしれない。', want: [] },
    { req: '原因はキャッシュである。', want: [] },
  ];
  for (const { req, want } of cases) assert.deepEqual(rules(lint(`## A\n${req}`)), want, req);
});

test('強調・誇張の語を警告する。「大変更」は対象外', () => {
  const cases = [
    { req: '非常に速い。', want: ['emphasis'] },
    { req: '極めて遅い。', want: ['emphasis'] },
    { req: 'とても大きい。', want: ['emphasis'] },
    { req: '大変な作業だ。', want: ['emphasis'] },
    { req: '必ずしも速くない。', want: ['emphasis'] },
    { req: 'この設定は重要である。', want: ['emphasis'] },
    { req: 'API に大変更を入れる。', want: [] },
  ];
  for (const { req, want } of cases) assert.deepEqual(rules(lint(`## A\n${req}`)), want, req);
});

test('「の」が続く名詞句（A の B の C の D 以上）を警告する', () => {
  const cases = [
    { req: '画面の右上のボタンの色を変える。', want: ['no-chain'] },
    { req: '画面の右上のボタンを押す。', want: [] },
  ];
  for (const { req, want } of cases) assert.deepEqual(rules(lint(`## A\n${req}`)), want, req);
});

test('対象外：コード、インラインコード、取り消し線、状態が no の行、見出し、部品', () => {
  const src = `## A
\`\`\`js
// 確認を行う
\`\`\`
\`確認を行う()\` を呼ぶ。~~非常に重要である。~~
| 書き方 | 状態 |
|---|---|
| 確認を行う。 | no |
### 確認を行う見出し
\`\`\`annot
[確認を行う]{!冗長} 例。
\`\`\``;
  assert.deepEqual(lint(src), []);
});

test('callout の本文と、表のふつうのセルは検査する', () => {
  const ws = lint('## A\n```callout warn 注意\n確認を行う。\n```\n| a |\n|---|\n| とても速い。 |');
  assert.deepEqual(ws.map((w) => [w.line, w.rule]), [[3, 'verbose'], [7, 'emphasis']]);
});

test('導入文も検査する', () => {
  assert.equal(lint('導入で確認を行う。\n## A\nx').length, 1);
});

test('formatWarning: 行番号・規則・内容・言い換え', () => {
  const s = formatWarning({ line: 4, rule: 'verbose', message: '冗長な表現「確認を行う」（を行う）', suggestion: '確認する' });
  assert.equal(s, 'L4 [verbose] 冗長な表現「確認を行う」（を行う） → 確認する');
});

// yomiyasu（https://github.com/nanaism/yomiyasu）の README の「比較例1」から引いた修正前と修正後の文。
const YOMIYASU_BEFORE = `## A
ここで**重要なのは、単なるパーツの共通化ではなく、組織の意思決定OSとしてのガバナンス**です。

従来の開発では、画面ごとに手触り感を探りながらパーツを作っていました。しかし、片方だけを見て画面を作ると、もう片方のアクセシビリティが**静かに壊れます**。そこでデザインシステムという**強固な土台**を置くことで、開発者の**解像度が一段上がります**。

- **開発速度の加速**: コンポーネントを再利用することで、時間を溶かさずに済みます。
- **仕様の収斂**: 判断に迷うスタイルは、あらかじめ**共通側に倒します**。

もちろん、これは「デザイナーが不要になる」ことを意味しません。日々の開発に**地味に効いてきます**。ぜひ参考にしてみてください！
`;

const YOMIYASU_AFTER = `## A
デザインシステムを導入する目的は、ボタンや入力欄などのUIパーツを一から作成する負担を減らし、画面全体の情報設計に集中することにあります。

導入によってデザイン作業そのものが不要になるわけではありません。しかし、単純なパーツ作成にかかる工数を削減することで、本来注力すべき使い勝手の検証や品質向上に時間を充てられるようになります。
`;

const AI_RULES = new Set(['slop-word', 'metaphor-verb', 'filler', 'emoji']);
const aiFindings = (src) => lint(src).filter((w) => AI_RULES.has(w.rule)).map((w) => `${w.rule}:${w.message.match(/「([^」]+)」/)[1]}`);

test('AI の文章に多い表現：yomiyasu の修正前の文で検出し、修正後の文では検出しない', () => {
  assert.deepEqual(aiFindings(YOMIYASU_BEFORE), [
    'filler:重要なのは',
    'slop-word:意思決定OS',
    'slop-word:手触り',
    'metaphor-verb:静かに壊れ',
    'slop-word:解像度が高い',
    'metaphor-verb:時間を溶かさ',
    'metaphor-verb:側に倒し',
    'metaphor-verb:地味に効い',
    'filler:ぜひ〜してみてください',
  ]);
  assert.deepEqual(aiFindings(YOMIYASU_AFTER), []);
});

test('AI の文章に多い表現：技術文書で文字どおりに使う語や記号は検出しない', () => {
  const cases = [
    { name: '絵文字', req: '## A\nデプロイした 🚀', want: ['emoji:🚀'] },
    { name: '異体字セレクタつきの記号', req: '## A\n注意 ⚠️ を読む。', want: ['emoji:⚠️'] },
    { name: '状態語とキーの記号', req: '## A\n| 項目 | 結果 |\n|---|---|\n| 速度 | ✓ 速い |\n\n⌘ と ✗ と ⚠ を押す。', want: [] },
    { name: '画面の解像度', req: '## A\n画面の解像度は 1920 × 1080 にする。', want: [] },
    { name: 'データの破損', req: '## A\n書き込み中に止まるとデータが壊れる。', want: [] },
    { name: '文中の「重要なのは」', req: '## A\nここで確かめて重要なのは順序だと分かった。', want: [] },
    { name: 'コードと取り消し線は対象外', req: '## A\n`手触り` と ~~腹落ち~~ を例に挙げる。', want: [] },
    { name: '見出しは対象外', req: '## 腹落ちする設計\n本文。', want: [] },
    { name: 'callout も対象', req: '## A\n```callout info 注\nいかがでしたか？\n```', want: ['filler:いかがでしたでしょうか'] },
  ];
  for (const { name, req, want } of cases) assert.deepEqual(aiFindings(req), want, name);
});
