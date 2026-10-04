import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timestamp, fileStamp, clock } from '../src/time.ts';

test('日時の表記：ページ・ファイル名・ログ', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const cases = [
    { name: 'timestamp', fn: timestamp, want: '2026-01-02 03:04' },
    { name: 'fileStamp', fn: fileStamp, want: '20260102-030405' },
    { name: 'clock', fn: clock, want: '03:04:05' },
  ];
  for (const { name, fn, want } of cases) assert.equal(fn(d), want, name);
});
