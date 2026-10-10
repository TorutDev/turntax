import type { Counter, ModelInfo, TokenCount } from '../core/types.js';

/**
 * Network counters. They only run when the user passes --claude-api / --gemini-api
 * and the matching key is set. Keys are sent only in request headers and never logged.
 */

type Fetch = typeof fetch;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROBE = [{ role: 'user', content: '.' }];

async function postJson(fetchFn: Fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Only the status goes into the message: response bodies can echo request content.
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Exact Claude counts from Anthropic's count_tokens endpoint.
 * Each text is sent as a system prompt next to a one-character user message; the same request
 * without the system prompt is subtracted, so the result is the cost the text adds to a turn.
 */
export function anthropicCounter(apiKey: string, fetchFn: Fetch = fetch): Counter {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const baselines = new Map<string, Promise<number>>();
  return {
    async count(model: ModelInfo, texts: string[]): Promise<TokenCount[]> {
      if (!model.apiModel) return texts.map(() => ({ tokens: null, method: 'unavailable', reason: 'no API model id' }));
      const apiModel = model.apiModel;
      const baseline = () => {
        if (!baselines.has(apiModel))
          baselines.set(
            apiModel,
            postJson(fetchFn, ANTHROPIC_URL, headers, { model: apiModel, messages: PROBE }).then((r) => r.input_tokens),
          );
        return baselines.get(apiModel)!;
      };
      return mapLimited(texts, 4, async (text): Promise<TokenCount> => {
        if (!text.trim()) return { tokens: 0, method: 'api' };
        try {
          const [base, full] = await Promise.all([
            baseline(),
            postJson(fetchFn, ANTHROPIC_URL, headers, { model: apiModel, system: text, messages: PROBE }),
          ]);
          return { tokens: Math.max(0, full.input_tokens - base), method: 'api' };
        } catch (e) {
          return { tokens: null, method: 'unavailable', reason: `Anthropic count_tokens failed: ${(e as Error).message}` };
        }
      });
    },
  };
}

/** Gemini counts from Google's models.countTokens endpoint. */
export function geminiCounter(apiKey: string, fetchFn: Fetch = fetch): Counter {
  const headers = { 'x-goog-api-key': apiKey };
  return {
    async count(model: ModelInfo, texts: string[]): Promise<TokenCount[]> {
      if (!model.apiModel) return texts.map(() => ({ tokens: null, method: 'unavailable', reason: 'no API model id' }));
      const url = `${GEMINI_BASE}/${encodeURIComponent(model.apiModel)}:countTokens`;
      return mapLimited(texts, 4, async (text): Promise<TokenCount> => {
        if (!text.trim()) return { tokens: 0, method: 'api' };
        try {
          const r = await postJson(fetchFn, url, headers, { contents: [{ role: 'user', parts: [{ text }] }] });
          return { tokens: r.totalTokens, method: 'api' };
        } catch (e) {
          return { tokens: null, method: 'unavailable', reason: `Gemini countTokens failed: ${(e as Error).message}` };
        }
      });
    },
  };
}

/** Opt-in English translation through Claude, used only to measure a language token multiplier. */
export async function translateToEnglish(apiKey: string, text: string, fetchFn: Fetch = fetch): Promise<string> {
  const r = await postJson(
    fetchFn,
    ANTHROPIC_MESSAGES_URL,
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: 'claude-haiku-5-5',
      max_tokens: 8000,
      system:
        'Translate the user text into natural English. Keep markdown structure, code, paths and commands unchanged. Output only the translation.',
      messages: [{ role: 'user', content: text }],
    },
  );
  if (r.stop_reason === 'max_tokens') throw new Error('translation was cut off (file too long)');
  return (r.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
}
