---
type: llm
focus: trace
---

PASS if the agent read the script format with `explain help format` (or the help of the components it used) before rendering, passed the script to `explain render -` on stdin, and gave the user the output path instead of pasting HTML.

FAIL if it skipped the help, wrote the HTML by hand, or pasted the page into the reply.
