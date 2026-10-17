import { describe, expect, it } from 'vitest';
import { classify, detectTools } from '../src/core/classify.js';
import { getTool } from '../src/core/tools.js';
import { find, loadFixture } from './helpers.js';

const MIXED = await loadFixture('mixed');
const AGENTS_ONLY = await loadFixture('agents-only');

describe('discovery', () => {
  it('finds instruction files and imports, skipping node_modules', () => {
    const paths = MIXED.map((f) => f.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('docs/extra.md');
    expect(paths).toContain('.cursor/rules/wrong.md');
    expect(paths).not.toContain('node_modules/pkg/CLAUDE.md');
    expect(paths).not.toContain('package.json');
  });
});

describe('Claude Code', () => {
  const units = classify(MIXED, ['claude-code']);

  it('loads root CLAUDE.md every turn with HTML comments stripped', () => {
    const u = find(units, 'claude-code', 'CLAUDE.md')!;
    expect(u.mode).toBe('always');
    expect(u.text).not.toContain('maintainer note');
    expect(u.notes.join(' ')).toMatch(/HTML comments removed/);
  });

  it('expands @imports into always-loaded units', () => {
    const u = find(units, 'claude-code', 'docs/extra.md')!;
    expect(u.mode).toBe('always');
    expect(u.importedFrom).toBe('CLAUDE.md');
  });

  it('ignores AGENTS.md when CLAUDE.md exists', () => {
    const u = find(units, 'claude-code', 'AGENTS.md')!;
    expect(u.mode).toBe('ignored');
    expect(u.trigger).toMatch(/CLAUDE\.md exists/);
  });

  it('loads nested CLAUDE.md on demand', () => {
    const u = find(units, 'claude-code', 'packages/api/CLAUDE.md')!;
    expect(u.mode).toBe('on-demand');
    expect(u.trigger).toContain('packages/api/');
  });

  it('loads rules without paths always and path-scoped rules on demand', () => {
    expect(find(units, 'claude-code', '.claude/rules/general.md')!.mode).toBe('always');
    const ts = find(units, 'claude-code', '.claude/rules/ts.md')!;
    expect(ts.mode).toBe('on-demand');
    expect(ts.text).not.toContain('paths:');
  });

  it('lists skill descriptions every turn and loads bodies on demand', () => {
    const d = find(units, 'claude-code', '.claude/skills/deploy/SKILL.md', 'description')!;
    expect(d.mode).toBe('always');
    expect(d.text).toBe('deploy: Deploy the app to staging or production with the release checklist.');
    expect(find(units, 'claude-code', '.claude/skills/deploy/SKILL.md', 'body')!.mode).toBe('on-demand');
    expect(find(units, 'claude-code', '.claude/skills/secret/SKILL.md', 'description')!.mode).toBe('manual');
  });

  it('reads AGENTS.md when there is no CLAUDE.md, and nested AGENTS.md on demand', () => {
    const u = classify(AGENTS_ONLY, ['claude-code']);
    expect(find(u, 'claude-code', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'claude-code', 'sub/AGENTS.md')!.mode).toBe('on-demand');
  });

  it('caps skill descriptions at 1536 characters', () => {
    const long = 'x'.repeat(2000);
    const u = classify([{ path: '.claude/skills/a/SKILL.md', text: `---\nname: a\ndescription: ${long}\n---\nbody` }], ['claude-code']);
    const d = find(u, 'claude-code', '.claude/skills/a/SKILL.md', 'description')!;
    expect(d.text.length).toBe('a: '.length + 1536);
  });

  it('reads subagents recursively, but not from nested .claude/agents folders below the launch directory', () => {
    const u = classify(
      [
        { path: '.claude/agents/review/security.md', text: '---\nname: security-review\ndescription: Reviews for security issues.\n---\nYou review code.' },
        { path: 'pkg/.claude/agents/pkg-helper.md', text: '---\nname: pkg-helper\ndescription: Helps in pkg.\n---\nYou help.' },
      ],
      ['claude-code'],
    );
    const root = find(u, 'claude-code', '.claude/agents/review/security.md', 'description')!;
    expect(root).toMatchObject({ mode: 'always', text: 'security-review: Reviews for security issues.' });
    const nested = find(u, 'claude-code', 'pkg/.claude/agents/pkg-helper.md', 'description')!;
    expect(nested.mode).toBe('ignored');
    expect(nested.trigger).toMatch(/only from the launch directory up; read only when launched in pkg\/$/);
    expect(find(u, 'claude-code', 'pkg/.claude/agents/pkg-helper.md', 'body')!.mode).toBe('ignored');
  });

  it('prefers a skill over a command of the same name, and names commands after their file', () => {
    const u = classify(
      [
        { path: '.claude/skills/deploy/SKILL.md', text: '---\ndescription: Deploy the app.\n---\nSteps.' },
        { path: '.claude/commands/deploy.md', text: '---\ndescription: Old deploy command.\n---\nOld steps.' },
        { path: '.claude/commands/frontend/component.md', text: '---\ndescription: Make a component.\n---\nSteps.' },
        { path: 'pkg/.claude/skills/deploy/SKILL.md', text: '---\ndescription: Deploy pkg.\n---\nSteps.' },
      ],
      ['claude-code'],
    );
    const command = find(u, 'claude-code', '.claude/commands/deploy.md', 'description')!;
    expect(command.mode).toBe('ignored');
    expect(command.trigger).toBe('same skill name as .claude/skills/deploy/SKILL.md, which takes precedence');
    expect(find(u, 'claude-code', '.claude/commands/frontend/component.md', 'description')!.text).toBe('frontend:component: Make a component.');
    // A nested skill with the same name as a root skill also loads.
    expect(find(u, 'claude-code', 'pkg/.claude/skills/deploy/SKILL.md', 'description')!.mode).toBe('on-demand');
  });

  it('follows imports up to four hops', () => {
    const files = [
      { path: 'CLAUDE.md', text: '@a.md' },
      { path: 'a.md', text: '@b.md' },
      { path: 'b.md', text: '@c.md' },
      { path: 'c.md', text: '@d.md' },
      { path: 'd.md', text: '@e.md' },
      { path: 'e.md', text: 'too deep' },
    ];
    const paths = classify(files, ['claude-code']).map((u) => u.path);
    expect(paths).toEqual(['CLAUDE.md', 'a.md', 'b.md', 'c.md', 'd.md']);
  });
});

describe('several files at one level', () => {
  it('counts CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md together', () => {
    const u = classify(
      [
        { path: 'CLAUDE.md', text: 'Team rules.' },
        { path: '.claude/CLAUDE.md', text: 'More team rules.' },
        { path: 'CLAUDE.local.md', text: 'My notes.' },
      ],
      ['claude-code'],
    );
    expect(u.filter((x) => x.mode === 'always').map((x) => x.path).sort()).toEqual(['.claude/CLAUDE.md', 'CLAUDE.local.md', 'CLAUDE.md']);
  });
});

describe('line endings', () => {
  it('treats CRLF files like LF files', () => {
    const lf = 'Line one.\n\nLine two.\n';
    const units = classify([
      { path: 'CLAUDE.md', text: lf.replace(/\n/g, '\r\n') },
      { path: 'pkg/CLAUDE.md', text: lf.replace(/\n/g, '\r\n') },
    ]);
    const claude = find(units, 'claude-code', 'CLAUDE.md')!;
    expect(claude.text).toBe(lf);
    expect(claude.notes).toEqual([]);
    expect(find(units, 'claude-code', 'pkg/CLAUDE.md')!.text).toBe(find(units, 'cursor', 'pkg/CLAUDE.md')!.text);
  });
});

describe('nested rule folders', () => {
  it('apply only when the agent works in that subdirectory', () => {
    const files = [
      { path: 'pkg/.claude/rules/a.md', text: 'Nested Claude rule.' },
      { path: 'pkg/.cursor/rules/a.mdc', text: '---\nalwaysApply: true\n---\nNested Cursor rule.' },
      { path: 'pkg/.windsurf/rules/a.md', text: '---\ntrigger: always_on\n---\nNested Windsurf rule.' },
    ];
    const u = classify(files);
    for (const [tool, path] of [
      ['claude-code', 'pkg/.claude/rules/a.md'],
      ['cursor', 'pkg/.cursor/rules/a.mdc'],
      ['windsurf', 'pkg/.windsurf/rules/a.md'],
    ] as const) {
      const unit = find(u, tool, path)!;
      expect(unit.mode).toBe('on-demand');
      expect(unit.trigger).toBe('when working in pkg/');
    }
  });
});

describe('Codex', () => {
  it('prefers AGENTS.override.md and truncates at 32 KiB', () => {
    const big = 'a'.repeat(40 * 1024);
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'plain' },
        { path: 'AGENTS.override.md', text: big },
      ],
      ['codex'],
    );
    const override = find(u, 'codex', 'AGENTS.override.md')!;
    expect(override.mode).toBe('always');
    expect(override.text.length).toBe(32 * 1024);
    expect(override.notes.join(' ')).toMatch(/Truncated/);
    expect(find(u, 'codex', 'AGENTS.md')!.mode).toBe('ignored');
  });

  it('only loads nested AGENTS.md when launched there', () => {
    const u = classify(AGENTS_ONLY, ['codex']);
    expect(find(u, 'codex', 'sub/AGENTS.md')!.mode).toBe('on-demand');
  });

  it('lists skills with their path, and reads nested skill folders only when launched there', () => {
    const u = classify(
      [
        { path: '.agents/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy the app.\n---\nSteps.' },
        { path: 'pkg/.agents/skills/pkg/SKILL.md', text: '---\nname: pkg\ndescription: Pkg work.\n---\nSteps.' },
      ],
      ['codex'],
    );
    expect(find(u, 'codex', '.agents/skills/deploy/SKILL.md', 'description')!.text).toBe('deploy: Deploy the app. (.agents/skills/deploy/SKILL.md)');
    const nested = find(u, 'codex', 'pkg/.agents/skills/pkg/SKILL.md', 'description')!;
    expect(nested.mode).toBe('ignored');
    expect(nested.trigger).toMatch(/read only when launched in pkg\/$/);
  });
});

