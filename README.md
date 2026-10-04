# explain

A CLI that turns a Markdown script into a self-contained, single-file explainer HTML page and a 3Blue1Brown-style explainer video. It is a personal tool rebuilt for one engineer who works in Japanese, so both the generated output and the CLI messages are Japanese only.

## What it does

- Turns a PR's before and after, the flow of an incident, or a system's architecture into a one-page diagram.
- Lays out diagrams (flow / sequence / tree, etc.) automatically: you only write the relationships.
- Checks the prose in your script against Japanese STE rules (sentence length, redundant phrasing, hedging, etc.), and against every rule of the [yomiyasu](https://github.com/nanaism/yomiyasu) checker for AI-style Japanese (buzzwords, metaphorical verbs, fillers, 「AではなくB」, emoji, half-width spaces around English words, trailing colons, repeated sentence endings, excessive bold or lists, and `**` that does not render as bold). `explain lint` also prints yomiyasu's 0–100 score.
- With `--static`, emits HTML without any `<script>`, for hosts that forbid JavaScript.

## Demo

Both demos explain the Transactional Outbox pattern.

### Explainer page (`explain render`)

Built from [transactional-outbox.md](docs/demo/transactional-outbox.md). The output is [transactional-outbox.html](docs/demo/transactional-outbox.html).

[![Explainer page for Transactional Outbox](docs/demo/transactional-outbox.png)](docs/demo/transactional-outbox.html)

### Explainer video (`explain video --mp4`)

Built from [transactional-outbox.video.md](docs/demo/transactional-outbox.video.md). The GIF below plays at 2x speed without audio. Click it to open the [MP4 with narration](docs/demo/transactional-outbox.video.mp4).

[![Explainer video for Transactional Outbox](docs/demo/transactional-outbox.video.gif)](docs/demo/transactional-outbox.video.mp4)

## Usage

```sh
pnpm install
pnpm add --global "$PWD"      # installs the explain command (or run node bin/explain.ts)

explain render script.md                            # build an explainer page and open it in the browser
explain render script.md --static                   # build HTML without <script>
explain render script.md --watch                    # serve the page and rebuild/reload on every save
explain lint   script.md                            # run the STE check only
explain video  script.md                            # build a video player page (add --mp4 for an MP4 file)
explain help format                                 # script format
explain list                                        # list components and themes
explain config                                      # show and change settings
explain cache [clear]                               # show (or clear) the narration audio cache
```

- Output goes to `~/.explain-cli/pages/` and `~/.explain-cli/videos/`; settings live in `~/.explain-cli/config.json`. Set `EXPLAIN_HOME` to change the location.
- `pnpm run build` produces `dist/explain.mjs`, a single file that bundles all dependencies. It runs on its own with Node 24.21 or later. The sources are TypeScript and run directly on Node without a build step.
- Video narration is synthesized only with macOS `say`, using a Japanese voice (Kyoko, Eddy, Flo, or Reed, in that order). No external TTS service or API key is used. On other platforms, use `--voice off` for a subtitles-only video.

## Rewriting AI-style Japanese

`explain lint` only points out AI-style phrasing; it does not rewrite your script. To rewrite a script drafted by an AI agent before running `explain render`, use the [yomiyasu](https://github.com/nanaism/yomiyasu) Agent Skill. It is declared in `apm.yml` (pinned to v1.0.5), so [APM](https://github.com/microsoft/apm) deploys it to `.claude/skills/`:

```sh
apm install --frozen
```

Then ask your agent to apply yomiyasu to the script, and run `explain lint` again to confirm the warnings are gone. Findings marked `（参考）` are yomiyasu's `info` level and do not block `style: strict`.

## License

MIT. See [LICENSE](LICENSE).
