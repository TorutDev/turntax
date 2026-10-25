import { describe, expect, it } from 'vitest';
import type { Report } from '../src/core/audit.js';
import type { FixPlan } from '../src/core/fix.js';
import { groupTools, headlineTokens, renderMarkdown } from '../src/core/render.js';
import type { ToolId } from '../src/core/types.js';
import { auditWorkspace, planWorkspaceFixes } from '../src/node/workspace.js';
import { auditFolder, diagnosticsFrom, reportMarkdown, statusView } from '../vscode/src/engine.js';
import { affectsAudit, codeLensView, diffTitle, fixSummary, isFixable, nothingToFix, samePlan, type LensRow } from '../vscode/src/view.js';
import { fixture, materialize } from './helpers.js';

const mixed = await auditWorkspace(fixture('mixed'));
const mixedView = await auditFolder(fixture('mixed'));
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
    for (const path of ['CLAUDE.md', 'packages/web/AGENTS.md', '.cursor/rules/new.mdc', '.mcp.json', '.cursor/mcp.json', 'turntax.config.json', 'package.json', 'docs/extra.md', 'docs'])
      expect(affectsAudit(path, known), path).toBe(true);
    for (const path of ['src/index.ts', 'README.md', 'node_modules/pkg/CLAUDE.md', '.claude/worktrees/agent-1/CLAUDE.md', 'packages/api/turntax.config.json'])
      expect(affectsAudit(path, known), path).toBe(false);
  });
});

