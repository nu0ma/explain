---
type: llm
focus: trace
---

The explain CLI prints a JSON report after each render (`warnings`, `layout.issues`, `error`).

PASS if the last render's report has no warnings and no layout issues, or the agent told the user which warnings remain after at most 2 retries.

FAIL if the agent stopped while the last report still had warnings or layout issues and did not mention them, or if no render ran at all.
