import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { Counter, ModelInfo, TokenCount } from './types.js';

const PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

/** OpenAI o200k_base token count. Special-token strings are counted as ordinary text. */
export function countO200k(text: string): number {
  return text ? countTokens(text, PLAIN_TEXT) : 0;
}

/** Counts offline where a public tokenizer exists; reports the rest as unavailable. */
export const offlineCounter: Counter = {
  async count(model: ModelInfo, texts: string[]): Promise<TokenCount[]> {
    if (model.offline === 'none') {
      const reason =
        model.family === 'claude'
          ? 'needs --claude-api and ANTHROPIC_API_KEY'
          : model.family === 'gemini'
            ? 'needs --gemini-api and GEMINI_API_KEY'
            : 'no offline tokenizer';
      return texts.map(() => ({ tokens: null, method: 'unavailable', reason }));
    }
    const method = model.offline === 'o200k-exact' ? 'offline-exact' : 'offline-proxy';
    return texts.map((t) => ({ tokens: countO200k(t), method }));
  },
};
