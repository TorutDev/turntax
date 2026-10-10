import { describe, expect, it, vi } from 'vitest';
import { MODELS } from '../src/core/prices.js';
import { countO200k, offlineCounter } from '../src/core/tokenize.js';
import { anthropicCounter, geminiCounter, translateToEnglish } from '../src/node/remote.js';

const model = (id: string) => MODELS.find((m) => m.id === id)!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('offline counter', () => {
  it('counts o200k and labels proxy vs exact', async () => {
    expect(countO200k('')).toBe(0);
    expect(countO200k('<|endoftext|>')).toBeGreaterThan(1);
    const [proxy] = await offlineCounter.count(model('gpt-6.1-sol'), ['hello world']);
    expect(proxy).toEqual({ tokens: 2, method: 'offline-proxy' });
    const [exact] = await offlineCounter.count(model('gpt-5.3-codex'), ['hello world']);
    expect(exact!.method).toBe('offline-exact');
  });

  it('never invents Claude or Gemini numbers', async () => {
    const [c] = await offlineCounter.count(model('claude-sonnet-5.5'), ['hello']);
    expect(c).toMatchObject({ tokens: null, method: 'unavailable' });
    expect(c!.reason).toMatch(/ANTHROPIC_API_KEY/);
    const [g] = await offlineCounter.count(model('gemini-3.8-flash'), ['hello']);
    expect(g!.reason).toMatch(/GEMINI_API_KEY/);
  });
});

describe('anthropic counter', () => {
  it('subtracts the baseline request and sends the key only as a header', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return jsonResponse({ input_tokens: body.system ? 8 + body.system.length : 8 });
    });
    const counter = anthropicCounter('sk-test', fetchFn as unknown as typeof fetch);
    const [r, empty] = await counter.count(model('claude-sonnet-5.5'), ['abcde', '  ']);
    expect(r).toEqual({ tokens: 5, method: 'api' });
    expect(empty).toEqual({ tokens: 0, method: 'api' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(url).not.toContain('sk-test');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(JSON.parse(String(init.body)).model).toBe('claude-sonnet-5-5');
  });

  it('sends nothing when there is nothing to count', async () => {
    const fetchFn = vi.fn();
    const r = await anthropicCounter('k', fetchFn as unknown as typeof fetch).count(model('claude-opus-5.5'), ['', '  ']);
    expect(r).toEqual([{ tokens: 0, method: 'api' }, { tokens: 0, method: 'api' }]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports failures without echoing response bodies', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'secret text echoed' }, 401));
    const [r] = await anthropicCounter('k', fetchFn as unknown as typeof fetch).count(model('claude-opus-5.5'), ['x']);
    expect(r).toMatchObject({ tokens: null, method: 'unavailable' });
    expect(r!.reason).toBe('Anthropic count_tokens failed: HTTP 401');
  });
});

describe('translateToEnglish', () => {
  it('asks Claude for a translation and returns only text blocks', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'Hello' }, { type: 'other' }] }));
    expect(await translateToEnglish('k', 'Merhaba', fetchFn as unknown as typeof fetch)).toBe('Hello');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(String(init.body)).messages[0].content).toBe('Merhaba');
  });
});

describe('translateToEnglish truncation', () => {
  it('refuses a translation that hit max_tokens', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Half' }] }));
    await expect(translateToEnglish('k', 'Uzun metin', fetchFn as unknown as typeof fetch)).rejects.toThrow(/cut off/);
  });
});

describe('gemini counter', () => {
  it('calls countTokens with the key in a header', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ totalTokens: 7 }));
    const [r] = await geminiCounter('g-key', fetchFn as unknown as typeof fetch).count(model('gemini-3.8-flash'), ['hi']);
    expect(r).toEqual({ tokens: 7, method: 'api' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:countTokens');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
  });
});
