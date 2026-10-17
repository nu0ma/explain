import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from '../src/parse.ts';
import { readFileSync } from 'node:fs';
import { lintDoc, lintReport, splitSentences, sentenceLength, formatWarning } from '../src/lint/ste.ts';
import { aiScore, boldProblems } from '../src/lint/yomiyasu.ts';
import type { LintRule, LintWarning, Severity } from '../src/lint/yomiyasu.ts';
import { renderDoc } from '../src/render.ts';

const lint = (body: string) => lintDoc(parseDoc(body));
const rules = (ws: LintWarning[]) => ws.map((w) => w.rule);

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
  const ws = lint('## A\n一つ目の文。二つ目の文。三つ目の文。\n四つ目の文。五つ目の文。六つ目の文。七つ目の文。');
  assert.deepEqual(rules(ws), ['paragraph-length']);
  assert.equal(ws[0].line, 2);
  assert.deepEqual(rules(lint('## A\n一つ目の文。二つ目の文。三つ目の文。\n四つ目の文。五つ目の文。六つ目の文。')), []);
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

// Checks ported from yomiyasu (https://github.com/nanaism/yomiyasu). Expected values match the results of running
// scripts/yomiyasu_lint.py from yomiyasu v2.0.1 on the same text.

// The "before" text of 「比較例1」 in yomiyasu's README.
const YOMIYASU_BEFORE = `ここで**重要なのは、単なるパーツの共通化ではなく、組織の意思決定OSとしてのガバナンス**です。

従来の開発では、画面ごとに手触り感を探りながらパーツを作っていました。しかし、片方だけを見て画面を作ると、もう片方のアクセシビリティが**静かに壊れます**。そこでデザインシステムという**強固な土台**を置くことで、開発者の**解像度が一段上がります**。

- **開発速度の加速**: コンポーネントを再利用することで、時間を溶かさずに済みます。
- **仕様の収斂**: 判断に迷うスタイルは、あらかじめ**共通側に倒します**。

もちろん、これは「デザイナーが不要になる」ことを意味しません。日々の開発に**地味に効いてきます**。ぜひ参考にしてみてください！
`;

const aiFindings = (src: string) => lint(src).filter((w) => w.severity).map((w) => `${w.line}:${w.rule}`);

test('yomiyasu：README の修正前の文で、yomiyasu と同じ指摘とスコアを出す', () => {
  const { warnings, proseChars, dashHits } = lintReport(parseDoc(YOMIYASU_BEFORE));
  const ws = warnings.filter((w) => w.severity);
  assert.deepEqual(ws.map((w) => `${w.line}:${w.rule}`).sort(), [
    '1:excess-bold', '1:excess-list', '1:filler', '1:negative-parallel', '1:slop-word',
    '3:metaphor-verb', '3:slop-word', '3:slop-word', '3:slop-word',
    '5:metaphor-verb', '6:metaphor-verb', '8:filler', '8:metaphor-verb',
  ]);
  assert.equal(aiScore(ws, proseChars, dashHits), 62);
});

