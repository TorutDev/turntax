import { describe, expect, it } from 'vitest';
import { audit } from '../src/core/audit.js';
import { MODELS } from '../src/core/prices.js';
import { renderText } from '../src/core/render.js';
import { USER_ROOTS, classifyUser } from '../src/core/user.js';
import { discoverUser } from '../src/node/discover.js';
import { HOME_FIXTURE_FILES, homeFixture, materialize } from './helpers.js';

const home = discoverUser(homeFixture());

describe('user-level files', () => {
  it('finds instruction files and MCP configs in the home directory only where agents look', () => {
    expect(home.files.map((f) => f.path)).toEqual([
      '~/.claude/CLAUDE.md',
      '~/.claude/rules/style.md',
      '~/.codex/AGENTS.md',
      '~/.config/AGENTS.md',
      '~/.config/amp/AGENTS.md',
      '~/.gemini/GEMINI.md',
    ]);
    expect(home.mcpConfigs.map((f) => f.path)).toEqual(['~/.claude.json']);
  });

  it('classifies each file only for its own agent', () => {
    const units = classifyUser(home.files);
    const who = (path: string) => units.filter((u) => u.path === path && u.mode === 'always').map((u) => u.tool);
    // VS Code Copilot reads ~/.claude/CLAUDE.md; OpenCode falls back to it because there is no ~/.config/opencode/AGENTS.md.
    expect(who('~/.claude/CLAUDE.md')).toEqual(['claude-code', 'copilot', 'opencode', 'devin']);
    expect(who('~/.claude/rules/style.md')).toEqual(['claude-code']);
    expect(who('~/.codex/AGENTS.md')).toEqual(['codex']);
    expect(who('~/.gemini/GEMINI.md')).toEqual(['gemini-cli']);
    // Amp reads both of its user files.
    expect(who('~/.config/AGENTS.md')).toEqual(['amp']);
    expect(who('~/.config/amp/AGENTS.md')).toEqual(['amp']);
    expect(units.every((u) => u.scope === 'user' && u.trigger.startsWith('user level'))).toBe(true);
  });

  it('lets OpenCode fall back to ~/.claude/CLAUDE.md only without its own AGENTS.md', () => {
    const claude = home.files.find((f) => f.path === '~/.claude/CLAUDE.md')!;
    const fallback = classifyUser([claude], ['opencode']);
    expect(fallback[0]).toMatchObject({ tool: 'opencode', mode: 'always' });
    const withOwn = classifyUser([claude, { path: '~/.config/opencode/AGENTS.md', text: 'Own notes.' }], ['opencode']);
    expect(withOwn.find((u) => u.path === '~/.claude/CLAUDE.md')!.mode).toBe('ignored');
  });

  it('adds user tokens to the total but not to the repository count or badge', async () => {
    const files = [{ path: 'CLAUDE.md', text: 'Use npm for every script.\n' }];
    const report = await audit(files, { tools: ['claude-code', 'codex'], models: MODELS.filter((m) => m.id === 'gpt-6.1-sol'), userFiles: home.files });
    const claude = report.tools.find((t) => t.tool === 'claude-code')!;
    expect(claude.alwaysFiles).toBe(1);
    expect(claude.userAlwaysFiles).toBe(2);
    expect(claude.userPerTurnO200k).toBeGreaterThan(0);
    expect(claude.totalPerTurnO200k).toBe(claude.perTurnO200k + claude.userPerTurnO200k);
    expect(report.files.find((f) => f.path === '~/.claude/CLAUDE.md')!.scope).toBe('user');
    expect(renderText(report)).toContain('user/turn');
    // Codex does not read CLAUDE.md, so the pnpm rule in ~/.codex/AGENTS.md conflicts with nothing.
    expect(report.advice.some((a) => a.kind === 'contradiction' && a.paths.includes('~/.codex/AGENTS.md'))).toBe(false);
  });

  it('reports contradictions between user-level and repository files', async () => {
    const files = [{ path: 'AGENTS.md', text: 'Always use npm for installs.\n' }];
    const report = await audit(files, { tools: ['codex'], models: [], userFiles: home.files });
    const c = report.advice.find((a) => a.kind === 'contradiction')!;
    expect(c.paths.sort()).toEqual(['AGENTS.md', '~/.codex/AGENTS.md']);
  });

  it('finds the documented user folders of every agent', () => {
    const extra: Record<string, string> = {
      '.copilot/copilot-instructions.md': 'Personal Copilot rules.\n',
      '.copilot/instructions/py/style.instructions.md': '---\napplyTo: "**/*.py"\n---\nUse ruff.\n',
      '.copilot/skills/triage/SKILL.md': '---\nname: triage\ndescription: Triage issues.\n---\nSteps.\n',
      '.cursor/skills/team/review/SKILL.md': '---\nname: review\ndescription: Review.\n---\nSteps.\n',
      '.config/zed/AGENTS.md': 'Personal Zed rules.\n',
      'AppData/Roaming/Zed/AGENTS.md': 'Personal Zed rules on Windows.\n',
      '.config/goose/AGENTS.md': 'Personal goose rules.\n',
      '.junie/AGENTS.md': 'Personal Junie rules.\n',
      '.config/agents/skills/a/b/SKILL.md': '---\nname: b\ndescription: Amp skill.\n---\nSteps.\n',
      '.roo/skills-code/refactor/SKILL.md': '---\nname: refactor\ndescription: Refactor.\n---\nSteps.\n',
      '.claude/agents/review/security.md': '---\nname: security\ndescription: Security review.\n---\nPrompt.\n',
      '.claude/commands/team/ship.md': '---\ndescription: Ship it.\n---\nSteps.\n',
      '.claude/skills/a/b/c/d/e/SKILL.md': '---\nname: e\ndescription: Five folders deep (Amp).\n---\nSteps.\n',
      '.codeium/windsurf/memories/global_rules.md': 'Global Windsurf rules.\n',
      '.config/devin/skills/ship/SKILL.md': '---\nname: ship\ndescription: Ship it.\n---\nSteps.\n',
    };
    const found = discoverUser(materialize('home', { ...HOME_FIXTURE_FILES, ...extra })).files.map((f) => f.path);
    for (const path of Object.keys(extra)) expect(found, path).toContain(`~/${path}`);
  });

  it('walks each home folder once', () => {
    expect(new Set(USER_ROOTS.map((r) => r.dir)).size).toBe(USER_ROOTS.length);
    for (const outer of USER_ROOTS)
      for (const inner of USER_ROOTS.filter((r) => r.dir.startsWith(`${outer.dir}/`)))
        expect(outer.depth, `${outer.dir} also walks ${inner.dir}`).toBeLessThan(inner.dir.split('/').length - outer.dir.split('/').length);
  });

  it('reads each new user file for its own agent, in the mode of its project counterpart', () => {
    const files = [
      { path: '~/.copilot/copilot-instructions.md', text: 'Personal Copilot rules.\n' },
      { path: '~/.copilot/instructions/style.instructions.md', text: '---\napplyTo: "**/*.py"\n---\nUse ruff.\n' },
      { path: '~/.copilot/skills/triage/SKILL.md', text: '---\nname: triage\ndescription: Triage issues.\n---\nSteps.\n' },
      { path: '~/.config/zed/AGENTS.md', text: 'Personal Zed rules.\n' },
      { path: '~/.config/goose/AGENTS.md', text: 'Personal goose rules.\n' },
      { path: '~/.junie/AGENTS.md', text: 'Personal Junie rules.\n' },
      { path: '~/.config/amp/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy.\n---\nSteps.\n' },
    ];
    const units = classifyUser(files);
    const mode = (tool: string, path: string, part = 'full') => units.find((u) => u.tool === tool && u.path === path && u.part === part)?.mode;
    expect(mode('copilot', '~/.copilot/copilot-instructions.md')).toBe('always');
    expect(mode('copilot', '~/.copilot/instructions/style.instructions.md')).toBe('on-demand');
    expect(mode('copilot', '~/.copilot/skills/triage/SKILL.md', 'description')).toBe('always');
    expect(mode('zed', '~/.config/zed/AGENTS.md')).toBe('always');
    expect(mode('goose', '~/.config/goose/AGENTS.md')).toBe('always');
    expect(mode('junie', '~/.junie/AGENTS.md')).toBe('always');
    expect(mode('amp', '~/.config/amp/skills/deploy/SKILL.md', 'description')).toBe('always');
    expect(units.filter((u) => u.path === '~/.config/zed/AGENTS.md').map((u) => u.tool)).toEqual(['zed']);
  });

  it('checks the Windsurf global rules file against its own 6,000-character limit', async () => {
    const big = 'Prefer small, focused functions with clear names.\n'.repeat(140);
    expect(big.length).toBeGreaterThan(6000);
    expect(big.length).toBeLessThan(12000);
    const userFiles = [{ path: '~/.codeium/windsurf/memories/global_rules.md', text: big }];
    const report = await audit([], { tools: ['windsurf'], models: [], userFiles });
    expect(report.files.find((f) => f.path === userFiles[0]!.path)).toMatchObject({ mode: 'always', scope: 'user' });
    const limit = report.advice.find((a) => a.kind === 'size-limit')!;
    expect(limit.paths).toEqual([userFiles[0]!.path]);
    expect(limit.message).toMatch(/\(limit 6000\)\. Windsurf limits the global rules file to 6,000 characters\./);
    // A workspace .windsurfrules of the same size is within its 12,000-character limit.
    const repo = await audit([{ path: '.windsurfrules', text: big }], { tools: ['windsurf'], models: [] });
    expect(repo.advice.some((a) => a.kind === 'size-limit')).toBe(false);
  });
});