describe('VS Code report', () => {
  it('leaves out the remote badge, so the preview fetches nothing', () => {
    expect(renderMarkdown(mixed.report)).toContain('https://img.shields.io/');
    const md = reportMarkdown(mixed.report);
    expect(md).not.toMatch(/!\[[^\]]*\]\(https?:/);
    expect(md).toBe(renderMarkdown(mixed.report).replace(/\n\[!\[context tax[^\n]*\n$/, ''));
  });

  it('keeps repository text from adding images or HTML', () => {
    const quoted = 'Section "Release ![x](https://example.invalid/p.png) <img src=https://example.invalid/q.png>" loads every turn.';
    const report = { ...mixed.report, advice: [{ ...mixed.report.advice[0]!, message: quoted }] };
    const md = reportMarkdown(report);
    expect(md).toContain('Release !\\[x](https://example.invalid/p.png) &lt;img src=');
    expect(md).not.toMatch(/!\[[^\]]*\]\(https?:|<img/);
  });
});

describe('VS Code fix preview', () => {
  it('applies only a plan that is still the same, and says why nothing was fixed', async () => {
    const plan = await planWorkspaceFixes(fixture('mixed'));
    expect(samePlan(plan, await planWorkspaceFixes(fixture('mixed')))).toBe(true);
    const changed = { ...plan, changes: plan.changes.map((c) => ({ ...c, before: c.before + 'edited' })) };
    expect(samePlan(plan, changed)).toBe(false);
    expect(nothingToFix({ fixes: [], skipped: [], changes: [] })).toBe('Nothing to fix automatically.');
    const skipped = { kind: 'duplicate' as const, paths: ['AGENTS.md'], reason: 'AGENTS.md is a symlink.' };
    expect(nothingToFix({ fixes: [], skipped: [skipped], changes: [] })).toBe('Nothing to fix automatically. Skipped: AGENTS.md is a symlink.');
    expect(nothingToFix({ fixes: [], skipped: [skipped, skipped], changes: [] })).toMatch(/symlink\. \(\+1 more; run npx turntax --fix for all\)$/);
  });

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

describe('VS Code worker', () => {
  it('sends what the extension shows as plain data, without the per-model counts', async () => {
    expect(structuredClone(mixedView)).toEqual(mixedView);
    expect(mixedView).toMatchObject({
      agents: mixed.report.tools.length,
      status: statusView(mixed.report),
      diagnostics: diagnosticsFrom(mixed),
      markdown: reportMarkdown(mixed.report),
      ignore: [],
    });
    expect(mixedView.files).toHaveLength(mixed.report.files.length);
    expect(mixedView.files).toContainEqual({ tool: 'claude-code', path: 'docs/extra.md', part: 'full', mode: 'always', o200k: 42, importedFrom: 'CLAUDE.md' });
    expect(mixedView.files.every((f) => Object.keys(f).every((k) => ['tool', 'path', 'part', 'mode', 'o200k', 'importedFrom'].includes(k)))).toBe(true);
    const ignoring = await auditFolder(materialize('mixed', { 'turntax.config.json': JSON.stringify({ ignore: ['packages/**'] }) }));
    expect(ignoring.ignore).toEqual(['packages/**']);
    expect(ignoring.files.some((f) => f.path.startsWith('packages/'))).toBe(false);
  });
});

describe('VS Code CodeLens', () => {
  const lens = (path: string) => codeLensView(path, mixedView);
  const row = (tool: ToolId, mode: LensRow['mode'], o200k: number, part: LensRow['part'] = 'full'): LensRow => ({ tool, path: 'AGENTS.md', part, mode, o200k });

  it('counts the agents that load a file every turn, with the largest count, and lists them per mode', () => {
    expect(lens('CLAUDE.md')).toEqual({
      title: 'turntax: 219 tokens every turn in 6 agents · not read by 4',
      tooltip: [
        'Every turn: Cursor, GitHub Copilot, Factory Droid, Augment Code, Devin Local / Devin CLI (219 tokens); Claude Code (203 tokens)',
        'Not read: Zed, Amp, OpenCode, Kilo Code',
        'Counts are o200k_base estimates, made offline.',
      ].join('\n'),
    });
    expect(lens('packages/api/CLAUDE.md')?.title).toBe('turntax: on demand in 6 agents · not read by 1');
    expect(lens('.cursor/rules/wrong.md')?.title).toBe('turntax: when referenced in 1 agent · not read by 1');
  });

  it('counts each agent once, under the strongest mode, and names parts and imports', () => {
    const skill = lens('.claude/skills/deploy/SKILL.md')!;
    expect(skill.title).toBe('turntax: 26 tokens every turn in 11 agents');
    const [always, onDemand] = skill.tooltip.split('\n');
    expect(always).toMatch(/^Every turn: Warp \(26 tokens, description\); Claude Code, Cursor, [^;]+ \(14 tokens, description\)$/);
    expect(onDemand).toMatch(/^On demand: Claude Code, [^;]*Warp[^;]* \(22 tokens, body\)$/);
    expect(lens('docs/extra.md')?.tooltip.split('\n')[0]).toBe('Every turn: Claude Code (42 tokens, imported by CLAUDE.md)');

    const rows = [
      row('codex', 'ignored', 5),
      row('cursor', 'manual', 5),
      row('copilot', 'on-demand', 7),
      row('cline', 'always', 100),
      row('kiro', 'always', 272),
      // Kiro reads a part, so it is not listed as not reading the file.
      row('kiro', 'ignored', 9, 'body'),
      row('zed', 'ignored', 5),
    ];
    expect(codeLensView('AGENTS.md', { files: rows, ignore: [] })).toEqual({
      title: 'turntax: 272 tokens every turn in 2 agents · on demand in 1 · when referenced in 1 · not read by 2',
      tooltip: [
        'Every turn: Kiro (272 tokens); Cline (100 tokens)',
        'On demand: GitHub Copilot (7 tokens)',
        'When referenced: Cursor (5 tokens)',
        'Not read: OpenAI Codex, Zed',
        'Counts are o200k_base estimates, made offline.',
      ].join('\n'),
    });
  });

  it('says when no agent reads an instruction file, or when the config leaves it out', () => {
    expect(codeLensView('AGENTS.md', { files: [row('zed', 'ignored', 17), row('amp', 'ignored', 17)], ignore: [] })).toEqual({
      title: 'turntax: no agent reads this file',
      tooltip: 'Not read: Zed, Amp',
    });
    expect(lens('.claude/rules/new.md')).toEqual({ title: 'turntax: no agent reads this file', tooltip: 'No agent in the report reads this file.' });
    expect(codeLensView('packages/web/AGENTS.md', { files: [], ignore: ['packages/**'] })?.title).toBe('turntax: left out by turntax.config.json');
  });

  it('has no lens on other files', () => {
    for (const path of ['src/index.ts', 'README.md', 'node_modules/pkg/CLAUDE.md', '.claude/worktrees/agent-1/CLAUDE.md']) expect(lens(path), path).toBeUndefined();
  });
});