test('yomiyasu：行ごとの規則', () => {
  const cases = [
    { name: '語', req: '## A\n手触りと腹落ちを確かめる。', want: ['2:slop-word', '2:slop-word'] },
    { name: '比喩の動詞', req: '## A\n設定を共通側に倒す。', want: ['2:metaphor-verb'] },
    { name: '「壊れる」と「静かに壊れる」は二重に数えない', req: '## A\nデータが静かに壊れる。', want: ['2:metaphor-verb'] },
    { name: '前置き', req: '## A\n結論から言うと、速くなった。', want: ['2:filler'] },
    { name: '締め', req: '## A\nいかがでしたか？', want: ['2:filler'] },
    { name: 'AではなくB は参考', req: '## A\n速さではなく正しさを選ぶ。', want: ['2:negative-parallel'] },
    { name: '英単語の前後の半角空白は見ない（yomiyasu 1.0.8 で取り下げ）', req: '## A\nこれは Redis を使う。', want: [] },
    { name: '文末のコロン', req: '## A\n手順は次のとおり：', want: ['2:trailing-colon'] },
    { name: 'インラインコードを除いて残ったコロンは文末のコロンではない', req: '## A\n- 場所：`a.yml`', want: [] },
    { name: '形で確かめる語', req: '## A\n組織のOSを作る。レビューゲートを置く。', want: ['2:slop-word', '2:slop-word'] },
    { name: '英語の直訳', req: '## A\nこの版では回帰が出た。', want: ['2:translated-term', '2:translated-term'] },
    { name: '前置きと締めは文ごとに見る', req: '## A\n速くなった。大切なのは、測ることだ。参考になれば幸いです。', want: ['2:filler', '2:filler'] },
    { name: '過言ではない', req: '## A\n革命と言っても過言ではありません。', want: ['2:filler'] },
    { name: '言い直しの締めと数の宣言は参考', req: '## A\nまとめると、速い。ポイントは3つです。', want: ['2:summary-restatement', '2:count-declaration'] },
    { name: 'AI への指示の残り', req: '## A\n今回は専門用語を使わずに説明します。', want: ['2:instruction-residue'] },
    { name: '参照先を示す範囲の宣言は残す', req: '## A\nこの記事では設定を扱いません。詳しくは付録を参照してください。', want: [] },
    { name: '短い「もちろん、」', req: '## A\nもちろん、失敗もする。', want: ['2:short-mochiron'] },
    { name: '問いへの答えの「もちろん、」は残す', req: '## A\n使えますか？\nもちろん、使える。', want: [] },
    { name: '評価の語だけの短い文', req: '## A\n効く。重い。安い。', want: ['2:fragment-run'] },
    { name: '否定を重ねて言い切る', req: '## A\n車でも、家でもない。有頂天だ。', want: ['2:negative-parallel'] },
    { name: '「AではなくBでもある」は残す', req: '## A\n道具ではなく文化でもある。', want: [] },
    { name: 'ダッシュ', req: '## A\n今日——正確には昨日——連絡した。\n速さ、軽さ、静けさ──。\n結果は良好だ──と思う。', want: ['2:dash-insertion', '3:dash-list-ending', '4:dash-decoration'] },
    { name: '区間のダッシュとリンクのあとの著者は見ない', req: '## A\n東京─大阪間を走る。\n- [記事](https://example.com) — 著者', want: [] },
    { name: '見出しの「Xとは：Y」と短い文書のまとめ', req: '## 設定とは：使い方\n本文。\n### まとめ\n本文。', want: ['1:heading-colon', '3:summary-heading'] },
    { name: '見出しの語も見る', req: '## 解像度を上げる\n本文。', want: ['1:slop-word'] },
    { name: '絵文字（見出しも）', req: '## 公開 🚀\nデプロイした 🎉', want: ['1:emoji', '2:emoji'] },
    { name: '見出しの補足のかっこ', req: '## 設計（概要）\n本文。', want: ['1:redundant-bracket'] },
    { name: '題名の見出しも見る', req: '# 題名（詳細）\n## A\n本文。', want: ['1:redundant-bracket'] },
    { name: '表のセルとナレーションの引用も見る', req: '## A\n| 項目 | 説明 |\n|---|---|\n| 速度 | 手触りがよい |\n\n> 腹落ちした。', want: ['4:slop-word', '6:slop-word'] },
    { name: '表の状態語の記号は絵文字ではない', req: '## A\n| 項目 | 結果 |\n|---|---|\n| 速度 | ✓ 速い |\n| 量 | ⚠ 多い |', want: [] },
    { name: '絵文字の表示を選んだ状態語の記号は絵文字', req: '## A\n| 項目 | 結果 |\n|---|---|\n| 量 | ⚠️ 多い |', want: ['4:emoji'] },
    { name: '文字の表示を選んだ記号と©は絵文字ではない', req: '## A\n晴れは☀︎で、著作権は©で示す。', want: [] },
    { name: 'コードと取り消し線は見ない', req: '## A\n`手触り` と ~~腹落ち~~ を例に挙げる。', want: [] },
  ];
  for (const { name, req, want } of cases) assert.deepEqual(aiFindings(req), want, name);
});

