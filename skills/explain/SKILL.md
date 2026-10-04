---
name: explain
argument-hint: "[config [key value] | cache [clear]]"
description: >-
  Explains something as a single-file explainer HTML page, or as a narrated explainer video
  when the user asks for one. You write a short Markdown script; the bundled CLI renders it
  and checks the Japanese prose. Use it when the user asks to explain something visually
  ("explain this PR", "draw a diagram", "図にして", "HTML で説明して", "動画で説明して"),
  or when the answer involves 3+ related concepts, a flow with branches or several actors,
  a before/after change, an incident timeline, an architecture, or a comparison across 3+
  dimensions. Not for short answers, commands to copy and run, or pure code changes.
---

# explain

The reader is an engineer who works in Japanese and wants to understand one thing quickly.
The CLI handles layout, themes, and diagrams. Your job is the script, and the script decides
whether the page is useful.

## Plan the page

- Put the conclusion first: in the lead or the first panel, as a `callout`.
  The panels after it give the evidence.
- Plan 3 to 8 panels. Each panel answers one question, and its heading states the answer.
  If you need more than 8, split the topic or cut panels.
- Leave out what does not help the reader understand the conclusion.
- Do not invent data. Use real numbers from the input; if a number is only an example or your own
  calculation, say so. Without real numbers, do not use `limits`.
- State as fact only what the input says. Label your own inferences and recommendations as yours,
  so the reader can tell them apart from the facts.

## Choose components by the shape of the information

| Shape | Component |
|---|---|
| What connects to what, architecture, decision branches | `flow` |
| Messages between actors over time | `sequence` |
| Hierarchy, directories, taxonomy | `tree` |
| History, phases | `timeline` |
| Values against a limit | `limits` |
| Comments on parts of one sentence | `annot` |
| Metadata, a title block | `kv` |
| Conclusion, warning | `callout` |
| Comparison across dimensions, can/cannot lists | Markdown table with `ok` / `no` / `warn` |

- Run `explain help <component>` for the syntax of a component before you use it.
- Before and after: show both sides with the same nodes, and mark what was added or removed.
- Name nodes by what they do for the reader, not by code identifiers.
- Use `html` / `svg` blocks only when no component fits, and color them with the theme CSS variables.

## Prose

- Write the script in Japanese. The page, the video, and the prose check are Japanese only.
- One sentence says one thing. Put details in the diagram, not in long paragraphs.
- Call one thing by one name throughout the page.

## Video

Make a video only when the user asks for one.

- 3 to 6 scenes. Each scene has one component (or one table or list) on screen and 2 to 5 narration lines.
- The N-th narration line reveals the N-th step, so the order of lines in a component is the order of the explanation.
- Write narration as spoken Japanese, as if explaining to someone in front of you, not as manual text.
- Use `[name]` in narration to point the camera at the element being described. To keep the viewer on one object across scenes, keep its name in the next scene.
- Run `explain help video` for the timing rules.

## Render and check

CLI: `node "${CLAUDE_SKILL_DIR}/scripts/explain.mjs"` (called `explain` below). It needs Node 24.21 or later and nothing else.
Write out the full `node "…/explain.mjs" …` command in every Bash call, one CLI call per Bash call: no shell variables,
no `;` or `&&` chains. Users allow it with a permission rule for `node`, and anything else does not match the rule.
If the command is denied, tell the user which permission to allow instead of writing the HTML by hand.

1. Run `explain help format` (or `explain help video`) once per session.
2. Render with the script on stdin: `explain render - --png --report json <<'EOF' ... EOF`
   For a video: `explain video - --no-open`. Add `--mp4` only when the user asks for a file.
   `--png` needs Chrome; if the report says it cannot make the image, render again without `--png`.
3. Fix the errors, lint warnings, and layout problems in the report, then render again.
   Stop after 2 retries; if warnings remain, keep the page and tell the user which ones.
4. Reply with one sentence that states the conclusion, and the output path.
   The script and the HTML stay out of the chat.

Use `--static` when the page will be hosted somewhere that forbids JavaScript.

## Arguments

`$ARGUMENTS`

- `config` → run `explain config` and ask what to change. `config <key> <value>` → `explain config set <key> <value>`.
- `cache` → `explain cache`. `cache clear` → confirm with the user, then `explain cache clear`.
