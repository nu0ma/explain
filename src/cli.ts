// explain CLI: render / video / lint / config / list / help.
// main() accepts I/O streams and environment variables, so tests can substitute them.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { VERSION } from './assets.ts';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { renderDoc, RenderError, LintError } from './render.ts';
import { parseDoc, ParseError, CHOICES } from './parse.ts';
import { lintDoc, formatWarning, blockingWarnings } from './lint/ste.ts';
import { aiScore } from './lint/yomiyasu.ts';
import { COMPONENTS } from './components/index.ts';
import { THEMES } from './themes/index.ts';
import { renderVideo } from './video/render.ts';
import { serveWatch } from './watch.ts';
import { fileStamp, clock } from './time.ts';
import { pickProvider, compressAudio, cacheStats, CACHE_MAX_BYTES, TtsError, VOICES } from './video/tts.ts';
import { exportMp4, ExportError } from './video/export.ts';
import { explainHome, readConfig, setConfig, resetConfig, isConfigKey, CONFIG_KEYS, ConfigError, type ConfigValues } from './config.ts';

const MAX_LISTED_WARNINGS = 20;

type Print = (s?: string) => void;
type Fail = (s: string) => void;
type TtsProvider = ReturnType<typeof pickProvider>;
type EncodeAudio = typeof compressAudio;
type Warning = Parameters<typeof formatWarning>[0];

export type MainIO = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: AsyncIterable<string | Buffer>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  // Stops `render --watch`; without it, SIGINT stops the server.
  signal?: AbortSignal;
  // Replaces the TTS provider chosen from --voice (null means captions only).
  ttsProvider?: TtsProvider;
  encodeAudio?: EncodeAudio | null;
};

export type CliOptions = {
  out?: string;
  'no-open'?: boolean;
  open?: boolean;
  static?: boolean;
  watch?: boolean;
  theme?: string;
  template?: string;
  style?: string;
  mode?: string;
  voice?: string;
  mp4?: boolean;
  help?: boolean;
  version?: boolean;
};

type Context = { print: Print; fail: Fail; env: NodeJS.ProcessEnv; cwd?: string };

const USAGE = `explain ${VERSION} — Markdown の原稿から 1 ファイルの解説 HTML と解説動画を作る

使い方:
  explain render <file|->  [-o 出力先] [--no-open] [--static] [--watch] [--theme blueprint|shadcn]
                           [--template sheet|doc] [--style off|80|strict] [--mode auto|light|dark]
                                                     解説ページ（HTML）を作る。--watch は保存するたびに作り直してブラウザを再読み込みする
  explain video  <file|->  [-o 出力先] [--voice say|off] [--mp4] [--no-open]
                           [--theme blueprint|shadcn|3b1b] [--mode auto|light|dark]
                                                     3b1b 風の解説動画の再生ページを作る（--mp4 で動画ファイルも保存）
  explain lint   <file|->  [--style off|80|strict]   STE 検査だけする
  explain config [set <キー> <値> | get <キー> | reset [キー]]
                                                     設定を表示・変更する
  explain cache [clear]                              音声のキャッシュの場所と大きさを表示する。clear で消す
  explain list                                       テンプレート・テーマ・部品の一覧
  explain help [部品名|format|video]                 部品の書き方・原稿の書式

- ファイルの代わりに - を渡すと標準入力から読む（heredoc 向け：explain render - <<'EOF' ... EOF）。
- 出力先の既定は ~/.explain-cli/pages/ と ~/.explain-cli/videos/（環境変数 EXPLAIN_HOME で変更できる）。
- --watch はローカルのサーバーからページを配信し、原稿を保存するたびに作り直す（Ctrl+C で終了）。-o を渡すとファイルにも書く。
- --static は <script> を含まない HTML を出す（切り替えボタンと原稿コピーなし。配色は OS の設定に従う）。
- ブラウザを自動で開くか、既定のテーマなどは explain config で設定する。--open / --no-open はその回だけ有効。`;

