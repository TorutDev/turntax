import { describe, expect, it } from 'vitest';
import { audit } from '../src/core/audit.js';
import { MODELS } from '../src/core/prices.js';
import { badgeUrl, renderMarkdown, renderText } from '../src/core/render.js';
import { countO200k } from '../src/core/tokenize.js';
import type { Counter } from '../src/core/types.js';
import { loadFixture } from './helpers.js';

const MIXED = await loadFixture('mixed');

const pick = (...ids: string[]) => ids.map((id) => MODELS.find((m) => m.id === id)!);

describe('audit', () => {
  it('sums always-loaded tokens per tool and projects cost', async () => {
    const files = [
      { path: 'AGENTS.md', text: 'Use the Makefile for every build and test command.' },
      { path: 'sub/AGENTS.md', text: 'Generated code; do not edit.' },
    ];
    const report = await audit(files, { tools: ['codex'], models: pick('gpt-6.1-sol'), turns: 1000 });
    const codex = report.tools[0]!;
    const tokens = countO200k(files[0]!.text);
    expect(codex.perTurnO200k).toBe(tokens);
    expect(codex.onDemandO200k).toBe(countO200k(files[1]!.text));
    const m = codex.models[0]!;
    expect(m.perTurn).toBe(tokens);
    expect(m.method).toBe('offline-proxy');
    expect(m.uncached).toBeCloseTo((tokens * 1000 * 2) / 1e6);
    expect(m.cached).toBeCloseTo((tokens * 1000 * 0.1) / 1e6);
  });

  it('only prices models a tool runs, and marks Claude as needing a key', async () => {
    const report = await audit(MIXED, { models: pick('claude-sonnet-5.5', 'gpt-6.1-sol', 'gemini-3.8-flash') });
    const claude = report.tools.find((t) => t.tool === 'claude-code')!;
    expect(claude.models.map((m) => m.model)).toEqual(['claude-sonnet-5.5']);
    expect(claude.models[0]).toMatchObject({ perTurn: null, method: 'unavailable', uncached: null });
    const cursor = report.tools.find((t) => t.tool === 'cursor')!;
    expect(cursor.models.map((m) => m.model)).toEqual(['claude-sonnet-5.5', 'gpt-6.1-sol', 'gemini-3.8-flash']);
    expect(cursor.models[1]!.perTurn).toBe(cursor.perTurnO200k);
  });

  it('uses the API counter for Claude when provided, counting each distinct text once', async () => {
    let calls = 0;
    const fake: Counter = {
      async count(_m, texts) {
        calls += texts.length;
        return texts.map((t) => ({ tokens: t.length, method: 'api' as const }));
      },
    };
    const files = MIXED;
    const report = await audit(files, { tools: ['claude-code', 'cursor'], models: pick('claude-sonnet-5.5'), counters: { claude: fake } });
    const claude = report.tools.find((t) => t.tool === 'claude-code')!.models[0]!;
    expect(claude.method).toBe('api');
    expect(claude.perTurn).toBeGreaterThan(0);
    // Cursor and Claude Code share several files; shared texts are counted once.
    const counted = report.files.filter((f) => f.mode !== 'ignored').length;
    expect(calls).toBeLessThan(counted);
  });

  it('renders text, markdown and a badge', async () => {
    const report = await audit(MIXED, { models: pick('claude-sonnet-5.5', 'gpt-6.1-sol') });
    const text = renderText(report, '/repo');
    expect(text).toContain('Claude Code ');
    expect(text).toContain('needs --claude-api and ANTHROPIC_API_KEY');
    expect(text).toContain('checked 2026-10-10');
    const md = renderMarkdown(report);
    expect(md).toContain('| Tool | Model | Tokens / turn |');
    expect(md).toContain('img.shields.io/badge/context%20tax-');
    expect(badgeUrl(report)).toMatch(/^https:\/\/img\.shields\.io\/badge\/context%20tax-\d+%20tokens%2Fturn-brightgreen$/);
  });
});
