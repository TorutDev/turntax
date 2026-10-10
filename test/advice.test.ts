import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdvice, guessLanguage, pathRefs } from '../src/core/advice.js';
import { classify } from '../src/core/classify.js';
import { existsIn, packageScripts } from '../src/node/discover.js';
import { fixture, loadFixture } from './helpers.js';

const mixed = await loadFixture('mixed');
const TURKISH = await loadFixture('turkish');
const units = classify(mixed);
const advice = buildAdvice(units, mixed, {
  exists: existsIn(fixture('mixed')),
  packageScripts: packageScripts(fixture('mixed')),
});
const of = (kind: string) => advice.filter((a) => a.kind === kind);

describe('duplicates', () => {
  it('reports lines shared by CLAUDE.md and AGENTS.md with a per-turn saving for tools that load both', () => {
    const dup = of('duplicate').find((a) => a.paths.includes('CLAUDE.md') && a.paths.includes('AGENTS.md'))!;
    expect(dup).toBeDefined();
    expect(dup.tools).toEqual(['cursor']);
    expect(dup.severity).toBe('high');
    expect(dup.savingTokens).toBeGreaterThan(20);
  });

  it('reports no per-turn saving when no tool loads both copies', () => {
    const files = [
      { path: 'CLAUDE.md', text: 'Line one is long enough to be compared here.\nLine two is long enough to be compared here.\nLine three is long enough to be compared too.' },
      { path: 'GEMINI.md', text: 'Line one is long enough to be compared here.\nLine two is long enough to be compared here.\nLine three is long enough to be compared too.' },
    ];
    const a = buildAdvice(classify(files, ['claude-code', 'gemini-cli']), files).find((x) => x.kind === 'duplicate')!;
    expect(a.savingTokens).toBe(0);
    expect(a.severity).toBe('low');
  });
});

describe('contradictions', () => {
  it('finds conflicting package managers loaded by the same tool', () => {
    const c = of('contradiction').filter((a) => a.message.includes('package manager'));
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.tools).toContain('cursor');
  });

  it('finds conflicting indentation rules', () => {
    const files = [
      { path: '.cursor/rules/a.mdc', text: '---\nalwaysApply: true\n---\nUse tabs for indentation.' },
      { path: 'AGENTS.md', text: 'Use 2 spaces for indentation.' },
    ];
    const c = buildAdvice(classify(files, ['cursor']), files).filter((a) => a.kind === 'contradiction');
    expect(c).toHaveLength(1);
    expect(c[0]!.message).toMatch(/indentation/);
  });

  it('reads negated rules as agreeing with their positive form', () => {
    const files = [
      { path: '.cursor/rules/a.mdc', text: "---\nalwaysApply: true\n---\nDo not use semicolons.\nDon't use double quotes.\nDon't use tabs." },
      { path: 'AGENTS.md', text: 'No semicolons.\nPrefer single quotes.\nUse 2 spaces for indentation.' },
    ];
    expect(buildAdvice(classify(files, ['cursor']), files).filter((a) => a.kind === 'contradiction')).toHaveLength(0);
  });

  it('flags a negated rule that clashes with a positive one', () => {
    const files = [
      { path: '.cursor/rules/a.mdc', text: '---\nalwaysApply: true\n---\nNever use yarn here.' },
      { path: 'AGENTS.md', text: 'Use yarn for everything.' },
    ];
    expect(buildAdvice(classify(files, ['cursor']), files).filter((a) => a.kind === 'contradiction')).toHaveLength(1);
  });

  it('still compares rules whose "for" phrase is not a language, and handles curly apostrophes', () => {
    const files = [
      { path: '.cursor/rules/a.mdc', text: '---\nalwaysApply: true\n---\nIndent with tabs.\nDon’t use semicolons.' },
      { path: 'AGENTS.md', text: 'Use 2 spaces for indentation.\nNo semicolons.' },
    ];
    const c = buildAdvice(classify(files, ['cursor']), files).filter((a) => a.kind === 'contradiction');
    expect(c).toHaveLength(1);
    expect(c[0]!.message).toMatch(/indentation/);
  });

  it('keeps per-language style rules apart', () => {
    const files = [{ path: 'AGENTS.md', text: 'Use 4 spaces for Python files.\nUse 2 spaces for TypeScript files.' }];
    expect(buildAdvice(classify(files, ['codex']), files).filter((a) => a.kind === 'contradiction')).toHaveLength(0);
  });

  it('does not treat "use pnpm, never use npm" as a conflict', () => {
    const files = [{ path: 'AGENTS.md', text: 'Use pnpm, never use npm.' }];
    expect(buildAdvice(classify(files, ['codex']), files).filter((a) => a.kind === 'contradiction')).toHaveLength(0);
  });
});

