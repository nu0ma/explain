# explain-cli

## 日本語の文章

- このリポジトリで日本語の文章を書くときは、すべて`yomiyasu`スキルで推敲してから出す。対象は、原稿の例（`examples/`）、CLIのヘルプとメッセージ、コードのコメント、テストの名前、コミットメッセージ、Issueのコメント。
- `yomiyasu`は`apm.yml`で入る（`apm install --frozen`で`.claude/skills/yomiyasu/`に展開される）。
- 原稿の例を直したら`node bin/explain.js lint <原稿>`を実行し、yomiyasuの規則の警告が出ないことを確かめる。
- 推敲で部品の構文は変えない。コードブロックの中身、ノード名、差分の印（`+->`、`x->`）、パネルのID（`## A 題名`）、表の状態語（`ok`、`no`、`warn`）、calloutの引数は空白も含めてそのまま残す。
