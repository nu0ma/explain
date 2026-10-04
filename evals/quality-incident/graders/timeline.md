---
type: llm
focus: trace
---

Look at the explainer the agent produced: the Markdown script in the last `render` command it ran, or the HTML it wrote.

PASS if the events are shown in time order with the times from the log (a timeline or equivalent), and the recovery steps (batch stopped, rollback) are visible.

FAIL if the timeline is missing, reordered, or uses times that are not in the log.
