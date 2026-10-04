---
title: Transactional Outbox
subtitle: DBの更新とイベントの送信を食い違わせない
cols: 3
---

Transactional Outboxでは、業務データとイベントを同じトランザクションでDBに書く。
別のプロセスがoutboxテーブルを読み、ブローカーへ送る。
DBの更新とイベントの送信が食い違わなくなる。

## A 二重書き込みの問題 {span=3}
```flow LR
(注文API) -> [(orders)]: INSERT
(注文API) --> ブローカー: publish（失敗しうる）
ブローカー -> 在庫サービス
```

DBへの書き込みとブローカーへの送信は、1つのトランザクションにできない。
DBに書いたあとで送信に失敗すると、在庫サービスは注文を知らないままになる。

## B Outboxを使う形 {span=3}
```flow LR
(注文API) -> [(orders)]: INSERT
(注文API) +-> +[(outbox)]: INSERT
group 1つのトランザクション: orders, outbox
outbox +-> +リレー: 未送信の行を読む
リレー +-> ブローカー: publish
ブローカー -> 在庫サービス
```

注文APIは、ordersとoutboxに同じトランザクションで書く。
リレーはoutboxの未送信の行を読み、ブローカーへ送る。

## C 送信の順序
```sequence num
注文API -> DB: ordersとoutboxにINSERT
DB --> 注文API: COMMIT
リレー -> DB: 未送信の行を読む
リレー -> ブローカー: publish
ブローカー --> リレー: ack
リレー -> DB: 送信済みにする
```

## D 二重書き込みとの比較 {span=2}
| 観点 | 二重書き込み | Outbox |
| --- | --- | --- |
| DBだけ更新される | no 起きる | ok 起きない |
| イベントの遅れ | ok ほぼない | warn リレーの間隔だけ遅れる |
| 同じイベントの重複 | warn 再送すると起きる | warn 起きる |
| 部品の数 | ok 少ない | warn リレーが増える |

## E リレーの作り方
| 方式 | 読み方 | 注意点 |
| --- | --- | --- |
| ポーリング | 一定の間隔で未送信の行をSELECTする | DBに読み込みの負荷がかかる |
| CDC | DBの変更ログを読む（例：Debezium） | 変更ログを読む仕組みを運用する |

## F 受け手の条件 {span=2}
```callout warn 重複は防げない
リレーは、送ったあとで「送信済み」と記録する前に落ちることがある。
そのときは同じイベントをもう一度送る。
受け手はイベントのIDで重複を捨て、冪等に処理する。
```
