# explain

A CLI that turns a Markdown script into a self-contained, single-file explainer HTML page and a 3Blue1Brown-style explainer video. It is a personal tool rebuilt for one engineer who works in Japanese, so both the generated output and the CLI messages are Japanese only.

## What it does

- Turns a PR's before and after, the flow of an incident, or a system's architecture into a one-page diagram.
- Lays out diagrams (flow / sequence / tree, etc.) automatically: you only write the relationships.
- Checks the prose in your script against Japanese STE rules (sentence length, redundant phrasing, hedging, etc.).
- With `--static`, emits HTML without any `<script>`, for hosts that forbid JavaScript (such as Pageshelf safe mode).

## Usage

```sh
pnpm install
pnpm add --global "$PWD"      # installs the explain command (or run node bin/explain.js)

explain render examples/pr-before-after.md          # build an explainer page and open it in the browser
explain render examples/pr-before-after.md --static # build HTML without <script>
explain lint   examples/pr-before-after.md          # run the STE check only
explain video  script.md --voice system             # build a video player page (add --mp4 for an MP4 file)
explain help format                                 # script format
explain list                                        # list components and themes
explain config                                      # show and change settings
```

- Output goes to `~/.explain-cli/pages/` and `~/.explain-cli/videos/`; settings live in `~/.explain-cli/config.json`. Set `EXPLAIN_HOME` to change the location.
- `pnpm run build` produces `dist/explain.mjs`, a single file that bundles all dependencies. It runs on its own with Node 24 or later.
- Video narration uses ElevenLabs (`ELEVENLABS_API_KEY`) first, then macOS `say` (a Japanese voice such as Kyoko), then `espeak-ng` on Linux.

## License

MIT. See [LICENSE](LICENSE).
