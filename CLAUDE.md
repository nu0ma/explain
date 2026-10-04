# explain-cli

## コミットメッセージとPRのタイトル

コミットメッセージとPRのタイトルは英語で書く。
形式はConventional Commits（`feat: ...`、`fix: ...`など）に従う。

## コード

ソースはTypeScriptで書き、ビルドせずにNodeで直接動かす。
Nodeの型の除去で動かすので、enumやnamespaceなど消せない構文は使わない。
コードのコメントは英語で書く。

## 日本語の文章

このリポジトリで日本語の文章を書くときは、すべて`yomiyasu`スキルで推敲してから出す。
CLIのヘルプとメッセージが対象になる。
テストの名前とIssueのコメントも同じように扱う。

`yomiyasu`は`apm.yml`に書いてあり、`apm install --frozen`で`.claude/skills/yomiyasu/`に展開される。

推敲するときは、部品の構文を変えない。
コードブロックの中身、ノード名、差分の印（`+->`、`x->`）は空白も含めてそのまま残す。
パネルのID（`## A 題名`）、表の状態語（`ok`、`no`、`warn`）、calloutの引数も同じように残す。