const FORMAT = `原稿の書式（拡張 Markdown）

---
template: sheet        # sheet 図面ボード（既定。パネルをグリッドに並べる）| doc 1 段組の解説（目次つき）
theme: blueprint       # blueprint 図面風（既定）| shadcn カード風。ページ上で切り替えられる
title: ページの題名     # 本文の先頭行 "# 題名" でもよい
subtitle: 副題          # 省略可
cols: 3                # sheet のグリッドの列数。既定は 3
style: 80              # STE 検査の厳しさ：off | 80（既定。警告だけ）| strict（警告があれば生成しない）
mode: auto             # auto（OS の設定に従う）| light | dark
static: true           # <script> なしの HTML を出す（--static と同じ）
source: example.com    # そのほかのキーはページ上部のメタ情報行に出る（値に " #" を書くとコメント扱い）
---
導入文（省略可。題名の下に出る）

## A パネルの題名 {span=2 meta="右上の補足"}
ふつうの Markdown：段落、リスト、表、引用、インラインコード……
表のセルに ok / no / warn と書くと（"ok 承認済み" のように後ろに文字を続けてもよい）✓ / ✗ / ! のバッジになる。

\`\`\`flow LR          ← コードブロックの言語名が部品名。後ろは部品の引数
A -> B
\`\`\`

\`\`\`html             ← html / svg のコードブロックはそのまま埋め込む（逃げ道）
<div>任意の内容</div>
\`\`\`

- "## " でパネルを始める。英字の ID は省略できる（A、B、C… を自動で振る）。span でパネルを複数列に広げる。
- 部品の一覧は explain list、各部品の書き方は explain help <部品名>。`;

const VIDEO_FORMAT = `動画の原稿の書式（explain video）

---
title: TCP の 3 ウェイハンドシェイク
subtitle: なぜ 3 回なのか          # 省略可。タイトル画面の副題
theme: blueprint                 # blueprint 図面風（既定。explain config の theme に従う）| shadcn カード | 3b1b ダーク
mode: auto                       # auto（OS の設定に従う。MP4 はライト）| light | dark（blueprint + dark は濃紺の図面）
---
> タイトル画面のナレーション（省略可。書かなければタイトル画面を 2.4 秒表示する）

## 両端が待っている
\`\`\`sequence
Client -> Server: SYN
Server -> Client: SYN-ACK
Client -> Server: ACK
\`\`\`
> クライアントが SYN を送り、接続を求める。
> [Server] は SYN-ACK を返す。
> クライアントが ACK を返し、接続が確立する。

- "## " で場面を始める。場面には部品や Markdown（画面）を置き、> で始まる行がナレーション（1 行が 1 拍）。
- N 番目のナレーションが流れるときに、画面の N 番目の手順が現れる。flow / sequence / tree はソースの 1 行が 1 手順。
  timeline、limits、表の行、リスト項目、段落は項目ごとに自動で分ける。手順がナレーションより多いときは各文に均等に割り振る。
  ナレーションが手順より多いときは、余った先頭の文を前置きとして使い、新しい内容は出さない。
- ナレーションに [名前] と書くと、カメラが同じ名前の要素に寄って強調し、字幕のその語が黄色になる。
- となりあう場面に同じ名前のノードや参加者があると、前の位置から次の位置へなめらかに動く（場面をまたぐ変形）。
- 音声：--voice say（既定。macOSのsayで読み上げる。日本語の声はKyoko、Eddy、Flo、Reedの順に探す）| off（字幕だけ）。
- 出力先は ~/.explain-cli/videos/。--mp4 で同じ名前の .mp4 も保存する（Chrome と ffmpeg が必要）。
- ffmpeg があれば、再生ページに埋め込む音声を AAC に圧縮する（なければ WAV のまま）。
- 動画は再生に JavaScript が要るため、--static は使えない。`;

