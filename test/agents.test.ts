import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdvice } from '../src/core/advice.js';
import { classify } from '../src/core/classify.js';
import { getTool } from '../src/core/tools.js';
import { addImports, isInstructionFile } from '../src/core/files.js';
import { discover } from '../src/node/discover.js';
import { find } from './helpers.js';

describe('Cline', () => {
  it('loads rules without paths always and path-scoped rules on demand', () => {
    const u = classify(
      [
        { path: '.clinerules/general.md', text: 'Keep it short.' },
        { path: '.clinerules/api.md', text: '---\npaths:\n  - "src/api/**"\n---\nValidate input.' },
        { path: '.cline/rules/off.md', text: '---\npaths: []\n---\nNever applies.' },
      ],
      ['cline'],
    );
    expect(find(u, 'cline', '.clinerules/general.md')!.mode).toBe('always');
    expect(find(u, 'cline', '.clinerules/api.md')!.mode).toBe('on-demand');
    expect(find(u, 'cline', '.cline/rules/off.md')!.mode).toBe('ignored');
  });

  it('treats .clinerules/skills as skills, not always-on rules', () => {
    const u = classify(
      [
        { path: '.clinerules/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy to AWS.\n---\nLong steps.' },
        { path: '.clinerules/skills/deploy/docs/ref.md', text: 'Reference loaded only when needed.' },
        { path: '.cline/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy, preferred copy.\n---\nSteps.' },
        { path: '.claude/skills/review/SKILL.md', text: '---\nname: review\ndescription: Review code.\n---\nSteps.' },
      ],
      ['cline'],
    );
    expect(find(u, 'cline', '.clinerules/skills/deploy/SKILL.md')).toBeUndefined();
    expect(find(u, 'cline', '.clinerules/skills/deploy/docs/ref.md')).toBeUndefined();
    expect(find(u, 'cline', '.cline/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'cline', '.clinerules/skills/deploy/SKILL.md', 'description')!.mode).toBe('ignored');
    expect(find(u, 'cline', '.claude/skills/review/SKILL.md', 'description')!.mode).toBe('always');
  });
});

describe('Roo Code', () => {
  it('prefers .roo/rules over legacy files and scopes mode folders', () => {
    const u = classify(
      [
        { path: '.roo/rules/a.md', text: 'General.' },
        { path: '.roo/rules-code/b.md', text: 'Code mode only.' },
        { path: '.roorules', text: 'Legacy.' },
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'AGENT.md', text: 'Fallback.' },
      ],
      ['roo-code'],
    );
    expect(find(u, 'roo-code', '.roo/rules/a.md')!.mode).toBe('always');
    expect(find(u, 'roo-code', '.roo/rules-code/b.md')!.mode).toBe('on-demand');
    expect(find(u, 'roo-code', '.roorules')!.mode).toBe('ignored');
    expect(find(u, 'roo-code', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'roo-code', 'AGENT.md')!.mode).toBe('ignored');
  });

  it('reads AGENTS.md only from the workspace root', () => {
    const u = classify([{ path: 'AGENTS.md', text: 'Root.' }, { path: 'pkg/AGENTS.md', text: 'Nested.' }], ['roo-code']);
    expect(find(u, 'roo-code', 'pkg/AGENTS.md')).toMatchObject({ mode: 'ignored', trigger: 'Roo Code reads AGENTS.md only from the workspace root.' });
  });

  it('falls back to .roorules when there is no rules folder', () => {
    const u = classify([{ path: '.roorules', text: 'Legacy.' }], ['roo-code']);
    expect(find(u, 'roo-code', '.roorules')!.mode).toBe('always');
  });

  it('lists skills from .roo/skills and .agents/skills, and mode skills only in that mode', () => {
    const u = classify(
      [
        { path: '.roo/skills/pdf/SKILL.md', text: '---\nname: pdf\ndescription: PDF work.\n---\nSteps.' },
        { path: '.agents/skills/sql/SKILL.md', text: '---\nname: sql\ndescription: SQL work.\n---\nSteps.' },
        { path: '.roo/skills-code/refactor/SKILL.md', text: '---\nname: refactor\ndescription: Refactor.\n---\nSteps.' },
        { path: '.agents/skills-architect/design/SKILL.md', text: '---\nname: design\ndescription: Design.\n---\nSteps.' },
      ],
      ['roo-code'],
    );
    expect(find(u, 'roo-code', '.roo/skills/pdf/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'roo-code', '.agents/skills/sql/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'roo-code', '.roo/skills-code/refactor/SKILL.md')).toMatchObject({ mode: 'on-demand', trigger: 'only in that Roo mode (skill)' });
    expect(find(u, 'roo-code', '.agents/skills-architect/design/SKILL.md')!.mode).toBe('on-demand');
  });
});

describe('Kiro', () => {
  it('maps inclusion modes', () => {
    const u = classify(
      [
        { path: '.kiro/steering/product.md', text: 'No frontmatter means always.' },
        { path: '.kiro/steering/api.md', text: '---\ninclusion: fileMatch\nfileMatchPattern: "src/api/**"\n---\nAPI rules.' },
        { path: '.kiro/steering/release.md', text: '---\ninclusion: manual\n---\nRelease steps.' },
        { path: '.kiro/steering/db.md', text: '---\ninclusion: auto\nname: db\ndescription: Database work\n---\nDB rules.' },
        { path: 'pkg/AGENTS.md', text: 'Nested.' },
      ],
      ['kiro'],
    );
    expect(find(u, 'kiro', '.kiro/steering/product.md')!.mode).toBe('always');
    expect(find(u, 'kiro', '.kiro/steering/api.md')!.trigger).toBe('fileMatch: src/api/**');
    expect(find(u, 'kiro', '.kiro/steering/release.md')!.mode).toBe('manual');
    expect(find(u, 'kiro', '.kiro/steering/db.md', 'description')!.text).toBe('Database work');
  });

  it('always includes AGENTS.md, also from subdirectories, and lists skills', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Root.' },
        { path: 'services/api/AGENTS.md', text: 'Nested.' },
        { path: '.kiro/skills/pr-review/SKILL.md', text: '---\nname: pr-review\ndescription: Review pull requests.\n---\nSteps.' },
      ],
      ['kiro'],
    );
    expect(find(u, 'kiro', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'kiro', 'services/api/AGENTS.md')).toMatchObject({ mode: 'always', trigger: 'always included, found in services/api/' });
    expect(find(u, 'kiro', '.kiro/skills/pr-review/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'kiro', '.kiro/skills/pr-review/SKILL.md', 'body')!.mode).toBe('on-demand');
  });
});

