import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_IDS, MODELS, validateModels } from '../src/core/prices.js';
import { TOOLS } from '../src/core/tools.js';

describe('price table', () => {
  it('is valid, dated and sourced', () => {
    expect(validateModels(MODELS)).toEqual([]);
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });

  it('never counts Claude or Gemini offline', () => {
    for (const m of MODELS.filter((x) => x.family === 'claude' || x.family === 'gemini')) {
      expect(m.offline).toBe('none');
      expect(m.apiModel).toBeTruthy();
    }
  });

  it('has defaults that exist', () => {
    for (const id of DEFAULT_MODEL_IDS) expect(MODELS.some((m) => m.id === id)).toBe(true);
  });

  it('refuses offline counts for Claude and Gemini in a user price table', () => {
    const base = { label: 'X', inputPerMTok: 1, cachedInputPerMTok: 0.1, source: 'https://a', checkedAt: '2026-10-10' };
    expect(validateModels([{ ...base, id: 'c', family: 'claude', offline: 'o200k-exact' }])).toEqual([
      'entry 0 (c): claude models must use offline "none" (counted only through the vendor API)',
    ]);
    expect(validateModels([{ ...base, id: 'g', family: 'gemini', offline: 'o200k-proxy' }])).toHaveLength(1);
  });

  it('reports problems in a user price table', () => {
    expect(validateModels({})).toEqual(['price table must be a JSON array']);
    const problems = validateModels([{ id: 'x', label: 'X', family: 'openai', inputPerMTok: -1, cachedInputPerMTok: null, source: 'http://a', checkedAt: '2026', offline: 'o200k-exact' }]);
    expect(problems).toEqual([
      'entry 0 (x): inputPerMTok must be a number >= 0 or null',
      'entry 0 (x): source must be an https URL',
      'entry 0 (x): checkedAt must be YYYY-MM-DD',
    ]);
  });
});

describe('tool table', () => {
  it('cites https sources with a check date for every tool', () => {
    for (const t of TOOLS) {
      expect(t.sources.length).toBeGreaterThan(0);
      for (const s of t.sources) expect(s).toMatch(/^https:\/\//);
      expect(t.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const l of t.limits) expect(l.source).toMatch(/^https:\/\//);
    }
  });
});