export async function main(argv: string[], io: MainIO = {}): Promise<number> {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const print: Print = (s = '') => out.write(`${s}\n`);
  const fail: Fail = (s) => err.write(`${s}\n`);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        'no-open': { type: 'boolean' },
        open: { type: 'boolean' },
        static: { type: 'boolean' },
        watch: { type: 'boolean' },
        theme: { type: 'string' },
        template: { type: 'string' },
        style: { type: 'string' },
        mode: { type: 'string' },
        voice: { type: 'string' },
        mp4: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    fail(`✗ 引数を解釈できません：${errorMessage(e)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals: [cmd, arg, ...rest] } = parsed;
  const opts: CliOptions = values;

  if (opts.version) return print(VERSION), 0;
  if (opts.help || !cmd) return print(USAGE), 0;

  switch (cmd) {
    case 'render':
      if (opts.watch) return cmdWatch(arg, opts, { print, fail, env, cwd: io.cwd, signal: io.signal });
      return withSource(arg, io, fail, (src) => cmdRender(src, opts, { print, fail, env, cwd: io.cwd }));
    case 'video':
      if (opts.static) {
        fail('✗ explain video では --static を使えません。動画の再生には JavaScript が必要です');
        return 2;
      }
      return withSource(arg, io, fail, (src) => cmdVideo(src, opts, { print, fail, env, cwd: io.cwd, provider: io.ttsProvider, encodeAudio: io.encodeAudio }));
    case 'lint': return withSource(arg, io, fail, (src) => cmdLint(src, opts, { print, fail }));
    case 'config': return cmdConfig([arg, ...rest].filter((x) => x !== undefined), { print, fail, env });
    case 'cache': return cmdCache(arg, { print, fail, env });
    case 'list': return cmdList(print), 0;
    case 'help': return cmdHelp(arg, { print, fail });
    default:
      fail(`✗ "${cmd}" というコマンドはありません\n\n${USAGE}`);
      return 2;
  }
}

async function withSource(arg: string | undefined, io: MainIO, fail: Fail, fn: (src: string) => number | Promise<number>): Promise<number> {
  if (!arg) {
    fail('✗ 原稿を指定してください。ファイルのパスを渡すか、- で標準入力から読みます');
    return 2;
  }
  let src: string;
  try {
    src = arg === '-' ? await readStream(io.stdin ?? process.stdin) : readFileSync(resolve(io.cwd ?? process.cwd(), arg), 'utf8');
  } catch (e) {
    fail(`✗ 原稿を読めません：${errorMessage(e)}`);
    return 2;
  }
  if (!src.trim()) {
    fail('✗ 原稿が空です');
    return 2;
  }
  return fn(src);
}

async function readStream(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Whether to open automatically: --open (always opens) > --no-open > EXPLAIN_NO_OPEN (other than 0) > CI > the open setting.
export function shouldOpen(opts: Pick<CliOptions, 'open' | 'no-open'>, env: NodeJS.ProcessEnv, config: Partial<Pick<ConfigValues, 'open'>>): boolean {
  if (opts.open) return true;
  if (opts['no-open']) return false;
  if (env.EXPLAIN_NO_OPEN && env.EXPLAIN_NO_OPEN !== '0') return false;
  if (env.CI) return false;
  return config.open !== false;
}

function cmdRender(src: string, opts: CliOptions, { print, fail, env, cwd }: Context): number {
  const config = readConfig(env);
  if (config.warning) fail(`! ${config.warning}`);
  const { theme, mode, style } = config.values;
  let result;
  try {
    result = renderDoc(src, { theme: opts.theme, template: opts.template, style: opts.style, mode: opts.mode, static: opts.static }, { theme, mode, style });
  } catch (e) {
    return reportError(e, fail);
  }
  const file = writeOutput(result.html, { dir: 'pages', title: result.meta.title, out: opts.out, env, cwd });

  const comps = Object.entries(result.stats.components).map(([k, v]) => `${k}×${v}`).join(' ');
  print(`✓ ${file}`);
  print(`  ${result.meta.template} · ${result.meta.theme} · パネル ${result.stats.panels} 枚${comps ? ` · ${comps}` : ''}${result.static ? ' · 静的（script なし）' : ''}`);
  printWarnings(result.warnings, print, result.meta.style);
  if (shouldOpen(opts, env, config.values)) openFile(file);
  return 0;
}

// --watch accepts only a manuscript file. Errors do not stop it; fixing and saving rebuilds the page.
async function cmdWatch(arg: string | undefined, opts: CliOptions, { print, fail, env, cwd, signal }: Context & { signal?: AbortSignal }): Promise<number> {
  if (!arg || arg === '-') {
    fail('✗ --watch には原稿のファイルを指定してください。標準入力は見張れません');
    return 2;
  }
  const file = resolve(cwd ?? process.cwd(), arg);
  const config = readConfig(env);
  if (config.warning) fail(`! ${config.warning}`);
  const { theme, mode, style } = config.values;
  const out = opts.out ? resolve(cwd ?? process.cwd(), opts.out) : null;
  const build = (): string | null => {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch (e) {
      fail(`✗ 原稿を読めません：${errorMessage(e)}`);
      return null;
    }
    try {
      const result = renderDoc(src, { theme: opts.theme, template: opts.template, style: opts.style, mode: opts.mode, static: opts.static }, { theme, mode, style });
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, result.html);
      }
      print(`✓ ${clock()} 作り直しました · パネル ${result.stats.panels} 枚`);
      printWarnings(result.warnings, print, result.meta.style);
      return result.html;
    } catch (e) {
      try {
        reportError(e, fail);
      } catch {
        fail(`✗ 内部エラー：${(e instanceof Error && e.stack) || e}`);
      }
      return null;
    }
  };

  let stopSignal = signal;
  if (!stopSignal) {
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    stopSignal = ac.signal;
  }
  try {
    await serveWatch(file, build, {
      signal: stopSignal,
      onListen: (url) => {
        print(`✓ ${url}（原稿を保存すると作り直します。Ctrl+C で終了）`);
        if (shouldOpen(opts, env, config.values)) openFile(url);
      },
    });
  } catch (e) {
    fail(`✗ サーバーを起動できません：${errorMessage(e)}`);
    return 1;
  }
  return 0;
}

async function cmdVideo(
  src: string,
  opts: CliOptions,
  { print, fail, env, cwd, provider: injected, encodeAudio = compressAudio }: Context & { provider?: TtsProvider; encodeAudio?: EncodeAudio | null },
): Promise<number> {
  const config = readConfig(env);
  if (config.warning) fail(`! ${config.warning}`);
  const voice = opts.voice ?? config.values.voice;
  if (!(VOICES as readonly string[]).includes(voice)) {
    fail(`✗ voice の値 "${voice}" は使えません。選択肢：${VOICES.join(' | ')}`);
    return 2;
  }
  let result: Awaited<ReturnType<typeof renderVideo>>;
  let voiceName: string;
  try {
    const provider = injected !== undefined ? injected : pickProvider(voice);
    result = await renderVideo(src, {
      provider,
      cacheDir: ttsCacheDir(env),
      defaults: { style: config.values.style, theme: config.values.theme, mode: config.values.mode },
      overrides: { style: opts.style, theme: opts.theme, mode: opts.mode },
      onProgress: (msg: string) => fail(`  ${msg}`),
      encodeAudio,
    });
    voiceName = provider ? provider.name : 'なし（字幕のみ）';
  } catch (e) {
    if (e instanceof TtsError) {
      fail(`✗ 音声を合成できません：${e.message}。--voice off にすると字幕だけで作れます`);
      return 1;
    }
    return reportError(e, fail);
  }
  const file = writeOutput(result.html, { dir: 'videos', title: result.meta.title, out: opts.out, env, cwd });
  print(`✓ ${file}`);
  print(`  video · 場面 ${result.stats.panels} 個 · ナレーション ${result.beats} 文 · ${result.duration.toFixed(1)} 秒 · 音声：${voiceName}`);
  printWarnings(result.warnings, print, result.meta.style);

  if (opts.mp4) {
    const mp4 = file.replace(/\.html?$/i, '') + '.mp4';
    try {
      const started = Date.now();
      await exportMp4(file, mp4, { wav: result.wav, env, onProgress: (i: number, n: number) => fail(`  MP4 を書き出し中：${i}/${n} フレーム`) });
      print(`✓ ${mp4}（書き出し ${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
    } catch (e) {
      if (!(e instanceof ExportError)) throw e;
      fail(`✗ MP4 を書き出せません：${e.message}。再生ページはできているので、ブラウザでそのまま再生できます`);
      return 1;
    }
  }
  if (shouldOpen(opts, env, config.values)) openFile(file);
  return 0;
}

