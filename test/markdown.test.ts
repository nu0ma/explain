import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md, mdInline } from '../src/markdown.ts';
import { renderDoc } from '../src/render.ts';
import { ParseError } from '../src/parse.ts';

test('md: ブロックの書き方ごとに HTML を出す', () => {
  const cases = [
    { name: '段落', req: '一行目\n二行目\n\n次の段落', want: '<p>一行目\n二行目</p>\n<p>次の段落</p>\n' },
    { name: '見出し', req: '# 一\n## 二 *斜体*\n#### 四 ####\n#タグ', want: '<h1>一</h1>\n<h2>二 <em>斜体</em></h2>\n<h4>四</h4>\n<p>#タグ</p>\n' },
    { name: '区切り線', req: '---\n***\n_ _ _', want: '<hr>\n<hr>\n<hr>\n' },
    { name: '箇条書き', req: '- a\n- b', want: '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n' },
    { name: '番号付きリストの開始番号', req: '3. 三\n4. 四', want: '<ol start="3">\n<li>三</li>\n<li>四</li>\n</ol>\n' },
    { name: '記号が変わると別のリスト', req: '* a\n+ b', want: '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>\n' },
    { name: '空行で区切ったリストは項目を段落にする', req: '- a\n\n- b', want: '<ul>\n<li><p>a</p>\n</li>\n<li><p>b</p>\n</li>\n</ul>\n' },
    { name: '引用', req: '> 引用\n>\n> 二段落目', want: '<blockquote>\n<p>引用</p>\n<p>二段落目</p>\n</blockquote>\n' },
    { name: '引用の中のリスト', req: '> - a\n> - b', want: '<blockquote>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n</blockquote>\n' },
    { name: '引用の段落は > のない行に続く', req: '> a\nb', want: '<blockquote>\n<p>a\nb</p>\n</blockquote>\n' },
    { name: 'コードブロック', req: '```js\nif (a < b && c) {}\n```', want: '<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {}\n</code></pre>\n' },
    { name: 'チルダのコードブロック', req: '~~~\nx\n~~~', want: '<pre><code>x\n</code></pre>\n' },
    { name: 'コードブロックのタブは残す', req: '```go\n\tif err != nil {\n```', want: '<pre><code class="language-go">\tif err != nil {\n</code></pre>\n' },
    { name: '字下げのコード', req: '    a\n    b', want: '<pre><code>a\nb\n</code></pre>\n' },
    { name: '段落の途中の字下げはコードにしない', req: 'a\n    b', want: '<p>a\nb</p>\n' },
    { name: 'リストは段落に割り込む', req: '段落\n- 項目', want: '<p>段落</p>\n<ul>\n<li>項目</li>\n</ul>\n' },
    { name: '1 以外で始まる番号は段落に割り込まない', req: '段落\n2. 続き', want: '<p>段落\n2. 続き</p>\n' },
  ];
  for (const { name, req, want } of cases) assert.equal(md(req), want, name);
});

test('md: 入れ子のリスト', () => {
  const cases = [
    {
      name: '箇条書きと番号付きの入れ子',
      req: '- a\n- b\n  - b1\n    1. x\n    2. y\n- c',
      want: '<ul>\n<li>a</li>\n<li>b<ul>\n<li>b1<ol>\n<li>x</li>\n<li>y</li>\n</ol>\n</li>\n</ul>\n</li>\n<li>c</li>\n</ul>\n',
    },
    {
      name: '番号付きの子は番号の後ろの位置にそろえる',
      req: '1. a\n   - b\n2. c',
      want: '<ol>\n<li>a<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ol>\n',
    },
    {
      name: '字下げの足りない子は別のリストになる',
      req: '1. a\n  - b',
      want: '<ol>\n<li>a</li>\n</ol>\n<ul>\n<li>b</li>\n</ul>\n',
    },
    {
      name: '子のリストの空行は親のリストを段落にしない',
      req: '- a\n  - b\n\n  - c\n- d',
      want: '<ul>\n<li>a<ul>\n<li><p>b</p>\n</li>\n<li><p>c</p>\n</li>\n</ul>\n</li>\n<li>d</li>\n</ul>\n',
    },
    {
      name: '項目の中の引用とコード',
      req: '- a\n  > 引用\n- ```\n  code\n  ```',
      want: '<ul>\n<li>a<blockquote>\n<p>引用</p>\n</blockquote>\n</li>\n<li><pre><code>code\n</code></pre>\n</li>\n</ul>\n',
    },
    {
      name: '項目の段落は字下げのない行に続く',
      req: '- a\nb\n- c',
      want: '<ul>\n<li>a\nb</li>\n<li>c</li>\n</ul>\n',
    },
    {
      name: '引用の中の項目に続く行',
      req: '> - a\nb',
      want: '<blockquote>\n<ul>\n<li>a\nb</li>\n</ul>\n</blockquote>\n',
    },
    {
      name: '引用の中のコードブロックは > のない行で終わる',
      req: '> ```\n> x\ny',
      want: '<blockquote>\n<pre><code>x\n</code></pre>\n</blockquote>\n<p>y</p>\n',
    },
  ];
  for (const { name, req, want } of cases) assert.equal(md(req), want, name);
});

