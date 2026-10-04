# explain

Markdown の原稿から、1 ファイルで完結する解説 HTML と、3b1b 風の解説動画を作る CLI。日本語で仕事をする 1 人のエンジニア向けに作り直した個人用の道具で、出力も CLI の表示も日本語だけ。

## 用途

- PR の変更前と変更後、障害の流れ、システムの構成を 1 ページの図解にする。
- 図（flow / sequence / tree など）は関係だけを書けば自動で配置される。
- 原稿の説明文を日本語の STE 規則（文の長さ、冗長な表現、ぼかし表現など）で検査する。
- `--static` で `<script>` のない HTML を出し、JavaScript を禁止した配信先（Pageshelf の safe mode など）に置く。

## 使い方

```sh
npm ci
npm link                      # explain コマンドを入れる（または node bin/explain.js）

explain render examples/pr-before-after.md          # 解説ページを作ってブラウザで開く
explain render examples/pr-before-after.md --static # script なしの HTML を作る
explain lint   examples/pr-before-after.md          # STE 検査だけする
explain video  原稿.md --voice system               # 解説動画の再生ページを作る（--mp4 で MP4 も）
explain help format                                 # 原稿の書式
explain list                                        # 部品・テーマの一覧
explain config                                      # 設定の確認と変更
```

- 出力先は `~/.explain-cli/pages/` と `~/.explain-cli/videos/`、設定は `~/.explain-cli/config.json`。環境変数 `EXPLAIN_HOME` で場所を変えられる。
- `npm run build` で、依存を含めた 1 ファイルの `dist/explain.mjs` ができる。Node 20 以上があれば単体で動く。
- 動画の音声は ElevenLabs（`ELEVENLABS_API_KEY`）、macOS の `say`（Kyoko などの日本語の声）、Linux の `espeak-ng` の順に使う。

## License

MIT. See [LICENSE](LICENSE).
