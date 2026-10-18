import { describe, expect, it } from 'vitest';
import type { Report } from '../src/core/audit.js';
import type { FixPlan } from '../src/core/fix.js';
import { groupTools, headlineTokens } from '../src/core/render.js';
import { auditWorkspace, planWorkspaceFixes } from '../src/node/workspace.js';
import { affectsAudit, diagnosticsFrom, diffTitle, fixSummary, isFixable, statusView } from '../vscode/src/view.js';
import { fixture, materialize } from './helpers.js';

const mixed = await auditWorkspace(fixture('mixed'));
const advice = (kind: string) => mixed.report.advice.find((a) => a.kind === kind)!;

describe('VS Code status bar', () => {
  it('shows the badge number and one tooltip line per agent group', () => {
    const view = statusView(mixed.report)!;
    expect(view.text).toBe(`$(dashboard) ${headlineTokens(mixed.report)} tok/turn`);
    const lines = view.tooltip.split('\n');
    expect(lines).toHaveLength(groupTools(mixed.report).length + 1);
    expect(lines).toContain('Claude Code: 272 tokens/turn');
    expect(lines.at(-1)).toBe('Counts are o200k_base estimates, made offline.');
  });

  it('formats thousands and names MCP servers that were not measured', () => {
    const tool = { ...mixed.report.tools[0]!, perTurnO200k: 1234, mcpServers: 2, mcpMeasured: false, mcpPerTurnO200k: 0 };
    const view = statusView({ ...mixed.report, tools: [tool] })!;
    expect(view.text).toBe('$(dashboard) 1,234 tok/turn');
    expect(view.tooltip.split('\n')[0]).toBe('Claude Code: 1,234 tokens/turn + 2 MCP servers not measured');
  });

  it('is hidden when no agent loads anything', () => {
    expect(statusView({ ...mixed.report, files: [], mcp: [], tools: [] })).toBeUndefined();
    const ignoredOnly: Report = { ...mixed.report, files: mixed.report.files.filter((f) => f.mode === 'ignored'), tools: [] };
    expect(ignoredOnly.files.length).toBeGreaterThan(0);
    expect(statusView(ignoredOnly)).toBeUndefined();
  });
});

describe('VS Code diagnostics', () => {
  it('places each advice item like the GitHub annotations, with its saving', () => {
    const diagnostics = diagnosticsFrom(mixed);
    expect(diagnostics).toHaveLength(mixed.report.advice.length);
    expect(diagnostics).toContainEqual({
      path: 'CLAUDE.md',
      line: 12,
      severity: 'warning',
      kind: 'scopable-section',
      message: `${advice('scopable-section').message} (saves ~128 tokens/turn)`,
    });
    // No line: the first line of the file.
    expect(diagnostics).toContainEqual({
      path: '.cursor/rules/wrong.md',
      line: 1,
      severity: 'warning',
      kind: 'misconfigured',
      message: 'Cursor ignores plain .md files in .cursor/rules; rename to .mdc.',
    });
  });

  it('uses information for low severity, skips user-level files and keeps the line for the first path only', () => {
    const report: Report = {
      ...mixed.report,
      advice: [
        { kind: 'stale-reference', severity: 'low', tools: [], paths: ['docs/a.md'], line: 3, message: 'Gone.', savingTokens: 1234 },
        { kind: 'duplicate', severity: 'high', tools: [], paths: ['~/.claude/CLAUDE.md', 'AGENTS.md'], line: 2, message: 'Twice.', savingTokens: 0 },
        { kind: 'non-english', severity: 'low', tools: [], paths: ['~/.codex/AGENTS.md'], message: 'User level.', savingTokens: null },
      ],
    };
    expect(diagnosticsFrom({ report, problems: [] })).toEqual([
      { path: 'docs/a.md', line: 3, severity: 'information', kind: 'stale-reference', message: 'Gone. (saves ~1,234 tokens/turn)' },
      { path: 'AGENTS.md', line: 1, severity: 'warning', kind: 'duplicate', message: 'Twice.' },
    ]);
  });

  it('marks MCP configs that could not be parsed', async () => {
    const broken = await auditWorkspace(materialize('mixed', { '.mcp.json': '{ "mcpServers": ' }));
    expect(diagnosticsFrom(broken)).toContainEqual({ path: '.mcp.json', line: 1, severity: 'warning', message: expect.stringMatching(/^could not be parsed: /) });
  });

  it('offers the fix preview only for advice that --fix handles', () => {
    expect(['duplicate', 'scopable-section', 'oversized-section', 'misconfigured'].every(isFixable)).toBe(true);
    expect(isFixable('stale-reference')).toBe(false);
    expect(isFixable('toString')).toBe(false);
    expect(isFixable(undefined)).toBe(false);
  });
});

describe('VS Code refresh', () => {
  it('reacts to instruction files, MCP configs, the config and files the last report read', () => {
    const known = mixed.report.files.map((f) => f.path);
    for (const path of ['CLAUDE.md', 'packages/web/AGENTS.md', '.cursor/rules/new.mdc', '.mcp.json', '.cursor/mcp.json', 'turntax.config.json', 'docs/extra.md', 'docs'])
      expect(affectsAudit(path, known), path).toBe(true);
    for (const path of ['src/index.ts', 'README.md', 'node_modules/pkg/CLAUDE.md', '.claude/worktrees/agent-1/CLAUDE.md', 'packages/api/turntax.config.json'])
      expect(affectsAudit(path, known), path).toBe(false);
  });
});

describe('VS Code fix preview', () => {
  it('plans the fixes as the MCP fix_preview does and summarises them', async () => {
    const plan = await planWorkspaceFixes(fixture('mixed'));
    expect(plan.changes.map((c) => [c.renamedFrom, c.path])).toEqual([['.cursor/rules/wrong.md', '.cursor/rules/wrong.mdc']]);
    expect(fixSummary(plan)).toBe('1 safe fix');
    const scoped = await planWorkspaceFixes(materialize('mixed', { 'turntax.config.json': JSON.stringify({ tools: ['claude-code', 'cursor'] }) }));
    expect(scoped.fixes.length).toBeGreaterThan(plan.fixes.length);
  });

  it('adds up the savings and titles each diff', () => {
    const fix = { kind: 'duplicate' as const, paths: ['AGENTS.md'], message: 'Removed lines.' };
    const plan: FixPlan = { fixes: [{ ...fix, savingTokens: 1200 }, { ...fix, savingTokens: 34 }, { ...fix, savingTokens: null }], skipped: [], changes: [] };
    expect(fixSummary(plan)).toBe('3 safe fixes (saves ~1,234 o200k tokens/turn)');
    expect(diffTitle({ path: 'AGENTS.md', before: 'a', after: 'b' })).toBe('AGENTS.md (turntax fix)');
    expect(diffTitle({ path: '.claude/skills/release/SKILL.md', before: null, after: 'b' })).toBe('.claude/skills/release/SKILL.md (new file, turntax fix)');
    expect(diffTitle({ path: 'x.mdc', before: 'a', after: 'a', renamedFrom: 'x.md' })).toBe('x.md → x.mdc (turntax fix)');
  });
});