describe('sections', () => {
  it('suggests scoping a section that is about one directory', () => {
    const s = of('scopable-section').find((a) => a.paths[0] === 'CLAUDE.md')!;
    expect(s.message).toMatch(/packages\/api\/AGENTS\.md/);
    expect(s.savingTokens).toBeGreaterThan(100);
  });

  it('flags oversized sections', () => {
    const text = `# Release\n${'Do the release step carefully and check every output twice. '.repeat(80)}`;
    const files = [{ path: 'CLAUDE.md', text }];
    const a = buildAdvice(classify(files, ['claude-code']), files).find((x) => x.kind === 'oversized-section')!;
    expect(a.savingTokens).toBeGreaterThan(500);
  });
});

describe('size limits', () => {
  it('flags CLAUDE.md over 200 lines and Codex AGENTS.md over 32 KiB', () => {
    const files = [
      { path: 'CLAUDE.md', text: Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') },
      { path: 'AGENTS.md', text: 'word '.repeat(8000) },
    ];
    const limits = buildAdvice(classify(files), files).filter((a) => a.kind === 'size-limit');
    const claude = limits.find((a) => a.tools.includes('claude-code'))!;
    expect(claude.severity).toBe('medium');
    expect(claude.savingTokens).toBeGreaterThan(0);
    const codex = limits.find((a) => a.tools.includes('codex'))!;
    expect(codex.severity).toBe('high');
    expect(codex.savingNote).toMatch(/never reach/);
    const ws = [{ path: '.windsurfrules', text: 'x'.repeat(13000) }];
    const windsurf = buildAdvice(classify(ws, ['windsurf']), ws).find((a) => a.kind === 'size-limit')!;
    expect(windsurf.savingNote).toMatch(/over the tool's limit/);
    expect(windsurf.savingNote).not.toMatch(/never reach/);
  });
});

describe('misconfiguration and stale references', () => {
  it('reports ignored Cursor .md rules and Windsurf rules without a trigger', () => {
    const paths = of('misconfigured').map((a) => a.paths[0]);
    expect(paths).toContain('.cursor/rules/wrong.md');
    expect(paths).toContain('.windsurf/rules/b.md');
  });

  it('reports missing paths and npm scripts', () => {
    const claude = of('stale-reference').find((a) => a.paths[0] === 'CLAUDE.md')!;
    expect(claude.message).toContain('src/legacy/helpers.ts');
    expect(claude.message).not.toContain('packages/api/');
    const files = [{ path: 'AGENTS.md', text: 'Put contributor guides under `packages/missing/`.' }];
    const dirOnly = buildAdvice(classify(files, ['codex']), files, { exists: existsIn(fixture('mixed')) });
    expect(dirOnly.filter((a) => a.kind === 'stale-reference')).toHaveLength(0);
    const gemini = of('stale-reference').find((a) => a.paths[0] === 'GEMINI.md')!;
    expect(gemini.message).toContain('script "lint"');
  });

  it('resolves paths relative to nested files and skips root scripts for nested packages', () => {
    const files = [
      { path: 'packages/api/CLAUDE.md', text: 'Handlers live in `packages/api/db.ts` and `handlers/users.ts`. Run `pnpm run deploy` here.' },
      { path: 'CLAUDE.md', text: 'Run `pnpm run -r build` across the workspace.' },
    ];
    const stale = buildAdvice(classify(files, ['claude-code']), files, {
      exists: existsIn(fixture('mixed')),
      packageScripts: packageScripts(fixture('mixed')),
    }).filter((a) => a.kind === 'stale-reference');
    expect(stale).toHaveLength(0);
  });

  it('extracts path references', () => {
    expect(pathRefs('See `src/a.ts`, docs/guide.md and https://x.com/a/b.md but not and/or or `*.ts`')).toEqual([
      'src/a.ts',
      'docs/guide.md',
    ]);
  });
});

describe('non-English text', () => {
  const tr = TURKISH;
  const trUnits = classify(tr, ['claude-code']);

  it('detects non-English sections without claiming a multiplier', () => {
    const a = buildAdvice(trUnits, tr).find((x) => x.kind === 'non-english')!;
    expect(a.savingTokens).toBeNull();
    expect(a.message).toMatch(/--english/);
  });

  it('measures the multiplier against a supplied English version', () => {
    const english = new Map([['CLAUDE.md', readFileSync(join(fixture('turkish'), 'CLAUDE.en.md'), 'utf8')]]);
    const a = buildAdvice(trUnits, tr, { english }).find((x) => x.kind === 'non-english')!;
    expect(a.message).toMatch(/x\d\.\d\d/);
    expect(a.savingTokens).toBeGreaterThan(0);
  });

  it('guesses scripts and leaves English alone', () => {
    expect(guessLanguage('Always run the tests before you commit and keep the change small and focused on one thing.').nonEnglish).toBe(false);
    expect(guessLanguage('Всегда запускайте тесты перед коммитом и держите изменения маленькими и сфокусированными.').script).toBe('Cyrillic');
  });
});
