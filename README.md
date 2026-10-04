# explain

A Claude Code plugin and CLI that turn a Markdown script into a self-contained, single-file explainer HTML page and a 3Blue1Brown-style explainer video. It is a personal tool rebuilt for one engineer who works in Japanese, so both the generated output and the CLI messages are Japanese only.

## Demo

Both demos explain the Transactional Outbox pattern.

### Explainer page (`explain render`)

Built from [transactional-outbox.md](docs/demo/transactional-outbox.md). The output is [transactional-outbox.html](docs/demo/transactional-outbox.html).

[![Explainer page for Transactional Outbox](docs/demo/transactional-outbox.png)](docs/demo/transactional-outbox.html)

### Explainer video (`explain video --mp4`)

Built from [transactional-outbox.video.md](docs/demo/transactional-outbox.video.md). The GIF below plays at 2x speed without audio. Click it to open the [MP4 with narration](docs/demo/transactional-outbox.video.mp4).

[![Explainer video for Transactional Outbox](docs/demo/transactional-outbox.video.gif)](docs/demo/transactional-outbox.video.mp4)

## What it does

- Turns a PR's before and after, the flow of an incident, or a system's architecture into a one-page diagram.
- Lays out diagrams (flow / sequence / tree, etc.) automatically: you only write the relationships.
- Checks the prose in your script against Japanese STE rules (sentence length, redundant phrasing, hedging, etc.), and against every rule of the [yomiyasu](https://github.com/nanaism/yomiyasu) checker for AI-style Japanese (buzzwords, metaphorical verbs, fillers, 「AではなくB」, emoji, half-width spaces around English words, trailing colons, repeated sentence endings, excessive bold or lists, and `**` that does not render as bold). `explain lint` also prints yomiyasu's 0–100 score.
- With `--static`, emits HTML without any `<script>`, for hosts that forbid JavaScript.

## Install as a Claude Code plugin

```sh
/plugin marketplace add nu0ma/explain
/plugin install explain@explain
```

The plugin ships the `explain` skill and a single-file build of the CLI (`skills/explain/scripts/explain.mjs`), so it needs only Node 24.21 or later. Ask the agent to explain something visually ("図にして", "動画で説明して"), or type `/explain`. The agent writes the script, renders it, and fixes the reported warnings. `/explain:config` and `/explain:cache` show or change the settings and the narration cache.

## Use the CLI directly

```sh
pnpm install
pnpm add --global "$PWD"      # installs the explain command (or run node bin/explain.ts)

explain render script.md                            # build an explainer page and open it in the browser
explain render script.md --static                   # build HTML without <script>
explain render script.md --watch                    # serve the page and rebuild/reload on every save
explain render script.md --png                      # also save a full-page PNG and report layout problems (needs Chrome)
explain render script.md --png --report json        # print the result as JSON, for AI agents
explain lint   script.md                            # run the STE check only
explain video  script.md                            # build a video player page (add --mp4 for an MP4 file)
explain help format                                 # script format
explain list                                        # list components and themes
explain config                                      # show and change settings
explain cache [clear]                               # show (or clear) the narration audio cache
```

- Output goes to `~/.explain/pages/` and `~/.explain/videos/`; settings live in `~/.explain/config.json`. Set `EXPLAIN_HOME` to change the location. If only `~/.explain-cli/` (the directory from before the rename) exists, the CLI keeps using it.
- `pnpm run build` writes `skills/explain/scripts/explain.mjs`, a single file that bundles all dependencies. It runs on its own with Node 24.21 or later. The bundle is committed so that the plugin works without `pnpm install`; rebuild it whenever `src/` changes, because CI fails when it differs from the build output. The sources are TypeScript and run directly on Node without a build step.
- Video narration is synthesized only with macOS `say`, using a Japanese voice (Kyoko, Eddy, Flo, or Reed, in that order). No external TTS service or API key is used. On other platforms, use `--voice off` for a subtitles-only video.

## Stable flow node IDs

Existing flow syntax still uses the label as the node ID (`A -> B`, `(Start)`, `[API]`). To give two nodes the same label, or rename a node between video scenes, declare an explicit ID before its shape brackets:

```flow LR
@api1[API] -> @api2[API]
api1 -> @db[(Database)]
group Backend: api2, db
```

Use `@id[Label]`, `@id(Label)`, `@id{Label}`, or `@id[(Label)]`. The ID starts with an ASCII letter or underscore and contains only ASCII letters, digits, underscores, hyphens, or dots. Put diff/highlight marks before the declaration, for example `+*@api1[API]`. References use the ID without `@`, including group members. A reference may precede its declaration. Within a diagram, the last explicit declaration supplies the label; bare references do not reset it.

In consecutive video scenes, `@api[Old API]` and `@api[New API]` share the same animation identity. Narration can target the ID with `[api]`. Declare the label in each diagram. Video animation and focus use IDs across the whole scene, so use distinct IDs for nodes in separate diagrams within one scene. IDs are case-sensitive; camera focus tries an exact ID before its existing fuzzy label matching. Different IDs remain different nodes even when their labels match. To show the new declaration syntax literally as a label, wrap it in a different pair of shape brackets, for example `(@api[API])`.

## Rewriting AI-style Japanese

`explain lint` only points out AI-style phrasing; it does not rewrite your script. To rewrite a script drafted by an AI agent before running `explain render`, use the [yomiyasu](https://github.com/nanaism/yomiyasu) Agent Skill. It is declared in `apm.yml` (pinned to v1.0.5), so [APM](https://github.com/microsoft/apm) deploys it to `.claude/skills/`:

```sh
apm install --frozen
```

Then ask your agent to apply yomiyasu to the script, and run `explain lint` again to confirm the warnings are gone. Findings marked `（参考）` are yomiyasu's `info` level and do not block `style: strict`.

## Evaluating the prompt

What the reader gets out of a page depends mostly on the script the agent writes, so `skills/explain/SKILL.md`, `commands/*.md`, and the CLI help text (`explain help format`, `explain help video`, `explain help <component>`) are the prompt. After changing any of them, run the eval suite in `evals/` and compare the scores with the previous run:

```sh
claude plugin eval . --judge-model sonnet --allow-tools 'Bash(node:*)' Write   # all cases, with the no-plugin baseline
claude plugin eval . --judge-model sonnet --allow-tools 'Bash(node:*)' Write --tag quality   # a subset: quality, trigger, quiet, args, video
```

- Cases in `quality` grade the script the agent wrote; `trigger` and `quiet` check that the skill loads only when it should; `args` checks `/explain config`.
- The default judge (haiku) fails good video scripts too often, so pass `--judge-model sonnet`.
- The eval sandbox cannot start Chrome or macOS `say`, so `--png` falls back to no image and videos get subtitles only. The graders read the script and the CLI report, not the images.
- If `node` on your `PATH` is not Node 24.21 or later, also allow the absolute path of a suitable `node`, for example `--allow-tools "Bash($(mise which node):*)"`.

Each case runs 3 times with the plugin and 3 times without it by default, and every run uses model credit, so the suite runs locally and not in CI.

## License

MIT. See [LICENSE](LICENSE).
