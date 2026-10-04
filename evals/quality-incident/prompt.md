---
description: An incident log with several actors. The page should give the cause first and show the timeline and the message flow.
tags: [quality]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write]
---

昨夜の障害の経緯と原因を HTML で説明してください。ページは ./out.html に保存してください。

```text
02:10 デプロイ v2.31.0 開始（決済 API のコネクションプール上限を 50 → 20 に変更する設定を含む）
02:14 デプロイ完了
02:31 バッチ「月次請求」開始。決済 API を 1 秒に 300 回呼ぶ
02:33 決済 API の p99 レイテンシが 180ms → 4.2s。DB 接続の待ちでタイムアウトが出始める
02:35 アラート「payment-api 5xx > 5%」発火。オンコールが調査開始
02:41 フロントの注文 API が決済 API のタイムアウトを受けてリトライ（最大 3 回）。決済 API への呼び出しが 2.4 倍に増える
02:48 オンコールがバッチを停止。5xx は 12% → 3%
02:55 v2.30.4 にロールバック。プール上限が 50 に戻る
03:02 5xx が 0.1% 未満に戻る。アラート解消
```

補足: プール上限を下げたのは DB の最大接続数の警告を消すためだった。注文 API のリトライには間隔がない。
