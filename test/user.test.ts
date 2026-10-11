import { describe, expect, it } from 'vitest';
import { audit } from '../src/core/audit.js';
import { MODELS } from '../src/core/prices.js';
import { renderText } from '../src/core/render.js';
import { classifyUser } from '../src/core/user.js';
import { discoverUser } from '../src/node/discover.js';
import { homeFixture } from './helpers.js';

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
    // OpenCode falls back to ~/.claude/CLAUDE.md because there is no ~/.config/opencode/AGENTS.md.
    expect(who('~/.claude/CLAUDE.md')).toEqual(['claude-code', 'opencode']);
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
});