test('yomiyasu：文末の繰り返しと、太字・箇条書きの頻度', () => {
  const long = '説明の文を書く。'.repeat(40);
  const cases = [
    { name: '同じ文末が 3 文続く', req: '## A\n処理が速いです。値段が安いです。本体が軽いです。', want: ['2:sentence-end-repeat'] },
    { name: '2 文なら出さない', req: '## A\n処理が速いです。値段が安いです。本体は重い。', want: [] },
    { name: '段落をまたいでは数えない', req: '## A\n処理が速いです。値段が安いです。\n\n本体が軽いです。', want: [] },
    { name: '「でしょう」も数える', req: '## A\n速いでしょう。安いでしょう。軽いでしょう。', want: ['2:sentence-end-repeat'] },
    { name: 'リストの文は数えない', req: '## A\n- 速いです。\n- 安いです。\n- 軽いです。', want: [] },
    { name: '箇条書きが多い', req: `## A\n${long}\n- 一\n- 二\n- 三`, want: ['1:excess-list'] },
    { name: '太字が多い', req: `## A\n${long}**一**と**二**と**三**と**四**を書く。`, want: ['1:excess-bold'] },
    { name: '300 字以下なら頻度は見ない', req: '## A\n短い文を書く。\n- 一\n- 二', want: [] },
    { name: '否定の対比が 3 か所', req: '## A\n速さではなく正しさ。\n\n量ではなく質。\n\n形ではなく中身。', want: ['2:negative-parallel', '4:negative-parallel', '6:negative-parallel', '6:negative-parallel-density'] },
    { name: '太字の見出し語とコロンの箇条書きが 3 行', req: '## A\n- **速さ**: 速い\n- **量**: 多い\n- **形**: 丸い', want: ['2:bold-label-list'] },
    { name: 'ダッシュの指摘は 3 件まで', req: `## A\n${'結果は良好だ──と思う。\n'.repeat(5)}`, want: ['2:dash-decoration', '3:dash-decoration', '4:dash-decoration'] },
  ];
  for (const { name, req, want } of cases) assert.deepEqual(aiFindings(req), want, name);
});

test('yomiyasu：太字にならない ** は直し方の案つきで出す', () => {
  const cases = [
    { req: '次に**「文書の立場」**を決めます。', wantHow: 'かっこの内側だけを太字にする', wantSuggest: '「**文書の立場**」' },
    { req: 'これは**必須です。**詳しくは下に書きます。', wantHow: '句読点を太字の外に出す', wantSuggest: '**必須です**。' },
    { req: '立場は**「勧め」か「決まり」**で決めます。', wantHow: '文字に接する側に半角スペースを入れる', wantSuggest: ' **「勧め」か「決まり」** ' },
    { req: '次は** 重要**です', wantHow: '太字の内側の空白を取る', wantSuggest: '次は**重要**です' },
    { req: '次に**「太字は1行目から始まり、\n2行目で閉じる。」**を決めます。', wantHow: 'かっこの内側だけを太字にする', wantSuggest: '「**太字は1行目から始まり、\n2行目で閉じる。**」' },
  ];
  for (const { req, wantHow, wantSuggest } of cases) {
    const got = boldProblems(req);
    assert.equal(got.length, 1, req);
    assert.equal(got[0].how, wantHow, req);
    assert.ok(got[0].suggest.includes(wantSuggest), `${req}: ${got[0].suggest}`);
  }
  const [w] = lint('## A\n前置き。\n次は**「立場」**を読む。').filter((x) => x.rule === 'bold-not-rendered');
  assert.equal(w.line, 3, '太字の開きの行');
  assert.equal(w.severity, 'error');
  assert.match(w.message, /「。↵次は\*\*「立場」\*\*を読む。」/);
});