function cmdLint(src: string, opts: CliOptions, { print, fail }: Pick<Context, 'print' | 'fail'>): number {
  let doc: ReturnType<typeof parseDoc>;
  try {
    doc = parseDoc(src);
  } catch (e) {
    return reportError(e, fail);
  }
  const style = opts.style ?? doc.meta.style;
  if (!(CHOICES.style as readonly string[]).includes(style)) {
    fail(`✗ style の値 "${style}" は使えません。選択肢：${CHOICES.style.join(' | ')}`);
    return 2;
  }
  const warnings = style === 'off' ? [] : lintDoc(doc);
  printWarnings(warnings, print, style);
  if (style !== 'off') print(`  AI っぽさのスコア ${aiScore(warnings)}/100（yomiyasu の基準。AI の文章に多い書き方 1 件につき 5 点、参考の件は 2 点を引く）`);
  return style === 'strict' && blockingWarnings(warnings).length ? 1 : 0;
}

function printWarnings(warnings: readonly Warning[], print: Print, style: string): void {
  if (style === 'off') return print('  STE 検査はオフです');
  if (!warnings.length) return print('  STE ✓ 警告 0 件');
  print(`  STE 警告 ${warnings.length} 件（原稿を直してから再実行してください）：`);
  warnings.slice(0, MAX_LISTED_WARNINGS).forEach((w) => print(`  ${formatWarning(w)}`));
  if (warnings.length > MAX_LISTED_WARNINGS) print(`  … ほかに ${warnings.length - MAX_LISTED_WARNINGS} 件。すべて見るには explain lint を使ってください`);
}

