---
type: llm
focus: trace
weight: 3
---

Look at the explainer the agent produced (the Markdown script passed to the explain CLI, or the HTML the agent wrote).

PASS only if all of these hold:
- The page is built around one clear point (for example: reads now hit Redis first, and DB load drops), stated at the top of the page, in the lead or the first panel.
- The read path is shown before and after with the same nodes (API/repository, Redis, DB), and the added parts (Redis, the cache lookup, the cache delete on update) are marked as added.
- It covers what happens on a cache miss or when Redis is down (the code falls back to the DB), and that Update deletes the cache entry.
- Numbers come from the input (1,200 reads per second, 80% CPU, 90% expected hit rate, 5 minute TTL), or are calculated from them and labeled as an estimate. No invented measurements.
- Node and panel names describe what things do, not just code identifiers like `getCache` or `findDB`.

FAIL if the page has no clear conclusion, shows only the after state, invents numbers, or is a wall of text without a diagram.