test('md: 表（揃え、インラインコード、エスケープした |）', () => {
  const cases = [
    {
      name: '揃え',
      req: '| 左 | 中 | 右 | 無 |\n|:--|:-:|--:|---|\n| a | b | c | d |',
      want: '<div class="am-table-wrap"><table>\n<thead>\n<tr>\n<th align="left">左</th>\n<th align="center">中</th>\n<th align="right">右</th>\n<th>無</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align="left">a</td>\n<td align="center">b</td>\n<td align="right">c</td>\n<td>d</td>\n</tr>\n</tbody></table></div>\n',
    },
    {
      name: 'インラインコードと \\|',
      req: '| a | b |\n|---|---|\n| `x \\| y` | p \\| q |',
      want: '<div class="am-table-wrap"><table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td><code>x | y</code></td>\n<td>p | q</td>\n</tr>\n</tbody></table></div>\n',
    },
    {
      name: 'セルの数は見出しにそろえる',
      req: '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |',
      want: '<div class="am-table-wrap"><table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td></td>\n</tr>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table></div>\n',
    },
    {
      name: '段落の直後の表',
      req: '前置き\n| a |\n|---|\n| 1 |',
      want: '<p>前置き</p>\n<div class="am-table-wrap"><table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n</tr>\n</tbody></table></div>\n',
    },
    {
      name: '状態語のバッジ',
      req: '| a |\n|---|\n| ok 承認済み |\n| okay |',
      want: '<div class="am-table-wrap"><table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n<tbody><tr>\n<td><span class="am-status am-status--ok"><span class="am-status-icon" aria-hidden="true">✓</span>承認済み</span></td>\n</tr>\n<tr>\n<td>okay</td>\n</tr>\n</tbody></table></div>\n',
    },
    { name: '区切り行の列数が違えば段落', req: '| a | b |\n|---|', want: '<p>| a | b |\n|---|</p>\n' },
  ];
  for (const { name, req, want } of cases) assert.equal(md(req), want, name);
});

test('mdInline: インラインの書き方ごとに HTML を出す', () => {
  const cases = [
    { name: 'コード', req: '`a < b` と `` x ` y ``', want: '<code>a &lt; b</code> と <code>x ` y</code>' },
    { name: '閉じないコード', req: '`a', want: '`a' },
    { name: '太字と斜体', req: '**太** *斜* _斜_ __太__ ***両方***', want: '<strong>太</strong> <em>斜</em> <em>斜</em> <strong>太</strong> <em><strong>両方</strong></em>' },
    { name: '入れ子の強調', req: '**a *b* c** *a **b** c*', want: '<strong>a <em>b</em> c</strong> <em>a <strong>b</strong> c</em>' },
    { name: '単語の中の _ は強調にしない', req: 'snake_case_name', want: 'snake_case_name' },
    { name: '取り消し線は ~~ だけ', req: '~~消す~~ ~一つ~', want: '<del>消す</del> ~一つ~' },
    { name: 'かっこを閉じた直後の ** は文字の前では閉じない（GitHub と同じ）', req: '次は**「立場」**を読む', want: '次は**「立場」**を読む' },
    { name: '日本語の中の太字', req: '日本語**強調**です', want: '日本語<strong>強調</strong>です' },
    { name: 'リンク', req: '[文 **太**](https://example.com/a?b=1&c=2 "題")', want: '<a href="https://example.com/a?b=1&amp;c=2" title="題">文 <strong>太</strong></a>' },
    { name: '日本語の URL は符号化する', req: '[日本](https://ja.wikipedia.org/wiki/日本)', want: '<a href="https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC">日本</a>' },
    { name: '自動リンク', req: '<https://example.com/x>', want: '<a href="https://example.com/x">https://example.com/x</a>' },
    { name: '本文の URL', req: '参照：https://example.com/a_(b)。', want: '参照：<a href="https://example.com/a_(b)">https://example.com/a_(b)</a>。' },
    { name: 'バックスラッシュのエスケープ', req: '\\*a\\* \\`b\\` \\[c\\] \\\\ \\<', want: '*a* `b` [c] \\ &lt;' },
    { name: '強制改行', req: 'a  \nb\\\nc\nd', want: 'a<br>b<br>c\nd' },
    { name: '文字参照は残し、ほかの & は書き換える', req: '&copy; &amp; & AT&T', want: '&copy; &amp; &amp; AT&amp;T' },
  ];
  for (const { name, req, want } of cases) assert.equal(mdInline(req), want, name);
});

