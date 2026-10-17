import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { MODELS } from '../src/core/prices.js';
import { fixture, homeFixture, materialize } from './helpers.js';

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('prints JSON for a fixture without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const io = capture();
    const code = await main([fixture('mixed'), '--json'], {});
    expect(code).toBe(0);
    const report = JSON.parse(io.out());
    expect(report.tools.map((t: { tool: string }) => t.tool)).toContain('claude-code');
    expect(report.advice.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses API counting without a key', async () => {
    const io = capture();
    expect(await main([fixture('mixed'), '--claude-api'], {})).toBe(2);
    expect(io.err()).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('rejects unknown flags, tools and models with exit code 2', async () => {
    capture();
    expect(await main(['--nope'], {})).toBe(2);
    expect(await main([fixture('mixed'), '--tools', 'vim'], {})).toBe(2);
    expect(await main([fixture('mixed'), '--models', 'gpt-0'], {})).toBe(2);
  });

  it('fails the --max-tokens gate when the budget is exceeded', async () => {
    const io = capture();
    expect(await main([fixture('mixed'), '--badge', '--max-tokens', '10'], {})).toBe(1);
    expect(io.out()).toContain('img.shields.io');
    expect(io.err()).toMatch(/exceeds --max-tokens 10/);
  });

  it('counts user-level files only with --include-user, never in the badge', async () => {
    const home = homeFixture();
    let io = capture();
    expect(await main([fixture('agents-only'), '--json'], { HOME: home })).toBe(0);
    expect(JSON.parse(io.out()).files.some((f: { scope?: string }) => f.scope === 'user')).toBe(false);
    io = capture();
    expect(await main([fixture('agents-only'), '--json', '--include-user'], { HOME: home })).toBe(0);
    const report = JSON.parse(io.out());
    const codex = report.tools.find((t: { tool: string }) => t.tool === 'codex');
    expect(codex.userPerTurnO200k).toBeGreaterThan(0);
    // One row per agent that reads ~/.claude.json (Claude Code, and Devin's import).
    expect([...new Set(report.mcp.map((m: { name: string }) => m.name))]).toEqual(['personal']);
    io = capture();
    await main([fixture('agents-only'), '--badge'], { HOME: home });
    const badge = io.out();
    io = capture();
    await main([fixture('agents-only'), '--badge', '--include-user'], { HOME: home });
    expect(io.out()).toBe(badge);
  });

  it('prints GitHub annotations with lines in the files on disk', async () => {
    const io = capture();
    expect(await main([fixture('mixed'), '--annotations', '--path-prefix', './web/'], {})).toBe(0);
    const lines = io.out().trimEnd().split('\n');
    expect(lines.every((l) => /^::(warning|notice) file=web\/[^,:]+(,line=\d+)?,title=turntax [a-z-]+::/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('::warning file=web/CLAUDE.md,line=12,title=turntax scopable-section::Section "API package"'))).toBe(true);
    expect(lines.some((l) => l.startsWith('::warning file=web/GEMINI.md,line=3,title=turntax stale-reference::'))).toBe(true);
  });

  it('rejects --annotations with other formats or --fix, and --path-prefix without it', async () => {
    const io = capture();
    for (const flag of ['--json', '--md', '--pr-comment', '--badge', '--fix']) expect(await main([fixture('mixed'), '--annotations', flag], {})).toBe(2);
    expect(io.err()).toMatch(/--annotations cannot be combined with --fix/);
    expect(await main([fixture('mixed'), '--path-prefix', 'web'], {})).toBe(2);
    expect(io.err()).toMatch(/--path-prefix needs --annotations/);
  });

  it('adds the safe fixes to --pr-comment with a matching --fix command', async () => {
    const io = capture();
    expect(await main([materialize('mixed', {}), '--pr-comment', '--tools', 'claude-code,cursor'], {})).toBe(0);
    expect(io.out()).toMatch(/\*\*3 safe fixes available\*\* \(saves ~\d+ o200k tokens\/turn\): run `npx turntax --tools claude-code,cursor --fix` to preview\./);
    expect(io.out()).toContain('rename to .cursor/rules/wrong.mdc');
  });

  it('warns once on stderr when prices were checked over 90 days ago', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-prices-'));
    const prices = join(dir, 'prices.json');
    const model = (id: string, checkedAt: string) => ({ ...MODELS.find((m) => m.id === 'gpt-6.1-sol')!, id, label: id.toUpperCase(), checkedAt });
    writeFileSync(prices, JSON.stringify([model('a', '2026-01-01'), model('b', '2026-01-01'), model('c', '2026-03-01')]));
    const run = async (args: string[], now: string) => {
      const io = capture();
      await main([fixture('agents-only'), '--prices', prices, '--models', 'a,b,c', ...args], {}, new Date(now));
      return io.err();
    };
    expect(await run([], '2026-04-01T23:00:00Z')).toBe('');
    const err = await run(['--json'], '2026-04-02T00:30:00Z');
    expect(err).toBe('turntax: prices for A, B were checked on 2026-01-01, over 90 days ago; check the sources or pass --prices.\n');
    expect(await run(['--list-models'], '2027-01-01T00:00:00Z')).toBe('');
    expect(await run(['--fix'], '2027-01-01T00:00:00Z')).not.toMatch(/prices/);
  });

  it('measures a language multiplier from --english', async () => {
    const io = capture();
    const en = `${fixture('turkish')}/CLAUDE.en.md`;
    expect(await main([fixture('turkish'), '--json', '--english', `CLAUDE.md=${en}`], {})).toBe(0);
    const report = JSON.parse(io.out());
    const a = report.advice.find((x: { kind: string }) => x.kind === 'non-english');
    expect(a.message).toMatch(/x\d\.\d\d/);
  });
});
