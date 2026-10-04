# explain

**Instant explainer pages and narrated videos for Claude Code.**

Say "図にして" and get a diagram. Say "動画で説明して" and get a narrated video.

- **Instant**: a page in 0.08 s. An 84-second 1080p video in 17 s.
- **Zero dependencies**: one 177 KB file. Just Node. No API keys.
- **Agent-native**: the agent writes a Markdown script. The CLI lays it out, checks the prose, and tells the agent what to fix.
- **Japanese first**: built for one engineer who works in Japanese. Output and messages are Japanese only.

## Install as a Claude Code plugin

```sh
/plugin marketplace add nu0ma/explain
/plugin install explain@explain
```

The plugin ships the `explain` skill and a single-file build of the CLI (`skills/explain/scripts/explain.mjs`), so it needs only Node 24.21 or later. Besides asking in words, you can type `/explain`. `/explain:config` and `/explain:cache` show or change the settings and the narration cache.

## Demo

Every demo below was rendered by the plugin's bundled CLI. Each image links to the generated file, and each script is the Markdown the agent wrote.

### Explainer pages (`explain render`)

#### Transactional Outbox

A before/after flow with an added group, a sequence, and a comparison table. Script: [transactional-outbox.md](docs/demo/transactional-outbox.md). Output: [transactional-outbox.html](docs/demo/transactional-outbox.html).

[![Explainer page for Transactional Outbox](docs/demo/transactional-outbox.png)](docs/demo/transactional-outbox.html)

#### OAuth 2.0 authorization code flow

A 13-step sequence across five actors, split into phases, with tables of roles and safeguards. Script: [oauth2-authorization-code.md](docs/demo/oauth2-authorization-code.md). Output: [oauth2-authorization-code.html](docs/demo/oauth2-authorization-code.html).

[![Explainer page for the OAuth 2.0 authorization code flow](docs/demo/oauth2-authorization-code.png)](docs/demo/oauth2-authorization-code.html)

#### TCP three-way handshake

A sequence with connection states as notes, and a table of why two messages are not enough. Script: [tcp-handshake.md](docs/demo/tcp-handshake.md). Output: [tcp-handshake.html](docs/demo/tcp-handshake.html).

[![Explainer page for the TCP three-way handshake](docs/demo/tcp-handshake.png)](docs/demo/tcp-handshake.html)

#### How MP4 export got three times faster

A flow of the export pipeline, measured times as `limits` bars, and a table of what helped. Script: [mp4-export-speedup.md](docs/demo/mp4-export-speedup.md). Output: [mp4-export-speedup.html](docs/demo/mp4-export-speedup.html).

[![Explainer page for the MP4 export speed-up](docs/demo/mp4-export-speedup.png)](docs/demo/mp4-export-speedup.html)

### Explainer videos (`explain video --mp4`)

The GIFs play at 2x speed without audio. Click one to open the MP4 with narration.

#### Transactional Outbox

Script: [transactional-outbox.video.md](docs/demo/transactional-outbox.video.md).

[![Explainer video for Transactional Outbox](docs/demo/transactional-outbox.video.gif)](docs/demo/transactional-outbox.video.mp4)

#### DNS name resolution

The flow grows one step per narration line, the camera follows each server named in the narration, and the table reveals one row at a time. Script: [dns-resolution.video.md](docs/demo/dns-resolution.video.md).

[![Explainer video for DNS name resolution](docs/demo/dns-resolution.video.gif)](docs/demo/dns-resolution.video.mp4)

## What it does

- Turns a PR's before and after, the flow of an incident, or a system's architecture into a one-page diagram.
- Lays out diagrams (flow / sequence / tree, etc.) automatically: you only write the relationships.
- Checks the prose in your script against Japanese STE rules (sentence length, redundant phrasing, hedging, etc.), and against every rule of the [yomiyasu](https://github.com/nanaism/yomiyasu) checker for AI-style Japanese (buzzwords, metaphorical verbs, fillers, 「AではなくB」, emoji, half-width spaces around English words, trailing colons, repeated sentence endings, excessive bold or lists, and `**` that does not render as bold). `explain lint` also prints yomiyasu's 0–100 score.
- With `--static`, emits HTML without any `<script>`, for hosts that forbid JavaScript.

## Speed

Measured on an Apple M3 Max with Node 24.21, Chrome 154, ffmpeg 8.0, and macOS `say`. Each number is the median of 3 runs on the demo scripts.

| Command | Time |
|---|---|
| `explain render` (page, Transactional Outbox) | 0.08 s |
| `explain render --png` (page, screenshot, and layout check) | 0.86 s |
| `explain video` (84 s DNS video, narration cached) | 0.74 s |
| `explain video` (84 s DNS video, narration synthesized) | 6.6 s |
| `explain video --mp4` (84 s, 1920×1080, 30 fps, narration cached) | 17 s |

Why it is fast:

- Parsing, layout, and the prose check run in one Node process with no runtime dependencies. The Markdown renderer and the flow layout are written in this repository, and the CLI ships as one file of about 177 KB.
- MP4 export screenshots only the frames that change. The player reports when each scene, step, camera move, and caption changes, and every other frame reuses the previous image. The frames are spread over several headless Chrome processes, because one Chrome takes about 40 ms per screenshot however many tabs it has.
- Narration is cached per sentence and voice, so re-rendering a video only synthesizes the lines that changed.
- The skill has the agent fix a video script with `explain lint` (under 0.1 s) before it renders the video once.

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
- `--png` and `--mp4` use the installed Chrome, Chromium, Edge, or Brave. Set `EXPLAIN_CHROME` to use another binary. Pointing it to `chrome-headless-shell` (for example, from `npx @puppeteer/browsers install chrome-headless-shell@stable` or the Playwright cache) cuts the browser launch from about 0.5 s to about 0.1 s, which makes `--png` noticeably faster. The CLI does not pick the headless shell on its own: its version can differ from the installed Chrome, and layout checks and images can then differ by a few pixels.

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

Each case runs 3 times with the plugin and 3 times without it by default, and every run uses model credit, so the suite runs locally and not in CI.

## License

MIT. See [LICENSE](LICENSE).
