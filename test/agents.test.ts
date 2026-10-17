import { describe, expect, it } from 'vitest';
import { classify } from '../src/core/classify.js';
import { isInstructionFile } from '../src/core/files.js';
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
