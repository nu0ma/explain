// User settings: ~/.explain-cli/config.json (EXPLAIN_HOME changes the location).
// Only keys the user set explicitly are stored; they are merged with the defaults on read.
// A broken file or an invalid value falls back to the default, so settings never stop a render.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CHOICES } from './parse.ts';
import { VOICES } from './video/tts.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ConfigSpec =
  | { type: 'bool'; default: boolean; label: string }
  | { type: 'enum'; choices: readonly string[]; default: string; label: string };

export type ConfigKey = 'open' | 'theme' | 'mode' | 'style' | 'voice';

export type ConfigValues = { open: boolean; theme: string; mode: string; style: string; voice: string };

export type ConfigValue = ConfigValues[ConfigKey];

export type StoredConfig = Record<string, unknown>;

export type Config = { values: ConfigValues; stored: StoredConfig; warning?: string; path: string };

export const CONFIG_KEYS: Readonly<Record<ConfigKey, ConfigSpec>> = Object.freeze({
  open: { type: 'bool', default: true, label: '生成後にブラウザでページを開く' },
  theme: { type: 'enum', choices: CHOICES.theme, default: 'blueprint', label: '既定のテーマ' },
  mode: { type: 'enum', choices: CHOICES.mode, default: 'auto', label: '既定の配色' },
  style: { type: 'enum', choices: CHOICES.style, default: '80', label: 'STE 検査の厳しさ' },
  voice: { type: 'enum', choices: VOICES, default: 'say', label: '動画のナレーション音声（say：macOSのsayで読み上げる、off：字幕だけ）' },
});

export function isConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_KEYS;
}

const TRUE = new Set(['on', 'true', 'yes', '1', 'オン']);
const FALSE = new Set(['off', 'false', 'no', '0', 'オフ']);

export function explainHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXPLAIN_HOME || join(homedir(), '.explain-cli');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(explainHome(env), 'config.json');
}

const defaults = (): Record<string, ConfigValue> => Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, s]) => [k, s.default]));

function coerce(key: string, raw: unknown): ConfigValue {
  const spec = isConfigKey(key) ? CONFIG_KEYS[key] : undefined;
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

function readStored(env: NodeJS.ProcessEnv): { stored: StoredConfig; warning?: string } {
  const file = configPath(env);
  if (!existsSync(file)) return { stored: {} };
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return { stored: data && typeof data === 'object' && !Array.isArray(data) ? (data as StoredConfig) : {} };
  } catch (e) {
    return { stored: {}, warning: `${file} を読めないため、既定の設定を使います（${e instanceof Error ? e.message : String(e)}）` };
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { stored, warning } = readStored(env);
  const values = defaults();
  for (const [k, v] of Object.entries(stored)) {
    if (!isConfigKey(k)) continue;
    try {
      values[k] = coerce(k, v);
    } catch {
      // Keep the default for an invalid value.
    }
  }
  // defaults() and coerce() fill every key with a value of the type its spec declares.
  return { values: values as ConfigValues, stored, warning, path: configPath(env) };
}

function writeStored(stored: StoredConfig, env: NodeJS.ProcessEnv): void {
  const file = configPath(env);
  if (!Object.keys(stored).length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

export function setConfig(key: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): ConfigValue {
  const value = coerce(key, raw);
  const { stored } = readStored(env);
  writeStored({ ...stored, [key]: value }, env);
  return value;
}

export function resetConfig(key?: string, env: NodeJS.ProcessEnv = process.env): void {
  if (key !== undefined && !isConfigKey(key)) coerce(key, '');
  const { stored } = readStored(env);
  const next = key === undefined ? {} : Object.fromEntries(Object.entries(stored).filter(([k]) => k !== key));
  writeStored(next, env);
}