describe('JetBrains Junie', () => {
  it('uses .junie/AGENTS.md exclusively when present', () => {
    const u = classify(
      [
        { path: '.junie/AGENTS.md', text: 'Junie only.' },
        { path: 'AGENTS.md', text: 'Shared.' },
        { path: '.junie/guidelines.md', text: 'Legacy.' },
      ],
      ['junie'],
    );
    expect(find(u, 'junie', '.junie/AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'junie', 'AGENTS.md')!.mode).toBe('ignored');
    expect(find(u, 'junie', '.junie/guidelines.md')!.trigger).toBe('.junie/AGENTS.md takes precedence');
  });

  it('combines root AGENTS.md with playbook and rules, and falls back to guidelines', () => {
    const both = classify(
      [
        { path: 'AGENTS.md', text: 'Shared.' },
        { path: '.junie/rules/style.md', text: 'Style.' },
      ],
      ['junie'],
    );
    expect(find(both, 'junie', '.junie/rules/style.md')!.mode).toBe('always');
    const legacy = classify([{ path: '.junie/guidelines/a.md', text: 'Old.' }], ['junie']);
    expect(find(legacy, 'junie', '.junie/guidelines/a.md')!.mode).toBe('always');
  });

  it('lists skills from .junie/skills and .agents/skills without touching the guideline order', () => {
    const u = classify(
      [
        { path: '.junie/AGENTS.md', text: 'Junie only.' },
        { path: '.junie/skills/rest/SKILL.md', text: '---\nname: rest\ndescription: REST endpoints.\n---\nSteps.' },
        { path: '.agents/skills/tests/SKILL.md', text: '---\nname: tests\ndescription: Write tests.\n---\nSteps.' },
      ],
      ['junie'],
    );
    expect(find(u, 'junie', '.junie/AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'junie', '.junie/skills/rest/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'junie', '.agents/skills/tests/SKILL.md', 'description')!.mode).toBe('always');
  });
});

describe('Zed', () => {
  it('reads only the first matching file', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
        { path: '.cursorrules', text: 'Cursor.' },
      ],
      ['zed'],
    );
    expect(find(u, 'zed', '.cursorrules')!.mode).toBe('always');
    expect(find(u, 'zed', 'AGENTS.md')!.trigger).toBe('.cursorrules takes precedence');
    expect(find(u, 'zed', 'CLAUDE.md')!.mode).toBe('ignored');
  });

  it('lists skills only from the flat .agents/skills layout', () => {
    const u = classify(
      [
        { path: '.agents/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy.\n---\nSteps.' },
        { path: '.agents/skills/group/nested/SKILL.md', text: '---\nname: nested\ndescription: Not discovered.\n---\nSteps.' },
        { path: '.agents/skills/manual/SKILL.md', text: '---\nname: manual\ndescription: Hidden.\ndisable-model-invocation: true\n---\nSteps.' },
      ],
      ['zed'],
    );
    expect(find(u, 'zed', '.agents/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'zed', '.agents/skills/group/nested/SKILL.md', 'description')).toBeUndefined();
    expect(find(u, 'zed', '.agents/skills/manual/SKILL.md', 'description')!.mode).toBe('manual');
  });
});

describe('Continue', () => {
  it('applies alwaysApply, globs and description', () => {
    const u = classify(
      [
        { path: '.continue/rules/a.md', text: 'No frontmatter.' },
        { path: '.continue/rules/b.md', text: '---\nglobs: "**/*.ts"\n---\nTS only.' },
        { path: '.continue/rules/c.md', text: '---\nalwaysApply: false\ndescription: Migrations\n---\nBody.' },
        { path: '.continue/rules/d.md', text: '---\nalwaysApply: true\nglobs: "**/*.py"\n---\nAlways.' },
      ],
      ['continue'],
    );
    expect(find(u, 'continue', '.continue/rules/a.md')!.mode).toBe('always');
    expect(find(u, 'continue', '.continue/rules/b.md')!.mode).toBe('on-demand');
    expect(find(u, 'continue', '.continue/rules/c.md', 'description')!.mode).toBe('always');
    expect(find(u, 'continue', '.continue/rules/c.md', 'body')!.mode).toBe('on-demand');
    expect(find(u, 'continue', '.continue/rules/d.md')!.mode).toBe('always');
  });
});

describe('Aider', () => {
  it('counts CONVENTIONS.md only when .aider.conf.yml reads it', () => {
    const manual = classify([{ path: 'CONVENTIONS.md', text: 'Conventions.' }], ['aider']);
    expect(find(manual, 'aider', 'CONVENTIONS.md')!.mode).toBe('manual');
    const read = classify(
      [
        { path: 'CONVENTIONS.md', text: 'Conventions.' },
        { path: '.aider.conf.yml', text: 'model: x\nread:\n  - CONVENTIONS.md\n' },
      ],
      ['aider'],
    );
    expect(find(read, 'aider', 'CONVENTIONS.md')!.mode).toBe('always');
  });
});

describe('Goose', () => {
  it('loads root hints always and nested hints on demand', () => {
    const u = classify(
      [
        { path: '.goosehints', text: 'Hints.' },
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'pkg/.goosehints', text: 'Nested.' },
      ],
      ['goose'],
    );
    expect(find(u, 'goose', '.goosehints')!.mode).toBe('always');
    expect(find(u, 'goose', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'goose', 'pkg/.goosehints')!.mode).toBe('on-demand');
  });

  it('includes files referenced with @, one level deep, and lists skills', () => {
    const u = classify(
      [
        { path: '.goosehints', text: 'Go through the @README.md first.\n' },
        { path: 'README.md', text: 'Build with @docs/build.md.\n' },
        { path: 'docs/build.md', text: 'Run make.\n' },
        { path: '.goose/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy.\n---\nSteps.' },
      ],
      ['goose'],
    );
    expect(find(u, 'goose', 'README.md')).toMatchObject({ mode: 'always', importedFrom: '.goosehints' });
    expect(find(u, 'goose', 'docs/build.md')).toBeUndefined();
    expect(find(u, 'goose', '.goose/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
  });
});

describe('Amp', () => {
  it('falls back to CLAUDE.md and loads mentioned files with globs on demand', () => {
    const u = classify(
      [
        { path: 'CLAUDE.md', text: 'See @docs/ts.md and @docs/always.md' },
        { path: 'docs/ts.md', text: '---\nglobs: ["**/*.ts"]\n---\nTypeScript rules.' },
        { path: 'docs/always.md', text: 'Always included.' },
        { path: 'pkg/AGENTS.md', text: 'Nested.' },
      ],
      ['amp'],
    );
    expect(find(u, 'amp', 'CLAUDE.md')!.mode).toBe('always');
    expect(find(u, 'amp', 'docs/ts.md')!.mode).toBe('on-demand');
    expect(find(u, 'amp', 'docs/ts.md')!.text).toBe('TypeScript rules.');
    expect(find(u, 'amp', 'docs/always.md')!.mode).toBe('always');
    expect(find(u, 'amp', 'pkg/AGENTS.md')!.mode).toBe('on-demand');
  });

  it('expands glob @-mentions relative to the mentioning file', () => {
    const files = [
      { path: 'AGENTS.md', text: 'See @docs/*.md and @.agent/**/*.md.' },
      { path: 'docs/style.md', text: 'Style.' },
      { path: 'docs/ts.md', text: '---\nglobs: ["**/*.ts"]\n---\nTypeScript rules.' },
      { path: 'docs/deep/no.md', text: 'One star stays in its folder.' },
      { path: '.agent/a.md', text: 'A.' },
      { path: '.agent/x/y/b.md', text: 'B.' },
      { path: 'pkg/AGENTS.md', text: 'Also @../other/s*.md' },
      { path: 'other/setup.md', text: 'Setup.' },
    ];
    const u = classify(files, ['amp', 'claude-code']);
    expect(find(u, 'amp', 'docs/style.md')).toMatchObject({ mode: 'always', importedFrom: 'AGENTS.md' });
    expect(find(u, 'amp', 'docs/ts.md')!.mode).toBe('on-demand');
    expect(find(u, 'amp', 'docs/deep/no.md')).toBeUndefined();
    expect(find(u, 'amp', '.agent/a.md')!.mode).toBe('always');
    expect(find(u, 'amp', '.agent/x/y/b.md')!.mode).toBe('always');
    expect(find(u, 'amp', 'other/setup.md')).toMatchObject({ mode: 'on-demand', importedFrom: 'pkg/AGENTS.md' });
    // Claude Code imports name single files; a glob is not expanded.
    expect(find(u, 'claude-code', 'docs/style.md')).toBeUndefined();
  });

  it('discovers the files a glob mention matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-glob-'));
    try {
      mkdirSync(join(dir, 'docs/deep'), { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), 'See @docs/*.md\r\n');
      writeFileSync(join(dir, 'docs/style.md'), 'Style.');
      writeFileSync(join(dir, 'docs/deep/no.md'), 'Not matched.');
      expect((await discover(dir)).map((f) => f.path)).toEqual(['AGENTS.md', 'docs/style.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Sources that list paths up front (git, the web page) pass them in. Only Amp's own files expand globs,
    // and only one level deep, as Amp follows mentions.
    const found = new Map([
      ['AGENTS.md', { path: 'AGENTS.md', text: 'See @docs/*.md' }],
      ['.github/copilot-instructions.md', { path: '.github/copilot-instructions.md', text: 'See @src/*.md' }],
    ]);
    const texts: Record<string, string> = { 'docs/a.md': 'Then @more/*.md', 'more/m.md': 'M.', 'src/x.md': 'X.' };
    await addImports(found, (p) => texts[p] ?? null, ['docs/a.md', 'docs/b.txt', 'more/m.md', 'src/x.md']);
    expect([...found.keys()]).toEqual(['AGENTS.md', '.github/copilot-instructions.md', 'docs/a.md']);
  });

  it('finds skills up to five folders below each skills root and uses the first of a name', () => {
    const u = classify(
      [
        { path: '.agents/skills/team/a/b/c/deep/SKILL.md', text: '---\nname: deep\ndescription: Deep skill.\n---\nSteps.' },
        { path: '.agents/skills/a/b/c/d/e/f/SKILL.md', text: '---\nname: f\ndescription: Too deep.\n---\nSteps.' },
        { path: '.claude/skills/deep/SKILL.md', text: '---\nname: deep\ndescription: Masked.\n---\nSteps.' },
      ],
      ['amp'],
    );
    expect(find(u, 'amp', '.agents/skills/team/a/b/c/deep/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'amp', '.agents/skills/a/b/c/d/e/f/SKILL.md', 'description')).toBeUndefined();
    expect(find(u, 'amp', '.claude/skills/deep/SKILL.md', 'description')!.mode).toBe('ignored');
  });
});

describe('OpenCode', () => {
  it('reads AGENTS.md, or CLAUDE.md when there is none', () => {
    const both = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
      ],
      ['opencode'],
    );
    expect(find(both, 'opencode', 'AGENTS.md')!.mode).toBe('always');
    expect(find(both, 'opencode', 'CLAUDE.md')!.mode).toBe('ignored');
    const claudeOnly = classify([{ path: 'CLAUDE.md', text: 'Claude.' }], ['opencode']);
    expect(find(claudeOnly, 'opencode', 'CLAUDE.md')!.mode).toBe('always');
  });

  it('lists skills from .opencode, .claude and .agents, reading nested folders only when launched there', () => {
    const u = classify(
      [
        { path: '.opencode/skills/git-release/SKILL.md', text: '---\nname: git-release\ndescription: Releases.\n---\nSteps.' },
        { path: '.agents/skills/git-release/SKILL.md', text: '---\nname: git-release\ndescription: Masked.\n---\nSteps.' },
        { path: 'pkg/.claude/skills/pkg/SKILL.md', text: '---\nname: pkg\ndescription: Pkg.\n---\nSteps.' },
      ],
      ['opencode'],
    );
    expect(find(u, 'opencode', '.opencode/skills/git-release/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'opencode', '.agents/skills/git-release/SKILL.md', 'description')!.mode).toBe('ignored');
    expect(find(u, 'opencode', 'pkg/.claude/skills/pkg/SKILL.md', 'description')!.mode).toBe('ignored');
  });
});

describe('Claude Code size limits', () => {
  const flagged = (path: string, chars: number, text = 'x') => {
    const files = [{ path, text: text.repeat(chars) }];
    return buildAdvice(classify(files, ['claude-code']), files)
      .filter((a) => a.kind === 'size-limit' && a.tools.includes('claude-code'))
      .map((a) => a.message);
  };
  const over40k = (path: string, chars: number) => flagged(path, chars).filter((m) => /limit 40000/.test(m));

  it('flags a nested CLAUDE.md or rule over 40,000 characters, not the root files', () => {
    for (const p of ['pkg/CLAUDE.md', 'pkg/CLAUDE.local.md', 'pkg/.claude/rules/big.md', 'pkg/.claude/CLAUDE.md'])
      expect(over40k(p, 40001).length, p).toBe(1);
    expect(over40k('pkg/CLAUDE.md', 40000)).toEqual([]);
    for (const p of ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/big.md']) expect(over40k(p, 40001), p).toEqual([]);
    // User files (--include-user) load whole at launch too.
    const limit = getTool('claude-code').limits.find((l) => l.max === 40000)!;
    for (const p of ['~/.claude/CLAUDE.md', '~/.claude/rules/big.md']) expect(limit.pattern.test(p), p).toBe(false);
  });

  it('counts a root CLAUDE.md over 4 MiB as not loaded, with the reason as a finding', () => {
    const big = 'word '.repeat(4 * 1024 * 1024 / 5 + 1);
    const files = [
      { path: 'CLAUDE.md', text: big },
      { path: 'pkg/CLAUDE.md', text: big },
    ];
    const units = classify(files, ['claude-code']);
    expect(units.find((u) => u.path === 'CLAUDE.md')).toMatchObject({ mode: 'ignored', problem: 'Claude Code skips a CLAUDE.md over 4 MiB at launch and loads none of it.' });
    // Only files read at launch are skipped; a nested file is cut at 40,000 characters instead.
    expect(units.find((u) => u.path === 'pkg/CLAUDE.md')!.mode).toBe('on-demand');
    expect(classify([{ path: 'CLAUDE.md', text: 'word '.repeat(1000) }], ['claude-code'])[0]!.mode).toBe('always');
  });

  it('measures the 4 MiB on the file as it is on disk, CRLF included', () => {
    // Under 4 MiB once \r\n becomes \n, over it as checked out with CRLF.
    const text = Array.from({ length: 65078 }, () => 'x'.repeat(63)).join('\r\n');
    expect(classify([{ path: 'CLAUDE.md', text }], ['claude-code'])[0]!.mode).toBe('ignored');
  });

  it('discovers an @import chain as deep as Copilot follows it', async () => {
    const texts: Record<string, string> = { 'docs/i6.md': 'Six.' };
    for (let i = 1; i <= 5; i++) texts[`docs/i${i}.md`] = `Hop ${i}.\n@i${i + 1}.md`;
    const found = new Map([['AGENTS.md', { path: 'AGENTS.md', text: 'Root.\n@docs/i1.md' }]]);
    await addImports(found, (p) => texts[p] ?? null, Object.keys(texts));
    expect(found.has('docs/i6.md')).toBe(true);
    expect(find(classify([...found.values()], ['copilot']), 'copilot', 'docs/i6.md')!.mode).toBe('always');
  });

  it('limits a CLAUDE.md read at launch to 4 MiB, and no nested file', () => {
    // Tokenising a 4 MiB file is too slow for a test, so the limit entry is checked directly.
    const limit = getTool('claude-code').limits.find((l) => l.unit === 'bytes')!;
    expect(limit).toMatchObject({ max: 4 * 1024 * 1024, severity: 'limit' });
    for (const p of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '~/.claude/CLAUDE.md']) expect(limit.pattern.test(p), p).toBe(true);
    for (const p of ['pkg/CLAUDE.md', 'pkg/.claude/CLAUDE.md']) expect(limit.pattern.test(p), p).toBe(false);
  });
});

describe('Claude Code skill listing budget', () => {
  const desc = (i: number) => `Handles workflow ${i} for reports, exports and audits of the billing service; use it when the user asks about ${i}.`.padEnd(190, '.');
  const skill = (dir: string, i: number, extra = '') => ({ path: `${dir}/s${i}/SKILL.md`, text: `---\nname: s${i}\ndescription: ${desc(i)}\n${extra}---\nBody.` });
  const budget = (files: Array<{ path: string; text: string }>) =>
    buildAdvice(classify(files, ['claude-code']), files).filter((a) => a.kind === 'size-limit' && /listing budget/.test(a.message));

  it('flags skill and command descriptions over 30,000 characters', () => {
    const files = [
      ...Array.from({ length: 140 }, (_, i) => skill('.claude/skills', i)),
      ...Array.from({ length: 20 }, (_, i) => ({ path: `.claude/commands/c${i}.md`, text: `---\ndescription: ${desc(i)}\n---\nDo it.` })),
    ];
    const [a] = budget(files);
    expect(a).toMatchObject({ severity: 'high', tools: ['claude-code'], savingTokens: null });
    expect(a!.message).toMatch(/^160 skill and command descriptions take about 3\d,\d{3} characters, over the listing budget of 30,000\./);
    expect(a!.paths).toHaveLength(3);
  });

  it('stays quiet under the budget, and leaves out subagents and skills hidden from the model', () => {
    expect(budget(Array.from({ length: 100 }, (_, i) => skill('.claude/skills', i)))).toEqual([]);
    const hidden = Array.from({ length: 200 }, (_, i) => skill('.claude/skills', i, 'disable-model-invocation: true\n'));
    const agents = Array.from({ length: 200 }, (_, i) => ({ path: `.claude/agents/a${i}.md`, text: `---\nname: a${i}\ndescription: ${desc(i)}\n---\nPrompt.` }));
    expect(budget([...hidden, ...agents])).toEqual([]);
  });
});

describe('discovery patterns', () => {
  it('recognises the new agents files', () => {
    for (const p of [
      '.clinerules/a.md',
      '.cline/rules/a.md',
      '.roo/rules/a.md',
      '.roo/rules-code/a.md',
      '.roorules',
      '.kiro/steering/a.md',
      '.junie/AGENTS.md',
      '.junie/rules/a.md',
      '.rules',
      '.continue/rules/a.md',
      'CONVENTIONS.md',
      '.aider.conf.yml',
      '.goosehints',
      'AGENT.md',
      'agents.md',
      '.claude/agents/review/security.md',
      '.github/skills/a/SKILL.md',
      '.cursor/skills/category/a/SKILL.md',
      '.codex/skills/a/SKILL.md',
      '.gemini/skills/a/SKILL.md',
      '.devin/skills/a/SKILL.md',
      '.windsurf/skills/a/SKILL.md',
      '.cline/skills/a/SKILL.md',
      '.clinerules/skills/a/SKILL.md',
      '.roo/skills/a/SKILL.md',
      '.roo/skills-code/a/SKILL.md',
      '.agents/skills-code/a/SKILL.md',
      '.kiro/skills/a/SKILL.md',
      '.junie/skills/a/SKILL.md',
      '.goose/skills/a/SKILL.md',
      '.opencode/skills/a/SKILL.md',
      'pkg/.agents/skills/a/b/c/SKILL.md',
    ])
      expect(isInstructionFile(p), p).toBe(true);
    for (const p of ['plugins/turntax/skills/a/SKILL.md', '.github/skills/a/README.md', '.agents/skills/SKILL.md'])
      expect(isInstructionFile(p), p).toBe(false);
  });
});
