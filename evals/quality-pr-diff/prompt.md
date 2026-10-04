---
description: A diff that adds a read-through cache. The page should show the read path before and after with the same nodes.
tags: [quality]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write]
---

この PR の変更前と変更後を図で説明してください。ページは ./out.html に保存してください。

```diff
diff --git a/internal/user/repository.go b/internal/user/repository.go
@@ -1,24 +1,48 @@
 package user
 
 type Repository struct {
-	db *sql.DB
+	db    *sql.DB
+	cache *redis.Client
 }
 
+const cacheTTL = 5 * time.Minute
+
 func (r *Repository) Find(ctx context.Context, id string) (*User, error) {
+	if u, err := r.getCache(ctx, id); err == nil {
+		return u, nil
+	} else if !errors.Is(err, redis.Nil) {
+		// Redis が落ちていても DB から読めるようにする
+		log.Warn("cache unavailable", "err", err)
+	}
 	u, err := r.findDB(ctx, id)
 	if err != nil {
 		return nil, err
 	}
+	_ = r.setCache(ctx, id, u, cacheTTL)
 	return u, nil
 }
 
 func (r *Repository) Update(ctx context.Context, u *User) error {
-	return r.updateDB(ctx, u)
+	if err := r.updateDB(ctx, u); err != nil {
+		return err
+	}
+	// 更新後に古いキャッシュを返さないよう、キャッシュを消す
+	return r.deleteCache(ctx, u.ID)
 }
```

PR の説明: ユーザー情報の読み取りが 1 秒に 1,200 回あり、DB の CPU 使用率が 80% を超えていた。読み取りの前に Redis を置き、ヒット率 90% を見込む。
