// ユーザー設定：~/.explain-cli/config.json（EXPLAIN_HOME で場所を変えられる）。
// 保存するのはユーザーが明示的に設定したキーだけ。読み込み時に既定値と合わせる。
// ファイルが壊れていたり値が不正だったりしても既定値に戻し、設定の問題で描画を止めない。

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CHOICES } from './parse.js';
import { VOICES } from './video/tts.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @type {Readonly<Record<string, { type: 'bool' | 'enum', choices?: readonly string[], default: string | boolean, label: string }>>} */
export const CONFIG_KEYS = Object.freeze({
  open: { type: 'bool', default: true, label: '生成後にブラウザでページを開く' },
  theme: { type: 'enum', choices: CHOICES.theme, default: 'blueprint', label: '既定のテーマ' },
  mode: { type: 'enum', choices: CHOICES.mode, default: 'auto', label: '既定の配色' },
  style: { type: 'enum', choices: CHOICES.style, default: '80', label: 'STE 検査の厳しさ' },
  voice: { type: 'enum', choices: VOICES, default: 'say', label: '動画のナレーション音声（say：macOSのsayで読み上げる、off：字幕だけ）' },
});

const TRUE = new Set(['on', 'true', 'yes', '1', 'オン']);
const FALSE = new Set(['off', 'false', 'no', '0', 'オフ']);

export function explainHome(env = process.env) {
  return env.EXPLAIN_HOME || join(homedir(), '.explain-cli');
}

export function configPath(env = process.env) {
  return join(explainHome(env), 'config.json');
}

const defaults = () => Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, s]) => [k, s.default]));

function coerce(key, raw) {
  const spec = CONFIG_KEYS[key];
  if (!spec) throw new ConfigError(`設定項目 "${key}" はありません。使える項目：${Object.keys(CONFIG_KEYS).join(' | ')}`);
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const v = String(raw).trim().toLowerCase();
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
    throw new ConfigError(`${key} には on か off を指定してください`);
  }
  const v = String(raw).trim();
  if (!spec.choices.includes(v)) throw new ConfigError(`${key} の値 "${v}" は使えません。選択肢：${spec.choices.join(' | ')}`);
  return v;
}

function readStored(env) {
  const file = configPath(env);
  if (!existsSync(file)) return { stored: {} };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return { stored: data && typeof data === 'object' && !Array.isArray(data) ? data : {} };
  } catch (e) {
    return { stored: {}, warning: `${file} を読めないため、既定の設定を使います（${e.message}）` };
  }
}

export function readConfig(env = process.env) {
  const { stored, warning } = readStored(env);
  const values = defaults();
  for (const [k, v] of Object.entries(stored)) {
    if (!CONFIG_KEYS[k]) continue;
    try {
      values[k] = coerce(k, v);
    } catch {
      // 不正な値は既定値のままにする。
    }
  }
  return { values, stored, warning, path: configPath(env) };
}

function writeStored(stored, env) {
  const file = configPath(env);
  if (!Object.keys(stored).length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

export function setConfig(key, raw, env = process.env) {
  const value = coerce(key, raw);
  const { stored } = readStored(env);
  writeStored({ ...stored, [key]: value }, env);
  return value;
}

export function resetConfig(key, env = process.env) {
  if (key !== undefined && !CONFIG_KEYS[key]) coerce(key, '');
  const { stored } = readStored(env);
  const next = key === undefined ? {} : Object.fromEntries(Object.entries(stored).filter(([k]) => k !== key));
  writeStored(next, env);
}
