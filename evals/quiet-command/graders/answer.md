---
type: llm
---

PASS if the reply gives a shell command that deletes local branches already merged (for example using `git branch --merged` and `git branch -d`) and keeps the current or main branch out of it.
FAIL if there is no command, or the reply produces a diagram or a page instead.
