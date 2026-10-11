import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { fixture, homeFixture } from './helpers.js';

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
    expect(report.mcp.map((m: { name: string }) => m.name)).toEqual(['personal']);
    io = capture();
    await main([fixture('agents-only'), '--badge'], { HOME: home });
    const badge = io.out();
    io = capture();
    await main([fixture('agents-only'), '--badge', '--include-user'], { HOME: home });
    expect(io.out()).toBe(badge);
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
