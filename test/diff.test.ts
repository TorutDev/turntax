import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { audit } from '../src/core/audit.js';
import { diffReports, maxIncrease } from '../src/core/diff.js';
import { PR_COMMENT_MARKER, renderDiffMarkdown, renderMarkdown, renderPrComment } from '../src/core/render.js';
import { countO200k } from '../src/core/tokenize.js';

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

const base = [{ path: 'AGENTS.md', text: 'Run the tests before every commit.' }];
const extra = 'Deploy with the release script and check the dashboard afterwards.';

describe('diff', () => {
  it('reports per-agent and per-file changes', async () => {
    const before = await audit(base, { tools: ['codex', 'cursor'], models: [] });
    const after = await audit([...base, { path: 'CLAUDE.md', text: extra }], { tools: ['codex', 'cursor'], models: [] });
    const diff = diffReports(before, after, 'main');
    expect(diff.tools.find((t) => t.tool === 'codex')!.delta).toBe(0);
    expect(diff.tools.find((t) => t.tool === 'cursor')!.delta).toBe(countO200k(extra));
    expect(diff.files).toEqual([{ path: 'CLAUDE.md', part: 'full', before: null, after: countO200k(extra), delta: countO200k(extra), tools: ['cursor'] }]);
    expect(maxIncrease(diff)).toBe(countO200k(extra));
    const md = renderDiffMarkdown(diff);
    expect(md).toContain('## Change vs `main`');
    expect(md).toContain(`| Cursor | ${before.tools[1]!.perTurnO200k} |`);
    after.diff = diff;
    expect(renderMarkdown(after).indexOf('## Change vs')).toBeLessThan(renderMarkdown(after).indexOf('## Per agent'));
    const comment = renderPrComment(after);
    expect(comment.startsWith(PR_COMMENT_MARKER + '\n## Change vs `main`')).toBe(true);
    expect(comment).toContain('<details><summary>Full report</summary>');
    expect(comment.match(/## Change vs/g)).toHaveLength(1);
  });

  it('compares with a saved --json report and gates on --max-increase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-'));
    writeFileSync(join(dir, 'AGENTS.md'), base[0]!.text);
    let io = capture();
    expect(await main([dir, '--json', '--out', join(dir, 'before.json')], {})).toBe(0);
    writeFileSync(join(dir, 'AGENTS.md'), base[0]!.text + '\n' + extra);
    io = capture();
    expect(await main([dir, '--baseline', join(dir, 'before.json'), '--max-increase', '5'], {})).toBe(1);
    expect(io.out()).toContain('Change vs before.json');
    expect(io.err()).toMatch(/grew by \d+ vs before\.json, more than --max-increase 5/);
    capture();
    expect(await main([dir, '--baseline', join(dir, 'before.json'), '--max-increase', '1000'], {})).toBe(0);
  });

  it('compares with a git ref without touching the working tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'empty');
    writeFileSync(join(dir, 'AGENTS.md'), base[0]!.text);
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{"old":{"command":"x"}}}');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'AGENTS.md'), base[0]!.text + '\n' + extra);
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{"new":{"command":"y"}}}');
    const io = capture();
    expect(await main([dir, '--compare', 'HEAD', '--json'], {})).toBe(0);
    const report = JSON.parse(io.out());
    expect(report.diff.base).toBe('HEAD');
    expect(report.diff.tools.find((t: { tool: string }) => t.tool === 'codex').delta).toBeGreaterThan(0);
    // Every agent that reads .mcp.json (Claude Code, Copilot CLI, ...) lists the change.
    expect(report.diff.mcp.added).toEqual(expect.arrayContaining(['new (claude-code)', 'new (copilot)']));
    expect(report.diff.mcp.removed).toEqual(expect.arrayContaining(['old (claude-code)', 'old (copilot)']));
    expect(report.diff.mcp.added.every((s: string) => s.startsWith('new ('))).toBe(true);
    expect(report.diff.mcp.removed.every((s: string) => s.startsWith('old ('))).toBe(true);
    capture();
    expect(await main([dir, '--compare', 'no-such-ref'], {})).toBe(2);
  });

  it('rejects --max-increase without a baseline', async () => {
    const io = capture();
    expect(await main(['.', '--max-increase', '1'], {})).toBe(2);
    expect(io.err()).toMatch(/needs --baseline or --compare/);
  });
});
