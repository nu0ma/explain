---
type: llm
focus: trace
weight: 3
---

Look at the video script the agent produced (the Markdown passed to `explain video`, or the HTML/JS the agent wrote).

PASS only if all of these hold:
- 3 to 6 scenes, each with one main component (or one table or list) on screen.
- In each scene, the order of the narration lines follows the order of the steps on screen (for a sequence, the N-th line talks about the N-th message).
- Narration is spoken Japanese, as if explaining to a person, not manual-style text.
- `[name]` in narration (if used) names an element that is on screen in that scene, such as a participant or node.
- The explanation answers the question: why three messages (both sides must confirm they can send and receive, and agree on initial sequence numbers).

FAIL if narration and on-screen steps do not line up, scenes are crowded with several diagrams, or the "why three" question is not answered.