function reportError(e: unknown, fail: Fail): number {
  if (e instanceof RenderError) {
    fail(`✗ L${e.line} [${e.component}] ${e.message}`);
    if (e.example) fail(`  正しい例：\n${e.example.replace(/^/gm, '    ')}`);
    fail(`  書き方の詳細：explain help ${e.component}`);
    return 1;
  }
  if (e instanceof ParseError) {
    fail(`✗ ${e.line ? `L${e.line} ` : ''}原稿を解析できません：${e.message}`);
    return 1;
  }
  if (e instanceof LintError) {
    fail(`✗ ${e.message}。ページは生成していません：`);
    e.warnings.forEach((w) => fail(`  ${formatWarning(w)}`));
    return 1;
  }
  throw e;
}

const showValue = (v: string | boolean): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

function cmdConfig(args: string[], { print, fail, env }: Omit<Context, 'cwd'>): number {
  const [action, key, value] = args;
  try {
    if (action === 'set') {
      if (key === undefined || value === undefined) throw new ConfigError('使い方：explain config set <キー> <値>');
      print(`✓ ${key} = ${showValue(setConfig(key, value, env))}`);
      return 0;
    }
    if (action === 'get') {
      if (key === undefined || !isConfigKey(key)) throw new ConfigError(`設定項目 "${key}" はありません。使える項目：${Object.keys(CONFIG_KEYS).join(' | ')}`);
      print(showValue(readConfig(env).values[key]));
      return 0;
    }
    if (action === 'reset') {
      resetConfig(key, env);
      print(key ? `✓ ${key} を既定値に戻しました` : '✓ すべての設定を既定値に戻しました');
      return 0;
    }
    if (action !== undefined) throw new ConfigError(`"${action}" という操作はありません。使い方：explain config [set <キー> <値> | get <キー> | reset [キー]]`);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    fail(`✗ ${e.message}`);
    return 2;
  }
  const { values, stored, warning, path } = readConfig(env);
  const shown: Record<string, string | boolean> = values;
  if (warning) fail(`! ${warning}`);
  print(`設定ファイル：${path}`);
  for (const [k, spec] of Object.entries(CONFIG_KEYS)) {
    const mark = k in stored ? '*' : ' ';
    const options = spec.type === 'bool' ? 'on | off' : spec.choices.join(' | ');
    print(`${mark} ${k.padEnd(7)}${showValue(shown[k]).padEnd(10)}${spec.label}（${options}）`);
  }
  if (env.EXPLAIN_NO_OPEN && env.EXPLAIN_NO_OPEN !== '0') print('注意：環境変数 EXPLAIN_NO_OPEN が有効なため、open の設定より優先されます。');
  print('* はあなたが変更した値です。変更：explain config set <キー> <値>　既定値に戻す：explain config reset [キー]');
  return 0;
}

