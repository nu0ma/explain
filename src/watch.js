// explain render --watch：原稿を保存するたびに作り直し、ローカルの HTTP サーバーから配信する。
// 配信するページにだけ再読み込みのスクリプトを足し、作り直すと Server-Sent Events で開いているページに知らせる。

import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';

const EVENTS = '/__explain/events';
const RELOAD = `<script>new EventSource('${EVENTS}').onmessage = () => location.reload();</script>`;
const DEBOUNCE_MS = 80;

// build() は HTML を返す。作れなかったときは null を返す（エラーの表示は build() の役目）。
// signal が中断されるまで動き続ける。onListen(url) はサーバーが待ち受けを始めたら呼ばれる。
export function serveWatch(file, build, { signal, onListen, onRebuild = () => {} }) {
  return new Promise((resolve, reject) => {
    let html = build() ?? '<!doctype html><meta charset="utf-8"><p>原稿にエラーがあります。ターミナルを確認してください。</p>';
    const clients = new Set();

    const server = createServer((req, res) => {
      if (req.url === EVENTS) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.url !== '/') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html.replace(/<\/body>/i, `${RELOAD}\n</body>`));
    });

    // エディタは保存のときにファイルを置き換えることがあるので、ファイルではなくディレクトリを見る。
    let timer = null;
    const name = basename(file);
    const watcher = watch(dirname(file), (_event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = build();
        if (next === null) return;
        html = next;
        for (const res of clients) res.write('data: reload\n\n');
        onRebuild();
      }, DEBOUNCE_MS);
    });

    const stop = () => {
      clearTimeout(timer);
      watcher.close();
      for (const res of clients) res.end();
      server.close(() => resolve());
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => onListen(`http://127.0.0.1:${server.address().port}/`));
  });
}
