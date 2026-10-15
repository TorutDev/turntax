import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../src/core/prices.js';
import { TOOL_IDS } from '../src/core/tools.js';
import { handleLine, PROTOCOL_VERSIONS, runMcp, serve, type RpcResponse } from '../src/node/mcp-server.js';
import { fixture, materialize } from './helpers.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

afterEach(() => vi.restoreAllMocks());

let nextId = 1;
async function request(method: string, params?: unknown, cwd = fixture('mixed')): Promise<RpcResponse> {
  const response = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }), cwd);
  expect(response).toBeDefined();
  return response!;
}

async function call(name: string, args?: unknown, cwd?: string): Promise<{ text: string; isError?: boolean }> {
  const response = await request('tools/call', { name, arguments: args }, cwd);
  if (!('result' in response)) throw new Error(`protocol error: ${JSON.stringify(response)}`);
  const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return { text: result.content[0]!.text, isError: result.isError };
}

describe('turntax mcp', () => {
  it('answers initialize with the requested protocol version, or the latest it supports', async () => {
    const init = (protocolVersion: string) =>
      request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(await init('2025-06-18')).toMatchObject({
      jsonrpc: '2.0',
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'turntax', version: VERSION } },
    });
    expect(await init('2099-01-01')).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSIONS[0] } });
    expect(await request('ping')).toMatchObject({ result: {} });
  });

  it('lists two read-only tools with closed input schemas', async () => {
    const response = await request('tools/list');
    const tools = (response as { result: { tools: Array<Record<string, any>> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['audit', 'fix_preview']);
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.inputSchema.properties.tools.items.enum).toEqual(TOOL_IDS);
      expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    }
    expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['path', 'tools', 'models']);
    expect(tools[0]!.inputSchema.properties.models.items.enum).toEqual(MODELS.map((m) => m.id));
    expect(Object.keys(tools[1]!.inputSchema.properties)).toEqual(['path', 'tools']);
  });

  it('audits a folder like the CLI, relative to the server folder by default', async () => {
    const { text, isError } = await call('audit', {});
    expect(isError).toBeUndefined();
    expect(text).toContain(`turntax: per-turn context tax for ${fixture('mixed')}`);
    expect(text).toMatch(/^\d+ +\d+ .*Claude Code$/m);
    expect(text).toContain('MEDIUM scopable-section CLAUDE.md:12 [saves ~128 tokens/turn]');
    const one = await call('audit', { path: '.', tools: ['codex'], models: ['gpt-6.1-sol'] });
    expect(one.text).toMatch(/OpenAI Codex/);
    expect(one.text).not.toMatch(/Claude Code|Claude Sonnet|Gemini CLI/);
  });

  it('reads turntax.config.json in the audited folder, and arguments override it', async () => {
    const dir = materialize('mixed', { 'turntax.config.json': JSON.stringify({ tools: ['cursor'], ignore: ['.cursor/rules/'] }) });
    const { text } = await call('audit', { path: dir });
    expect(text).toMatch(/ Cursor$/m);
    expect(text).not.toMatch(/Claude Code|\.cursor\/rules/);
    expect((await call('audit', { path: dir, tools: ['codex'] })).text).toMatch(/OpenAI Codex/);
    const broken = materialize('mixed', { 'turntax.config.json': '{ "tool": ["codex"] }' });
    expect(await call('audit', { path: broken })).toEqual({ text: expect.stringMatching(/unknown key "tool"/), isError: true });
  });

  it('previews the safe fixes as a diff without changing any file', async () => {
    const dir = materialize('mixed', {});
    const before = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const { text, isError } = await call('fix_preview', { tools: ['claude-code', 'cursor'] }, dir);
    expect(isError).toBeUndefined();
    expect(text).toMatch(/^fix: Moved section "API package" from CLAUDE\.md to packages\/api\/CLAUDE\.md;.*\[saves ~\d+ tokens\/turn\]$/m);
    expect(text).toContain('diff --git a/.cursor/rules/wrong.md b/.cursor/rules/wrong.mdc\nsimilarity index 100%\nrename from');
    expect(text).toContain('Preview only; nothing was changed. To apply, run `npx turntax --tools claude-code,cursor --fix --write`');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, '.cursor/rules/wrong.md'))).toBe(true);
    expect(existsSync(join(dir, '.cursor/rules/wrong.mdc'))).toBe(false);
    expect((await call('fix_preview', {}, fixture('agents-only'))).text).toBe('Nothing to fix automatically.');
  });

  it('reports bad arguments as tool errors the agent can correct', async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['audit', { tools: ['vim'] }, /Unknown tool "vim"\. Use: claude-code, codex/],
      ['audit', { models: ['gpt-0'] }, /Unknown model "gpt-0"/],
      ['audit', { tools: [] }, /"tools" must be a non-empty array of tool ids/],
      ['audit', { tools: 'codex' }, /"tools" must be a non-empty array/],
      ['audit', { path: 'no-such-folder' }, /Folder not found: .*no-such-folder/],
      ['audit', { path: 'CLAUDE.md' }, /Not a folder: .*CLAUDE\.md/],
      ['audit', { path: 3 }, /"path" must be a non-empty string/],
      ['fix_preview', { models: ['gpt-6.1-sol'] }, /Unknown argument "models"\. Use: path, tools\./],
    ];
    for (const [name, args, message] of cases) expect(await call(name, args)).toEqual({ text: expect.stringMatching(message), isError: true });
  });

  it('answers protocol errors with JSON-RPC error codes', async () => {
    const cwd = fixture('mixed');
    expect(await request('resources/list')).toMatchObject({ error: { code: -32601, message: 'Method not found: resources/list' } });
    expect(await request('tools/call', { name: 'write_files' })).toMatchObject({ error: { code: -32602, message: 'Unknown tool: write_files' } });
    expect(await request('tools/call', { name: 'audit', arguments: [] })).toMatchObject({ error: { code: -32602 } });
    expect(await request('tools/list', 'x')).toMatchObject({ error: { code: -32602 } });
    expect(await handleLine('{"jsonrpc":"2.0","id":1,', cwd)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(await handleLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', cwd)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handleLine('{"id":7,"method":"ping"}', cwd)).toMatchObject({ id: 7, error: { code: -32600 } });
    expect(await handleLine('{"jsonrpc":"2.0","id":null,"method":"ping"}', cwd)).toMatchObject({ id: null, error: { code: -32600 } });
    // Notifications, responses and blank lines get no answer.
    expect(await handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', cwd)).toBeUndefined();
    expect(await handleLine('{"jsonrpc":"2.0","id":5,"result":{}}', cwd)).toBeUndefined();
    expect(await handleLine('  ', cwd)).toBeUndefined();
  });

  it('serves newline-delimited messages, keeps going after bad input and ends with its input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => (written += chunk));
    const done = serve(input, output, fixture('mixed'));
    input.write('not json\r\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":"a","method":"ping"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"audit","arguments":{"tools":["codex"]}}}\n');
    await done;
    const lines = written.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(lines[1]).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
    expect(lines[2].result.content[0].text).toMatch(/OpenAI Codex/);
  });

  it('prints how to register the server with --help and rejects unknown flags', async () => {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
    expect(await runMcp(['--help'], {})).toBe(0);
    expect(out).toContain('claude mcp add turntax -- npx -y turntax mcp');
    expect(out).toContain('"turntax": { "command": "npx", "args": ["-y", "turntax", "mcp"] }');
    expect(await runMcp(['--port', '3000'], {})).toBe(2);
    expect(err).toMatch(/Unknown option '--port'/);
  });
});
