import { describe, expect, it } from 'vitest';
import { classify, detectTools } from '../src/core/classify.js';
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
});

describe('Copilot', () => {
  const units = classify(MIXED, ['copilot']);
  it('loads repository instructions always and applyTo instructions on demand', () => {
    expect(find(units, 'copilot', '.github/copilot-instructions.md')!.mode).toBe('always');
    const api = find(units, 'copilot', '.github/instructions/api.instructions.md')!;
    expect(api.mode).toBe('on-demand');
    expect(api.trigger).toBe('applyTo: packages/api/**');
  });
  it('uses AGENTS.md and ignores CLAUDE.md when AGENTS.md exists', () => {
    expect(find(units, 'copilot', 'AGENTS.md')!.mode).toBe('always');
    expect(find(units, 'copilot', 'CLAUDE.md')!.mode).toBe('ignored');
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
});

describe('detectTools', () => {
  it('reports tools that read at least one file', () => {
    expect(detectTools(classify(AGENTS_ONLY))).toEqual(['claude-code', 'codex', 'cursor', 'copilot', 'windsurf']);
  });
});
