#!/usr/bin/env node
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`✗ 内部エラー：${(err instanceof Error && err.stack) || err}\n`);
    process.exitCode = 1;
  },
);
