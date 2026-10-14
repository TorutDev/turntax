import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { MODELS } from '../src/core/prices.js';
import { materialize } from './helpers.js';

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

const withConfig = (config: unknown) =>
  materialize('mixed', { 'turntax.config.json': typeof config === 'string' ? config : JSON.stringify(config) });

// A date when the built-in prices are fresh, so no stale-price notice is printed.
const NOW = new Date(`${MODELS.map((m) => m.checkedAt).sort().at(-1)}T12:00:00Z`);

async function json(args: string[]) {
  const io = capture();
  const code = await main([...args, '--json'], {}, NOW);
  return { code, report: code === 0 ? JSON.parse(io.out()) : undefined, err: io.err() };
}

describe('turntax.config.json', () => {
  it('prints nothing extra without a config', async () => {
    const { code, err } = await json([materialize('mixed', {})]);
    expect(code).toBe(0);
    expect(err).toBe('');
  });

  it('sets tools, models, turns and ignored files, and flags override them', async () => {
    const dir = withConfig({ tools: ['gemini-cli', 'cursor'], models: ['gpt-6-luna'], turns: 7, ignore: ['GEMINI.md', '.cursor/rules/'] });
    const { code, report, err } = await json([dir]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(report.tools.map((t: { tool: string }) => t.tool)).toEqual(['gemini-cli', 'cursor']);
    expect(report.models.map((m: { id: string }) => m.id)).toEqual(['gpt-6-luna']);
    expect(report.turns).toBe(7);
    const paths = report.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('GEMINI.md');
    expect(paths.some((p: string) => p.startsWith('.cursor/rules/'))).toBe(false);
    expect(paths).toContain('AGENTS.md');
    const flags = await json([dir, '--tools', 'codex', '--models', 'gpt-6.1-sol', '--turns', '9']);
    expect(flags.report.tools.map((t: { tool: string }) => t.tool)).toEqual(['codex']);
    expect(flags.report.models.map((m: { id: string }) => m.id)).toEqual(['gpt-6.1-sol']);
    expect(flags.report.turns).toBe(9);
  });

  it('applies sectionTokens and maxTokens, naming the config in the message', async () => {
    const dir = withConfig({ sectionTokens: 40, maxTokens: 10 });
    const io = capture();
    expect(await main([dir, '--json'], {})).toBe(1);
    expect(JSON.parse(io.out()).advice.some((a: { kind: string }) => a.kind === 'oversized-section')).toBe(true);
    expect(io.err()).toMatch(/exceeds maxTokens in turntax\.config\.json 10/);
    capture();
    expect(await main([dir, '--json', '--max-tokens', '100000'], {})).toBe(0);
  });

  it('reads another file with --config', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'turntax-config-')), 'custom.json');
    writeFileSync(file, JSON.stringify({ tools: ['codex'] }));
    const { report } = await json([materialize('mixed', {}), '--config', file]);
    expect(report.tools.map((t: { tool: string }) => t.tool)).toEqual(['codex']);
  });

  it('rejects invalid files with exit code 2, naming the file and key', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ tool: ['codex'] }, /turntax\.config\.json: unknown key "tool"/],
      [{ turns: '7' }, /turntax\.config\.json: "turns" must be a positive integer/],
      [{ maxIncrease: -1 }, /"maxIncrease" must be a non-negative integer/],
      [{ ignore: 'GEMINI.md' }, /"ignore" must be an array of non-empty strings/],
      [{ tools: [] }, /"tools" must not be empty/],
      [{ tools: ['vim'] }, /"tools" has unknown tool "vim"/],
      [{ models: ['gpt-0'] }, /"models" has unknown model "gpt-0"/],
      [['codex'], /turntax\.config\.json: expected a JSON object/],
      ['{ "tools": [', /Could not read config turntax\.config\.json/],
    ];
    for (const [config, message] of cases) {
      const io = capture();
      expect(await main([withConfig(config)], {})).toBe(2);
      expect(io.err()).toMatch(message);
    }
    const io = capture();
    expect(await main([materialize('mixed', {}), '--config', join(tmpdir(), 'turntax-no-such-config.json')], {})).toBe(2);
    expect(io.err()).toMatch(/Could not read config/);
  });

  it('applies maxIncrease only when a comparison runs', async () => {
    const dir = withConfig({ maxIncrease: 10 });
    let io = capture();
    expect(await main([dir], {})).toBe(0);
    io = capture();
    expect(await main([dir, '--annotations'], {})).toBe(0);
    expect(io.out()).toMatch(/^::warning /);
  });

  it('leaves ignored files alone in --fix', async () => {
    const dir = withConfig({ ignore: ['.cursor/rules/wrong.md', 'packages/api/CLAUDE.md'] });
    const io = capture();
    expect(await main([dir, '--fix'], {})).toBe(0);
    expect(io.out()).not.toContain('wrong.md');
    expect(io.out()).not.toContain('packages/api/CLAUDE.md');
    expect(io.err()).toContain(".cursor/rules/wrong.md is in the config's ignore list; it is left alone.");
  });

  it('reads a config saved with a byte order mark', async () => {
    const { code, report } = await json([withConfig('﻿' + JSON.stringify({ tools: ['cursor'] }))]);
    expect(code).toBe(0);
    expect(report.tools.map((t: { tool: string }) => t.tool)).toEqual(['cursor']);
  });

  it('keeps planning --fix with ignored files, which agents still read', async () => {
    // With CLAUDE.md out of view Claude Code would seem to read AGENTS.md instead, and the rule's copy of
    // the line would look redundant; in reality Claude Code reads CLAUDE.md and the rule only.
    const line = 'Run the full test suite before every commit you make here.';
    const dir = mkdtempSync(join(tmpdir(), 'turntax-ignore-'));
    mkdirSync(join(dir, '.claude/rules'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Guide\n\nKeep functions small and name them after what they return.\n');
    writeFileSync(join(dir, 'AGENTS.md'), `${line}\n`);
    writeFileSync(join(dir, '.claude/rules/style.md'), `${line}\n`);
    writeFileSync(join(dir, 'turntax.config.json'), JSON.stringify({ ignore: ['CLAUDE.md'] }));
    const io = capture();
    expect(await main([dir, '--fix'], {})).toBe(0);
    expect(io.out()).not.toContain('style.md');
  });

  it('drops ignored files from the --compare base too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-config-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(dir, 'AGENTS.md'), 'Run the tests before every commit.\n');
    writeFileSync(join(dir, 'GEMINI.md'), 'Deploy with the release script and check the dashboard afterwards.\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'GEMINI.md'), 'Deploy with the release script.\n'.repeat(20));
    writeFileSync(join(dir, 'turntax.config.json'), JSON.stringify({ ignore: ['GEMINI.md'] }));
    const { report } = await json([dir, '--compare', 'HEAD']);
    expect(report.diff.files).toEqual([]);
    expect(report.diff.tools.every((t: { delta: number }) => t.delta === 0)).toBe(true);
  });
});