test('yomiyasu：太字の対応は ** の区切りの規則で決め、リンク先とコードブロックの中は見ない', () => {
  const cases = [
    { req: '**foo,**bar**baz**', want: [] },
    { req: '[参照](https://example.invalid/a**「x」**b)', want: [] },
    { req: '    a**「x」**b', want: [] },
    { req: '<span>a**「x」**b</span>', want: ['かっこの内側だけを太字にする'] },
    { req: 'a***「x」***b', want: ['手で直す'] },
    { req: 'a**「x」**b**「y」**c', want: ['手で直す'] },
  ];
  for (const { req, want } of cases) assert.deepEqual(boldProblems(req).map((p) => p.how), want, req);
});

test('yomiyasu：太字の fixture（yomiyasu の tests/fixtures/bold_regressions.json）の全 50 件', () => {
  type BoldCase = { id: string; text: string; expected_bold_problems: number | null; expected_line_numbers: number[] };
  const cases: BoldCase[] = JSON.parse(readFileSync(new URL('./fixtures/yomiyasu/bold_regressions.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 50);
  for (const { id, text, expected_bold_problems: wantCount, expected_line_numbers: wantLines } of cases) {
    const got = boldProblems(text);
    // A null count marks a block-boundary case; only check that no fix spanning blocks is suggested (same as yomiyasu).
    if (wantCount === null) {
      assert.equal(got.some((p) => p.suggest), false, id);
      continue;
    }
    assert.equal(got.length, wantCount, id);
    if (wantCount > 0 && wantLines.length) assert.deepEqual(got.map((p) => p.line), wantLines, id);
  }
});

test('yomiyasu：参考（info）の指摘は strict でも生成を止めない。スコアは候補の重みを地の文 1,000 字あたりに直して出す', () => {
  assert.doesNotThrow(() => renderDoc('---\nstyle: strict\n---\n## A\n速さではなく正しさを選ぶ。\n'));
  assert.throws(() => renderDoc('---\nstyle: strict\n---\n## A\n手触りを確かめる。\n'), /STE 検査で警告が 1 件/);
  const w = (rule: LintRule, severity?: Severity) => ({ rule, severity });
  const cases: { name?: string; req: Pick<LintWarning, 'rule' | 'severity'>[]; prose?: number; dash?: number; want: number }[] = [
    { req: [], want: 100 },
    { req: [w('slop-word', 'warn'), w('bold-not-rendered', 'error'), w('negative-parallel', 'info')], want: 87 },
    { req: [w('sentence-length')], want: 100 },
    { req: Array.from({ length: 30 }, () => w('slop-word', 'warn')), want: 40 },
    { req: Array.from({ length: 500 }, () => w('slop-word', 'warn')), want: 4 },
    { name: '地の文が長いと 1 件の重みは小さい', req: [w('slop-word', 'warn')], prose: 4000, want: 99 },
    { name: '文書単位の候補', req: [w('excess-bold', 'warn')], want: 95 },
    { name: '件数の上限で隠したダッシュも数える', req: [w('dash-decoration', 'warn')], dash: 5, want: 80 },
  ];
  for (const { name, req, prose, dash, want } of cases) assert.equal(aiScore(req, prose, dash), want, name ?? JSON.stringify(req.slice(0, 3)));
  assert.match(formatWarning({ line: 3, rule: 'negative-parallel', message: 'm', severity: 'info' }), /^L3 \[negative-parallel\]（参考） m$/);
});

test('「AではなくB」の検出は、長い 1 行でもすぐに終わる', () => {
  const start = performance.now();
  lintDoc(parseDoc(`## A\n${'a あ'.repeat(16000)}`));
  assert.ok(performance.now() - start < 1000, `${Math.round(performance.now() - start)}ms`);
});

test('太字の検査は、インラインコードと崩れた太字が多い 1 行でもすぐに終わる', () => {
  const text = '`a` **'.repeat(1000);
  const start = performance.now();
  const problems = boldProblems(text);
  assert.ok(performance.now() - start < 500, `${Math.round(performance.now() - start)}ms`);
  assert.equal(problems.length, 999);
  assert.ok(problems.every((p) => p.how === '手で直す'), '** が 3 つ以上ある段落で、内側の空白だけが原因なら直し方を決めない');
});
