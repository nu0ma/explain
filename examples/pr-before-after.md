---
title: 検索 API に結果キャッシュを入れる
subtitle: PR の変更前と変更後
cols: 2
source: github.com/example/search/pull/123
---
検索 API は同じ条件の検索でも毎回 Elasticsearch に問い合わせていた。この PR は Redis に結果を 60 秒だけ置き、2 回目以降の応答を速くする。

## A 変更前 {meta="毎回 ES に問い合わせる"}
```flow LR
(利用者) -> 検索 API: GET /search
検索 API -> [(Elasticsearch)]: 毎回クエリ
```

## B 変更後 {meta="キャッシュを先に見る"}
```flow LR
(利用者) -> 検索 API: GET /search
検索 API -> {キャッシュにある?}
キャッシュにある? -> [(Redis)]: はい
キャッシュにある? --> *[(Elasticsearch)]: いいえ
```

## C 何が変わるか {span=2}
| 観点 | 変更前 | 変更後 |
|---|---|---|
| 応答時間（中央値） | warn 420 ms | ok 35 ms（キャッシュに当たった場合） |
| ES への問い合わせ | warn 毎回 | ok 60 秒に 1 回 |
| 結果の新しさ | ok 常に最新 | warn 最大 60 秒古い |
| 新しい依存 | ok なし | warn Redis |

## D レビューで見る点
1. キャッシュのキーに検索条件をすべて含めているか確かめる。
2. Redis が落ちたとき、ES に直接問い合わせるか確かめる。
3. 掲載を止めた物件が 60 秒で消えるか確かめる。

```callout warn 注意
掲載停止の反映が最大 60 秒遅れる。すぐに消す必要がある操作では、キャッシュを明示的に消す。
```
