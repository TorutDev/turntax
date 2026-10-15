import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { MODELS } from '../src/core/prices.js';
import { CONFIG_FILE, loadConfig } from '../src/node/config.js';
import { WORKFLOW_FILE } from '../src/node/init.js';
import { materialize } from './helpers.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

/** test/fixtures/mixed as the root of a git repository. */
const repo = () => materialize('mixed', { '.git/HEAD': 'ref: refs/heads/main\n' });
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('init', () => {
  it('writes the workflow and a config with the agents a default report covers', async () => {
    const dir = repo();
    let io = capture();
    expect(await main([dir, '--json'], {})).toBe(0);
    const reported = JSON.parse(io.out()).tools.map((t: { tool: string }) => t.tool);
    io = capture();
    expect(await main(['init', dir], {})).toBe(0);
    expect(io.err()).toBe('');
    expect(io.out()).toContain(`created ${WORKFLOW_FILE}\n`);
    expect(io.out()).toContain(`created ${CONFIG_FILE} (tools: ${reported.join(', ')})\n`);
    expect(io.out()).toContain(`Commit ${WORKFLOW_FILE} and ${CONFIG_FILE}.`);
    expect(io.out()).toContain('npx turntax');
    expect(io.out()).toContain('--fix');

    expect(reported.length).toBeGreaterThan(1);
    expect(loadConfig(dir, undefined, MODELS)).toEqual({ tools: reported });

    const yml = read(dir, WORKFLOW_FILE);
    const lines = yml.split('\n');
    for (const line of [
      'on: pull_request',
      'permissions:',
      '  contents: read',
      '  pull-requests: write',
      '      - uses: actions/checkout@v4',
      `      - uses: TorutDev/turntax@v${VERSION}`,
      '        with:',
    ])
      expect(lines).toContain(line);
    expect(yml).toMatch(/^ {10}max-increase: 500 +# /m);
    expect(yml).not.toContain('\t');
    // Every input the workflow sets, or shows commented out, exists in action.yml.
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const inputs = action.split('\ninputs:\n')[1]!.split('\noutputs:')[0]!;
    const known = [...inputs.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
    const used = [...yml.split('with:\n')[1]!.matchAll(/^ +(?:# )?([\w-]+):/gm)].map((m) => m[1]);
    expect(used).toEqual(['max-increase', 'max-tokens', 'annotations']);
    for (const key of used) expect(known).toContain(key);
  });

  it('keeps existing files unless --force', async () => {
    const dir = repo();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_FILE), 'name: mine\n');
    writeFileSync(join(dir, CONFIG_FILE), '{ "turns": 50 }\n');
    let io = capture();
    expect(await main(['init', dir], {})).toBe(0);
    expect(io.out()).toContain(`skipped ${WORKFLOW_FILE} (exists; --force overwrites it)`);
    expect(io.out()).toContain(`skipped ${CONFIG_FILE} (exists; --force overwrites it)`);
    expect(io.out()).not.toContain('Next steps');
    expect(read(dir, WORKFLOW_FILE)).toBe('name: mine\n');
    expect(read(dir, CONFIG_FILE)).toBe('{ "turns": 50 }\n');

    rmSync(join(dir, CONFIG_FILE));
    io = capture();
    expect(await main(['init', dir], {})).toBe(0);
    expect(io.out()).toContain(`skipped ${WORKFLOW_FILE}`);
    expect(io.out()).toContain(`created ${CONFIG_FILE}`);
    expect(io.out()).toContain(`Commit ${CONFIG_FILE}.`);

    io = capture();
    expect(await main(['init', dir, '--force', '--tools', 'cursor'], {})).toBe(0);
    expect(io.out()).toContain(`overwritten ${WORKFLOW_FILE}`);
    expect(io.out()).toContain(`overwritten ${CONFIG_FILE} (tools: cursor)`);
    expect(read(dir, WORKFLOW_FILE)).toContain(`TorutDev/turntax@v${VERSION}`);
    expect(loadConfig(dir, undefined, MODELS)).toEqual({ tools: ['cursor'] });
  });

  it('prints the files without writing them with --dry-run', async () => {
    const dir = repo();
    const io = capture();
    expect(await main(['init', dir, '--dry-run', '--max-increase', '0', '--tools', 'cursor, claude-code,cursor'], {})).toBe(0);
    expect(existsSync(join(dir, WORKFLOW_FILE))).toBe(false);
    expect(existsSync(join(dir, CONFIG_FILE))).toBe(false);
    expect(io.out()).toContain(`would create ${WORKFLOW_FILE}:\n\nname: turntax\n`);
    expect(io.out()).toMatch(/^ {10}max-increase: 0 +# /m);
    expect(io.out()).toContain(`would create ${CONFIG_FILE} (tools: claude-code, cursor):\n\n{\n  "tools": [\n    "claude-code",\n    "cursor"\n  ]\n}\n`);
    expect(io.out()).toContain('Dry run: nothing was written.');
    expect(io.out()).not.toContain('Next steps');
  });

  it('writes a config without tools when no agent reads anything, and warns without .git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-init-empty-'));
    const io = capture();
    expect(await main(['init', dir], {})).toBe(0);
    expect(io.err()).toMatch(/has no \.git/);
    expect(io.out()).toContain('no agent reads files here yet');
    expect(read(dir, CONFIG_FILE)).toBe('{}\n');
    expect(loadConfig(dir, undefined, MODELS)).toEqual({});
  });

  it('lists agents that only have an enabled MCP server, as a default report does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turntax-init-mcp-'));
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.mcp.json'), '{ "mcpServers": { "docs": { "command": "node" } } }\n');
    writeFileSync(join(dir, '.cursor/mcp.json'), '{ "mcpServers": { "off": { "command": "node", "disabled": true } } }\n');
    capture();
    expect(await main(['init', dir], {})).toBe(0);
    expect(loadConfig(dir, undefined, MODELS)).toEqual({ tools: ['claude-code'] });
  });

  it('exits with code 2 on usage errors and writes nothing', async () => {
    const dir = repo();
    const io = capture();
    expect(await main(['init', dir, '--tools', 'vim'], {})).toBe(2);
    expect(io.err()).toMatch(/Unknown tool "vim"/);
    expect(await main(['init', dir, '--tools', ' , '], {})).toBe(2);
    expect(await main(['init', dir, '--max-increase', '-1'], {})).toBe(2);
    expect(await main(['init', dir, '--max-increase', 'ten'], {})).toBe(2);
    expect(await main(['init', dir, '--nope'], {})).toBe(2);
    expect(await main(['init', dir, dir], {})).toBe(2);
    expect(await main(['init', join(dir, 'missing')], {})).toBe(2);
    expect(await main(['init', join(dir, 'AGENTS.md')], {})).toBe(2);
    expect(io.err()).toMatch(/is not a folder/);
    expect(existsSync(join(dir, WORKFLOW_FILE))).toBe(false);
    expect(existsSync(join(dir, CONFIG_FILE))).toBe(false);
  });

  it('writes nothing through a linked folder', async () => {
    const dir = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), 'turntax-init-elsewhere-'));
    symlinkSync(elsewhere, join(dir, '.github/workflows'), 'junction');
    const io = capture();
    expect(await main(['init', dir], {})).toBe(1);
    expect(io.err()).toMatch(/outside/);
    expect(existsSync(join(elsewhere, 'turntax.yml'))).toBe(false);
    expect(existsSync(join(dir, CONFIG_FILE))).toBe(false);
  });

  it('documents itself', async () => {
    const io = capture();
    expect(await main(['init', '--help'], {})).toBe(0);
    expect(io.out()).toMatch(/^Usage: turntax init \[path\]/);
    for (const flag of ['--tools', '--max-increase', '--force', '--dry-run']) expect(io.out()).toContain(flag);
  });
});
