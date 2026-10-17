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
    // VS Code Copilot reads CLAUDE.md together with AGENTS.md.
    expect(dup.tools).toEqual(['cursor', 'copilot']);
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

describe('line numbers', () => {
  const API = [
    '## API package',
    '',
    'The API lives in `packages/api/` and its handlers are in `packages/api/handlers/`.',
    'Every handler in `packages/api/handlers/` must validate input with the shared schema module.',
    'Database access goes through `packages/api/db.ts` only; do not import the driver elsewhere.',
    'Write integration tests for handlers next to them in `packages/api/handlers/`.',
    'Use structured logging in the API package and never log request bodies or headers.',
    'Return problem+json errors from the API with a stable error code for each failure.',
    'Old helpers were in `packages/api/legacy.ts` and must not be used.',
  ];
  const exists = (p: string) => ['packages', 'packages/api', 'packages/api/handlers', 'packages/api/db.ts'].includes(p);
  const lineOf = (text: string, needle: string) => text.split(/\r?\n/).findIndex((l) => l.startsWith(needle)) + 1;

  it('points at the line in the file on disk for the mixed fixture', () => {
    const raw = mixed.find((f) => f.path === 'CLAUDE.md')!.text;
    expect(of('scopable-section').find((a) => a.paths[0] === 'CLAUDE.md')!.line).toBe(lineOf(raw, '## API package'));
    const stale = of('stale-reference').find((a) => a.paths[0] === 'CLAUDE.md')!;
    expect(stale.line).toBe(lineOf(raw, 'Old helpers'));
    expect(stale.message).toContain(`(line ${lineOf(raw, 'Old helpers')})`);
    const conflict = of('contradiction').find((a) => a.message.includes('package manager'))!;
    expect(conflict.message).toContain(`(CLAUDE.md:${lineOf(raw, 'Always use pnpm')})`);
  });

  it('counts the HTML comments that Claude Code strips from CLAUDE.md', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = ['# Guide', '', '<!--', 'A note for maintainers', 'over several lines.', '-->', '', 'Use pnpm.', '', ...API].join(eol);
      const files = [{ path: 'CLAUDE.md', text }];
      const advice = buildAdvice(classify(files, ['claude-code']), files, { exists });
      expect(advice.find((a) => a.kind === 'scopable-section')!.line).toBe(10);
      const stale = advice.find((a) => a.kind === 'stale-reference')!;
      expect(stale.line).toBe(18);
      expect(stale.message).toContain('packages/api/legacy.ts (line 18)');
    }
  });

  it('counts the frontmatter of rule files', () => {
    const rules = [
      { path: '.claude/rules/api.md', tool: 'claude-code' as const, fm: ['---', 'description: API notes', '---'] },
      { path: '.cursor/rules/api.mdc', tool: 'cursor' as const, fm: ['---', 'description: API notes', 'alwaysApply: true', '---'] },
    ];
    for (const r of rules) {
      const files = [{ path: r.path, text: [...r.fm, '', ...API].join('\r\n') }];
      const advice = buildAdvice(classify(files, [r.tool]), files, { exists });
      expect(advice.find((a) => a.kind === 'scopable-section')!.line).toBe(r.fm.length + 2);
      expect(advice.find((a) => a.kind === 'stale-reference')!.line).toBe(r.fm.length + 10);
    }
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

describe('false positives found in the State of report', () => {
  it('leaves terse English without stopwords alone', () => {
    const terse = '- Build: pnpm build\n- Lint: pnpm lint --fix\n- Types: pnpm typecheck\n- Docs: pnpm docs:dev\n- Release: changesets, conventional commits, squash merges only\n- Style: prettier, eslint, strict TypeScript, named exports';
    expect(guessLanguage(terse).nonEnglish).toBe(false);
  });

  it('still finds German, French, Spanish and Italian', () => {
    for (const text of [
      'Führe vor jedem Commit alle Tests aus und halte Änderungen klein, damit Reviews für alle einfach bleiben.',
      'Exécutez tous les tests avant chaque commit et gardez les modifications petites et ciblées pour faciliter la relecture.',
      'Ejecuta todas las pruebas antes de cada commit y mantén los cambios pequeños y enfocados para facilitar la revisión.',
      'Esegui tutti i test prima di ogni commit e mantieni le modifiche piccole e mirate così la revisione è più semplice.',
    ])
      expect(guessLanguage(text).nonEnglish, text).toBe(true);
    expect(guessLanguage('Ask José before you change the release process, and keep the changelog short and focused on users.').nonEnglish).toBe(false);
  });

  it('does not suggest moving a section into a folder that does not exist', () => {
    const files = [{ path: 'CLAUDE.md', text: mixed.find((f) => f.path === 'CLAUDE.md')!.text }];
    const units = classify(files, ['claude-code']);
    expect(buildAdvice(units, files, { exists: () => false }).some((a) => a.kind === 'scopable-section')).toBe(false);
    expect(buildAdvice(units, files, { exists: (p) => p.startsWith('packages') }).some((a) => a.kind === 'scopable-section')).toBe(true);
  });

  it('does not check paths that leave the repository', () => {
    const files = [{ path: 'CLAUDE.md', text: 'Shared config lives in `../shared/config.json` next to this repository.\n' }];
    const a = buildAdvice(classify(files, ['claude-code']), files, { exists: (p) => p === '..' });
    expect(a.some((x) => x.kind === 'stale-reference')).toBe(false);
  });
});
