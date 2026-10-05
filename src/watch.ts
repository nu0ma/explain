// explain render --watch: rebuild the manuscript on every save and serve it from a local HTTP server.
// Only the served page gets a reload script; after a rebuild, Server-Sent Events notify the open pages.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { contentSecurityPolicy } from './network.ts';

const EVENTS = '/__explain/events';
const RELOAD = `<script>new EventSource('${EVENTS}').onmessage = () => location.reload();</script>`;
const DEBOUNCE_MS = 80;

export type WatchOptions = {
  // Keeps serving until this signal aborts.
  signal: AbortSignal;
  // Called once the server starts listening.
  onListen: (url: string) => void;
};

// build() returns the HTML, or null when it cannot build (build() reports the error itself).
export function serveWatch(file: string, build: () => string | null, { signal, onListen }: WatchOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let html = build() ?? '<!doctype html><meta charset="utf-8"><p>原稿にエラーがあります。ターミナルを確認してください。</p>';
    const clients = new Set<ServerResponse>();

    const server = createServer((req, res) => {
      // Answer only requests addressed by a local name, so DNS rebinding cannot let other sites read the page.
      // The server listens on TCP, so address() is an AddressInfo.
      const { port } = server.address() as AddressInfo;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) {
        res.writeHead(403).end();
        return;
      }
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
      // Only the served copy may connect to this exact reload endpoint. The saved HTML stays offline.
      const served = html.replace(contentSecurityPolicy(), contentSecurityPolicy().replace("connect-src 'none'", `connect-src http://${req.headers.host}${EVENTS}`));
      res.end(served.replace(/<\/body>/i, `${RELOAD}\n</body>`));
    });

    // Editors may replace the file on save, so watch the directory rather than the file.
    let timer: NodeJS.Timeout | undefined;
    const name = basename(file);
    const watcher = watch(dirname(file), (_event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = build();
        if (next === null) return;
        html = next;
        for (const res of clients) res.write('data: reload\n\n');
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
    server.listen(0, '127.0.0.1', () => onListen(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
  });
}