const ttsCacheDir = (env: NodeJS.ProcessEnv): string => join(explainHome(env), 'cache', 'tts');
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function cmdCache(action: string | undefined, { print, fail, env }: Omit<Context, 'cwd'>): number {
  const dir = ttsCacheDir(env);
  const { files, bytes } = cacheStats(dir);
  if (action === 'clear') {
    rmSync(dir, { recursive: true, force: true });
    print(`✓ 音声のキャッシュを消しました（${files.length} 件、${mb(bytes)}）`);
    return 0;
  }
  if (action !== undefined) {
    fail(`✗ "${action}" という操作はありません。使い方：explain cache [clear]`);
    return 2;
  }
  print(`音声のキャッシュ：${dir}`);
  print(`  ${files.length} 件、${mb(bytes)}（上限 ${mb(CACHE_MAX_BYTES)}。超えたら最後に使った時刻が古いものから消す）`);
  print('消す：explain cache clear');
  return 0;
}

function cmdList(print: Print): void {
  print('テンプレート (template):');
  print('  sheet   図面ボード：英字の番号つきパネルをグリッドに並べる。1 画面で全体を見せる（既定）');
  print('  doc     1 段組の解説：上から順に読む。パネルが 3 枚以上なら目次がつく');
  print('  video   解説動画：explain video で作る。書き方は explain help video');
  print('\nテーマ (theme):');
  for (const [name, t] of Object.entries(THEMES)) print(`  ${name.padEnd(10)}${t.label}`);
  print('\n部品（コードブロックの言語名）:');
  for (const c of COMPONENTS.values()) print(`  ${c.name.padEnd(10)}${c.summary}`);
  print('  html/svg  そのまま埋め込む（逃げ道）');
  print('\n部品の書き方：explain help <部品名>　原稿の書式：explain help format');
}

function cmdHelp(name: string | undefined, { print, fail }: Pick<Context, 'print' | 'fail'>): number {
  if (!name) return print(USAGE), 0;
  if (name === 'format') return print(FORMAT), 0;
  if (name === 'video') return print(VIDEO_FORMAT), 0;
  const comp = COMPONENTS.get(name);
  if (!comp) {
    fail(`✗ "${name}" という部品はありません。使えるもの：${[...COMPONENTS.keys()].join(', ')}, format, video`);
    return 2;
  }
  print(`${comp.name} — ${comp.summary}\n\n${comp.syntax}\n\n例：\n${comp.example}`);
  return 0;
}

function slug(title: string | undefined): string {
  const s = String(title || 'page').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'page';
}

// Write to -o if given, otherwise to EXPLAIN_HOME/<dir>/<title>-<timestamp>.html, and return the written path.
function writeOutput(
  html: string,
  { dir, title, out, env, cwd }: { dir: string; title?: string; out?: string; env: NodeJS.ProcessEnv; cwd?: string },
): string {
  const file = out
    ? resolve(cwd ?? process.cwd(), out)
    : join(explainHome(env), dir, `${slug(title)}-${fileStamp()}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return file;
}

function openFile(file: string): void {
  const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
      : ['xdg-open', [file]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // Failing to open a browser does not affect the output; the path is already printed.
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