test('md: HTML のタグは文字として出す', () => {
  const cases = [
    { name: '文中のタグ', req: '<b>太</b> <script>alert(1)</script>', want: '<p>&lt;b&gt;太&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;</p>\n' },
    { name: 'ブロックのタグ', req: '<div>\nx\n</div>', want: '<p>&lt;div&gt;\nx\n&lt;/div&gt;</p>\n' },
    { name: 'コメント', req: 'a <!-- メモ --> b', want: '<p>a &lt;!-- メモ --&gt; b</p>\n' },
    { name: '属性の引用符', req: '<img src=x onerror="alert(1)">', want: '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>\n' },
  ];
  for (const { name, req, want } of cases) assert.equal(md(req), want, name);
});

test('md: JavaScript を実行するリンクはリンクにせず、書いたとおりの文字で出す', () => {
  const cases = [
    { name: 'javascript:', req: '[x](javascript:alert(1))', want: '[x](javascript:alert(1))' },
    { name: '大文字', req: '[x](JaVaScRiPt:alert(1))', want: '[x](JaVaScRiPt:alert(1))' },
    { name: '文字参照', req: '[x](&#106;avascript:alert(1))', want: '[x](&#106;avascript:alert(1))' },
    { name: 'タブ入り', req: '[x](<java\tscript:alert(1)>)', want: '[x](&lt;java\tscript:alert(1)&gt;)' },
    { name: 'vbscript:', req: '[x](vbscript:msgbox)', want: '[x](vbscript:msgbox)' },
    { name: 'data:', req: '[x](data:text/html,x)', want: '[x](data:text/html,x)' },
    { name: '自動リンク', req: '<javascript:alert(1)>', want: '&lt;javascript:alert(1)&gt;' },
    { name: '相対パスはリンクにする', req: '[x](./javascript.html)', want: '<a href="./javascript.html">x</a>' },
  ];
  for (const { name, req, want } of cases) assert.equal(mdInline(req), want, name);
});

test('render --static: Markdown のリンクやタグにある JavaScript もエラーにする', () => {
  const cases = ['## A\n[x](javascript:alert(1))', '## A\n<javascript:alert(1)>', '## A\n[x](&#106;avascript:alert(1))'];
  for (const src of cases) assert.throws(() => renderDoc(src, { static: true }), ParseError, src);
  assert.doesNotThrow(() => renderDoc('## A\n<script>alert(1)</script> <img src=x onerror=alert(1)>', { static: true }), 'Markdown のタグは文字になるので通す');
});

test('md: 長い入力や深い入れ子でもすぐに終わる', () => {
  const cases = [
    '[['.repeat(8000),
    '[a]('.repeat(10000),
    '*a'.repeat(20000),
    '`a` **'.repeat(1000),
    `${'> a\nb\n'.repeat(3000)}`,
    `${'- '.repeat(20000)}x`,
    ('a' + ' '.repeat(5000) + '\n').repeat(50),
    `https://a.b/${')'.repeat(20000)}`,
  ];
  for (const req of cases) {
    const start = performance.now();
    md(req);
    assert.ok(performance.now() - start < 500, `${req.slice(0, 20)}: ${Math.round(performance.now() - start)}ms`);
  }
});