describe('same-name skills', () => {
  const skill = (path: string, extra = '') => ({ path, text: `---\nname: deploy\ndescription: Deploy the app.${extra}\n---\nSteps.` });

  it('keep the copy from the folder that takes precedence and ignore the others', () => {
    // Gemini CLI: .agents/skills wins over .gemini/skills.
    const gemini = classify([skill('.gemini/skills/deploy/SKILL.md'), skill('.agents/skills/deploy/SKILL.md')], ['gemini-cli']);
    expect(find(gemini, 'gemini-cli', '.agents/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    const loser = find(gemini, 'gemini-cli', '.gemini/skills/deploy/SKILL.md', 'description')!;
    expect(loser.mode).toBe('ignored');
    expect(loser.trigger).toBe('same skill name as .agents/skills/deploy/SKILL.md, which takes precedence');
    expect(find(gemini, 'gemini-cli', '.gemini/skills/deploy/SKILL.md', 'body')!.mode).toBe('ignored');
    // Roo Code: .roo/skills wins over .agents/skills.
    const roo = classify([skill('.agents/skills/deploy/SKILL.md'), skill('.roo/skills/deploy/SKILL.md')], ['roo-code']);
    expect(find(roo, 'roo-code', '.roo/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(roo, 'roo-code', '.agents/skills/deploy/SKILL.md', 'description')!.mode).toBe('ignored');
  });

  it('use the folder name when there is no name field, and are compared per directory level', () => {
    const files = [
      { path: '.agents/skills/deploy/SKILL.md', text: '---\ndescription: Deploy.\n---\nSteps.' },
      { path: '.claude/skills/deploy/SKILL.md', text: '---\ndescription: Deploy too.\n---\nSteps.' },
      { path: 'pkg/.cursor/skills/deploy/SKILL.md', text: '---\ndescription: Deploy pkg.\n---\nSteps.' },
    ];
    const u = classify(files, ['amp', 'cursor']);
    expect(find(u, 'amp', '.claude/skills/deploy/SKILL.md', 'description')!.mode).toBe('ignored');
    expect(find(u, 'cursor', '.claude/skills/deploy/SKILL.md', 'description')!.mode).toBe('ignored');
    expect(find(u, 'cursor', 'pkg/.cursor/skills/deploy/SKILL.md', 'description')!.mode).toBe('on-demand');
  });
});

describe('Cursor', () => {
  const units = classify(MIXED, ['cursor']);

  it('decides .mdc rules from frontmatter', () => {
    expect(find(units, 'cursor', '.cursor/rules/always.mdc')!.mode).toBe('always');
    expect(find(units, 'cursor', '.cursor/rules/ts.mdc')!.mode).toBe('on-demand');
    expect(find(units, 'cursor', '.cursor/rules/desc.mdc', 'description')!.text).toBe('Database migration conventions');
    expect(find(units, 'cursor', '.cursor/rules/desc.mdc', 'body')!.mode).toBe('on-demand');
  });

  it('flags .md files in .cursor/rules as ignored', () => {
    const u = find(units, 'cursor', '.cursor/rules/wrong.md')!;
    expect(u.mode).toBe('ignored');
    expect(u.problem).toMatch(/\.mdc/);
  });

  it('always applies root AGENTS.md and CLAUDE.md', () => {
    expect(find(units, 'cursor', 'AGENTS.md')!.mode).toBe('always');
    expect(find(units, 'cursor', 'CLAUDE.md')!.mode).toBe('always');
  });

  it('lists skills from its own and compatible folders, including category folders, and scopes paths and nested skills', () => {
    const u = classify(
      [
        { path: '.cursor/skills/shipping/land-it/SKILL.md', text: '---\nname: land-it\ndescription: Land a change.\n---\nSteps.' },
        { path: '.codex/skills/py/SKILL.md', text: '---\nname: py\ndescription: Python style.\npaths: "**/*.py"\n---\nRules.' },
        { path: '.claude/skills/old/SKILL.md', text: '---\nname: old\ndescription: Legacy globs.\nglobs: ["**/*.rb"]\n---\nRules.' },
        { path: '.agents/skills/manual/SKILL.md', text: '---\nname: manual\ndescription: Only by hand.\ndisable-model-invocation: true\n---\nSteps.' },
        { path: 'apps/web/.cursor/skills/deploy-web/SKILL.md', text: '---\nname: deploy-web\ndescription: Deploy web.\n---\nSteps.' },
        { path: 'apps/web/.claude/skills/claude-web/SKILL.md', text: '---\nname: claude-web\ndescription: Claude web.\n---\nSteps.' },
      ],
      ['cursor'],
    );
    expect(find(u, 'cursor', '.cursor/skills/shipping/land-it/SKILL.md', 'description')).toMatchObject({ mode: 'always', text: 'land-it: Land a change.' });
    expect(find(u, 'cursor', '.codex/skills/py/SKILL.md', 'description')).toMatchObject({ mode: 'on-demand', trigger: 'paths: **/*.py' });
    expect(find(u, 'cursor', '.claude/skills/old/SKILL.md', 'description')).toMatchObject({ mode: 'on-demand', trigger: 'globs: **/*.rb' });
    expect(find(u, 'cursor', '.agents/skills/manual/SKILL.md', 'description')!.mode).toBe('manual');
    expect(find(u, 'cursor', 'apps/web/.cursor/skills/deploy-web/SKILL.md', 'description')).toMatchObject({
      mode: 'on-demand',
      trigger: 'listed when working in apps/web/',
    });
    // Nested project skill folders are documented for .cursor and .agents only.
    expect(find(u, 'cursor', 'apps/web/.claude/skills/claude-web/SKILL.md', 'description')).toBeUndefined();
  });

  it('presents a description-only rule description to the agent without an inference note', () => {
    const d = find(units, 'cursor', '.cursor/rules/desc.mdc', 'description')!;
    expect(d.mode).toBe('always');
    expect(d.notes).toEqual([]);
  });
});

describe('Copilot', () => {
  const units = classify(MIXED, ['copilot']);
  it('loads repository instructions always and applyTo instructions on demand', () => {
    expect(find(units, 'copilot', '.github/copilot-instructions.md')!.mode).toBe('always');
    const api = find(units, 'copilot', '.github/instructions/api.instructions.md')!;
    expect(api.mode).toBe('on-demand');
    expect(api.trigger).toBe('applyTo: packages/api/**');
  });
  it('reads CLAUDE.md together with AGENTS.md at the root, as the VS Code Local harness does by default', () => {
    expect(find(units, 'copilot', 'AGENTS.md')!.mode).toBe('always');
    expect(find(units, 'copilot', 'CLAUDE.md')!.mode).toBe('always');
    // Only Copilot CLI and the Copilot harness read GEMINI.md; it is described in a note, not modelled.
    expect(find(units, 'copilot', 'GEMINI.md')).toBeUndefined();
    expect(getTool('copilot').notes.join(' ')).toMatch(/GEMINI\.md is read only there/);
    // The Local harness reads neither nested CLAUDE.md nor (by default) nested AGENTS.md.
    expect(find(units, 'copilot', 'packages/api/CLAUDE.md')!.mode).toBe('ignored');
    const nested = classify([{ path: 'AGENTS.md', text: 'Root.' }, { path: 'pkg/AGENTS.md', text: 'Nested.' }], ['copilot']);
    expect(find(nested, 'copilot', 'pkg/AGENTS.md')!.trigger).toMatch(/chat\.useNestedAgentsMdFiles/);
  });

  it('reads .claude/CLAUDE.md and CLAUDE.local.md, and .claude/rules on demand with paths defaulting to **', () => {
    const u = classify(
      [
        { path: '.claude/CLAUDE.md', text: 'Team.' },
        { path: 'CLAUDE.local.md', text: 'Mine.' },
        { path: '.claude/rules/all.md', text: 'Everywhere.' },
        { path: '.claude/rules/ts.md', text: '---\npaths:\n  - "src/**/*.ts"\n---\nTypeScript.' },
      ],
      ['copilot'],
    );
    expect(find(u, 'copilot', '.claude/CLAUDE.md')!.mode).toBe('always');
    expect(find(u, 'copilot', 'CLAUDE.local.md')!.mode).toBe('always');
    expect(find(u, 'copilot', '.claude/rules/all.md')).toMatchObject({ mode: 'on-demand', trigger: 'paths: ** (default)' });
    expect(find(u, 'copilot', '.claude/rules/ts.md')).toMatchObject({ mode: 'on-demand', trigger: 'paths: src/**/*.ts' });
  });

  it('lists skills from .github/skills, .claude/skills and .agents/skills without merging same names', () => {
    const skill = (path: string) => ({ path, text: '---\nname: deploy\ndescription: Deploy the app.\n---\nSteps.' });
    const u = classify([skill('.github/skills/deploy/SKILL.md'), skill('.claude/skills/deploy/SKILL.md'), skill('.agents/skills/deploy/SKILL.md')], ['copilot']);
    expect(u.filter((x) => x.part === 'description').map((x) => x.mode)).toEqual(['always', 'always', 'always']);
  });
});

describe('Windsurf', () => {
  const units = classify(MIXED, ['windsurf']);
  it('maps trigger modes and flags rules without a trigger', () => {
    expect(find(units, 'windsurf', '.windsurf/rules/a.md')!.mode).toBe('always');
    const b = find(units, 'windsurf', '.windsurf/rules/b.md')!;
    expect(b.mode).toBe('manual');
    expect(b.problem).toBeTruthy();
  });

  it('reads lowercase agents.md and skills from .devin, .windsurf and .agents, but not .claude/skills', () => {
    const u = classify(
      [
        { path: 'agents.md', text: 'Root.' },
        { path: 'web/agents.md', text: 'Web.' },
        { path: '.devin/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy.\n---\nSteps.' },
        { path: '.windsurf/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Old deploy.\n---\nSteps.' },
        { path: '.claude/skills/review/SKILL.md', text: '---\nname: review\ndescription: Review.\n---\nSteps.' },
      ],
      ['windsurf'],
    );
    expect(find(u, 'windsurf', 'agents.md')!.mode).toBe('always');
    expect(find(u, 'windsurf', 'web/agents.md')!.mode).toBe('on-demand');
    expect(find(u, 'windsurf', '.devin/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'windsurf', '.windsurf/skills/deploy/SKILL.md', 'description')!.mode).toBe('ignored');
    expect(find(u, 'windsurf', '.claude/skills/review/SKILL.md', 'description')).toBeUndefined();
  });
});

describe('Gemini CLI', () => {
  it('loads root GEMINI.md always and nested ones on demand', () => {
    const u = classify(
      [
        { path: 'GEMINI.md', text: 'root' },
        { path: 'pkg/GEMINI.md', text: 'nested' },
      ],
      ['gemini-cli'],
    );
    expect(find(u, 'gemini-cli', 'GEMINI.md')!.mode).toBe('always');
    expect(find(u, 'gemini-cli', 'pkg/GEMINI.md')!.mode).toBe('on-demand');
  });

  it('follows imports up to five levels', () => {
    const files = [
      { path: 'GEMINI.md', text: '@a.md' },
      { path: 'a.md', text: '@b.md' },
      { path: 'b.md', text: '@c.md' },
      { path: 'c.md', text: '@d.md' },
      { path: 'd.md', text: '@e.md' },
      { path: 'e.md', text: '@f.md' },
      { path: 'f.md', text: 'too deep' },
    ];
    expect(classify(files, ['gemini-cli']).map((u) => u.path)).toEqual(['GEMINI.md', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
  });
});

describe('detectTools', () => {
  it('reports tools that read at least one file', () => {
    expect(detectTools(classify(AGENTS_ONLY))).toEqual([
      'claude-code', 'codex', 'cursor', 'copilot', 'windsurf', 'roo-code', 'kiro', 'junie', 'zed', 'goose', 'amp', 'opencode',
      'warp', 'factory-droid', 'augment', 'kilo-code', 'jules', 'devin',
    ]);
  });
});
