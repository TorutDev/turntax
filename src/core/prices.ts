import type { ModelInfo } from './types.js';

/**
 * Dated price table. USD per 1M tokens, standard tier, shortest-context tier.
 * Each entry cites the official pricing page and the date it was read.
 * Override at runtime with `--prices <file.json>` (same shape, array of ModelInfo).
 *
 * offline:
 *   o200k-exact - OpenAI's tiktoken maps this model to o200k_base (exact offline count)
 *   o200k-proxy - no published encoding for this model; o200k_base is used as a labelled proxy
 *   none        - no public tokenizer; count only through the vendor API
 */
const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const GOOGLE = 'https://ai.google.dev/gemini-api/docs/pricing';
const CHECKED = '2026-10-10';

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5.5',
    label: 'Claude Opus 5.5',
    family: 'claude',
    inputPerMTok: 4,
    cachedInputPerMTok: 0.2,
    source: ANTHROPIC,
    checkedAt: CHECKED,
    offline: 'none',
    apiModel: 'claude-opus-5-5',
  },
  {
    id: 'claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5',
    family: 'claude',
    inputPerMTok: 2,
    cachedInputPerMTok: 0.1,
    source: ANTHROPIC,
    checkedAt: CHECKED,
    offline: 'none',
    apiModel: 'claude-sonnet-5-5',
  },
  {
    id: 'claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    family: 'claude',
    inputPerMTok: 0.1,
    cachedInputPerMTok: 0.01,
    priceNote: 'Prompts up to 100K tokens; $0.50 / $0.05 above.',
    source: ANTHROPIC,
    checkedAt: CHECKED,
    offline: 'none',
    apiModel: 'claude-haiku-5-5',
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    family: 'openai',
    inputPerMTok: 2,
    cachedInputPerMTok: 0.1,
    priceNote: 'Prompts up to 272K tokens; $4 / $0.20 above.',
    source: OPENAI,
    checkedAt: CHECKED,
    offline: 'o200k-proxy',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    family: 'openai',
    inputPerMTok: 10,
    cachedInputPerMTok: 1,
    priceNote: 'Prompts up to 272K tokens; $20 / $2 above.',
    source: OPENAI,
    checkedAt: CHECKED,
    offline: 'o200k-proxy',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    family: 'openai',
    inputPerMTok: 0.1,
    cachedInputPerMTok: 0.01,
    priceNote: 'Prompts up to 272K tokens; $0.20 / $0.02 above.',
    source: OPENAI,
    checkedAt: CHECKED,
    offline: 'o200k-proxy',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    family: 'openai',
    inputPerMTok: 1.75,
    cachedInputPerMTok: 0.175,
    source: OPENAI,
    checkedAt: CHECKED,
    offline: 'o200k-exact',
  },
  {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro (preview)',
    family: 'gemini',
    inputPerMTok: 2,
    cachedInputPerMTok: 0.2,
    priceNote: 'Prompts up to 200K tokens; $4 / $0.40 above. Cache storage billed per hour.',
    source: GOOGLE,
    checkedAt: CHECKED,
    offline: 'none',
    apiModel: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    family: 'gemini',
    inputPerMTok: 0.75,
    cachedInputPerMTok: 0.075,
    priceNote: 'Price through 2026-12-31; $1.50 / $0.15 from 2027-01-01. Cache storage billed per hour.',
    source: GOOGLE,
    checkedAt: CHECKED,
    offline: 'none',
    apiModel: 'gemini-3.8-flash',
  },
  {
    id: 'gpt-oss',
    label: 'gpt-oss (open weights)',
    family: 'open',
    inputPerMTok: null,
    cachedInputPerMTok: null,
    priceNote: 'Self-hosted; no per-token list price.',
    source: 'https://github.com/openai/tiktoken/blob/main/tiktoken/model.py',
    checkedAt: CHECKED,
    offline: 'o200k-exact',
  },
];

/** Models shown when the user does not pass --models. */
export const DEFAULT_MODEL_IDS = ['claude-sonnet-5.5', 'gpt-6.1-sol', 'gemini-3.8-flash'];

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

/** Validates a user-supplied price table. Returns a list of problems (empty when valid). */
export function validateModels(input: unknown): string[] {
  if (!Array.isArray(input)) return ['price table must be a JSON array'];
  const problems: string[] = [];
  input.forEach((m: Partial<ModelInfo>, i) => {
    const at = `entry ${i}${m?.id ? ` (${m.id})` : ''}`;
    if (!m || typeof m.id !== 'string' || !m.id) problems.push(`${at}: missing id`);
    if (typeof m?.label !== 'string') problems.push(`${at}: missing label`);
    if (!['claude', 'openai', 'gemini', 'open'].includes(String(m?.family))) problems.push(`${at}: bad family`);
    for (const key of ['inputPerMTok', 'cachedInputPerMTok'] as const) {
      const v = m?.[key];
      if (!(v === null || (typeof v === 'number' && v >= 0))) problems.push(`${at}: ${key} must be a number >= 0 or null`);
    }
    if (typeof m?.source !== 'string' || !m.source.startsWith('https://')) problems.push(`${at}: source must be an https URL`);
    if (typeof m?.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.checkedAt))
      problems.push(`${at}: checkedAt must be YYYY-MM-DD`);
    if (!['o200k-exact', 'o200k-proxy', 'none'].includes(String(m?.offline))) problems.push(`${at}: bad offline`);
  });
  return problems;
}
