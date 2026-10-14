import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_IDS } from '../core/tools.js';
import type { ModelInfo, ToolId } from '../core/types.js';

export const CONFIG_FILE = 'turntax.config.json';

/** turntax.config.json: defaults for the command-line options. Flags override every key. */
export interface Config {
  tools?: ToolId[];
  models?: string[];
  turns?: number;
  maxTokens?: number;
  maxIncrease?: number;
  sectionTokens?: number;
  /** Repository-relative globs of instruction files to leave out. */
  ignore?: string[];
}

const KEYS: Record<keyof Config, 'strings' | 'positive' | 'non-negative'> = {
  tools: 'strings',
  models: 'strings',
  turns: 'positive',
  maxTokens: 'positive',
  maxIncrease: 'non-negative',
  sectionTokens: 'positive',
  ignore: 'strings',
};

/**
 * Reads `file`, or turntax.config.json in `root` when no file is given. Returns {} when there is no
 * config and throws, naming the file and key, when it is invalid.
 */
export function loadConfig(root: string, file: string | undefined, models: ModelInfo[]): Config {
  const path = file ?? join(root, CONFIG_FILE);
  if (file === undefined && !existsSync(path)) return {};
  const name = file ?? CONFIG_FILE;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read config ${name}: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${name}: expected a JSON object.`);
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(KEYS, key)) throw new Error(`${name}: unknown key "${key}". Use: ${Object.keys(KEYS).join(', ')}.`);
    const kind = KEYS[key as keyof Config];
    if (kind === 'strings' && !(Array.isArray(value) && value.every((v) => typeof v === 'string' && v)))
      throw new Error(`${name}: "${key}" must be an array of non-empty strings.`);
    if (kind !== 'strings' && !(Number.isInteger(value) && (value as number) >= (kind === 'positive' ? 1 : 0)))
      throw new Error(`${name}: "${key}" must be a ${kind} integer.`);
  }
  const config = data as Config;
  for (const t of config.tools ?? [])
    if (!TOOL_IDS.includes(t)) throw new Error(`${name}: "tools" has unknown tool "${t}". Use: ${TOOL_IDS.join(', ')}`);
  for (const m of config.models ?? [])
    if (!models.some((x) => x.id === m)) throw new Error(`${name}: "models" has unknown model "${m}". Run --list-models.`);
  return config;
}
