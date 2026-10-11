import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { audit } from '../src/core/audit.js';
import { parseCodexToml, parseJsonc, parseMcpConfigs, toolDefinitionsText, type McpServer } from '../src/core/mcp.js';
import { MODELS } from '../src/core/prices.js';
import { renderMarkdown, renderText } from '../src/core/render.js';
import { countO200k } from '../src/core/tokenize.js';
import { discoverMcpConfigs } from '../src/node/discover.js';
import { cmdQuote, expandVars, measureServer, sseMessages } from '../src/node/mcp.js';
import { mcpFixture } from './helpers.js';

const MCP = mcpFixture();

const gpt = MODELS.filter((m) => m.id === 'gpt-6.1-sol');

describe('MCP config parsing', () => {
  it('reads every agent config shape', () => {
    const { servers, problems } = parseMcpConfigs([
      { path: '.mcp.json', text: '{"mcpServers":{"a":{"command":"npx","args":["-y","pkg"],"env":{"K":"1"}},"r":{"type":"http","url":"https://x/mcp"}}}' },
      { path: '.gemini/settings.json', text: '{"mcpServers":{"s":{"url":"https://x/sse"},"h":{"httpUrl":"https://x/mcp"}}}' },
      { path: 'opencode.json', text: '{"mcp":{"l":{"type":"local","command":["bun","x"],"environment":{"A":"b"},"enabled":false},"rem":{"type":"remote","url":"https://y"}}}' },
      { path: '.zed/settings.json', text: '{"context_servers":{"old":{"command":{"path":"z","args":["1"]}},"new":{"command":"n","args":[]}}}' },
      { path: '.codex/config.toml', text: '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n\n[mcp_servers.docs.env]\nTOKEN = "x"\n\n[other]\nkey = 1\n' },
      { path: '.cursor/mcp.json', text: '{ broken' },
      { path: 'README.md', text: 'not a config' },
    ]);
    const by = (name: string) => servers.find((s) => s.name === name)!;
    expect(by('a')).toMatchObject({ tool: 'claude-code', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: '1' }, scope: 'project' });
    expect(by('r')).toMatchObject({ transport: 'http', url: 'https://x/mcp' });
    expect(by('s').transport).toBe('sse');
    expect(by('h').transport).toBe('http');
    expect(by('l')).toMatchObject({ tool: 'opencode', command: 'bun', args: ['x'], env: { A: 'b' }, disabled: true });
    expect(by('rem')).toMatchObject({ transport: 'http', url: 'https://y' });
    expect(by('old')).toMatchObject({ tool: 'zed', command: 'z', args: ['1'] });
    expect(by('new').command).toBe('n');
    expect(by('docs')).toMatchObject({ tool: 'codex', command: 'npx', args: ['-y', 'docs-mcp'], env: { TOKEN: 'x' } });
    expect(problems.map((p) => p.path)).toEqual(['.cursor/mcp.json']);
  });

  it('reads user and per-project servers from ~/.claude.json', () => {
    const text = JSON.stringify({ mcpServers: { u: { command: 'u' } }, projects: { 'C:\\Repo\\App': { mcpServers: { p: { command: 'p' } } }, '/other': { mcpServers: { o: { command: 'o' } } } } });
    const { servers } = parseMcpConfigs([{ path: '~/.claude.json', text }], 'c:/repo/app/');
    expect(servers.map((s) => [s.name, s.scope, s.configPath])).toEqual([
      ['u', 'user', '~/.claude.json'],
      ['p', 'user', '~/.claude.json'],
    ]);
  });

  it('parses JSON with comments and trailing commas, keeping // inside strings', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}')).toEqual({ a: 'http://x', b: [1, 2] });
  });

  it('reads Codex TOML inline tables and http_headers', () => {
    const t = parseCodexToml('[mcp_servers."my-srv"]\nurl = "https://x"\nhttp_headers = { Authorization = "Bearer y" }\n');
    expect(t['my-srv']).toMatchObject({ url: 'https://x', headers: { Authorization: 'Bearer y' } });
  });
});

describe('MCP measurement', () => {
  const closers: Array<() => void> = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));

  it('lists every page of tools from a stdio server, skipping non-JSON output', async () => {
    const server = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'docs')!;
    const r = await measureServer(server, { root: MCP, timeoutMs: 10_000 });
    expect(r.error).toBeUndefined();
    expect(r.tools!.map((t) => t.name)).toEqual(['search_docs', 'open_ticket']);
  });

  it('reports a server that exits as failed', async () => {
    const server = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'broken')!;
    const r = await measureServer(server, { root: MCP, timeoutMs: 10_000 });
    expect(r.error).toMatch(/exited with code 3/);
  });

  it('times out a server that never answers', async () => {
    const server: McpServer = { name: 'slow', tool: 'claude-code', configPath: '.mcp.json', scope: 'project', transport: 'stdio', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], disabled: false };
    const r = await measureServer(server, { root: MCP, timeoutMs: 300 });
    expect(r.error).toMatch(/no answer within/);
  });

  it('speaks streamable HTTP with SSE responses and a session id', async () => {
    const seen: Array<{ method: string; session?: string; auth?: string }> = [];
    const http = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        seen.push({ method: msg.method, session: req.headers['mcp-session-id'] as string | undefined, auth: req.headers.authorization });
        if (msg.id === undefined) return void res.writeHead(202).end();
        const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: [{ name: 'remote_tool', description: 'd', inputSchema: { type: 'object' } }] };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    closers.push(() => http.close());
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const server: McpServer = { name: 'h', tool: 'cursor', configPath: '.cursor/mcp.json', scope: 'project', transport: 'http', url, headers: { Authorization: 'Bearer ${API_TOKEN}' }, disabled: false };
    const r = await measureServer(server, { root: '.', timeoutMs: 5000, env: { API_TOKEN: 'secret' } });
    expect(r.tools!.map((t) => t.name)).toEqual(['remote_tool']);
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(seen[2]).toMatchObject({ session: 'sess-1', auth: 'Bearer secret' });
  });

  it('does not start a server that needs a VS Code input', async () => {
    const server = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'remote')!;
    expect((await measureServer(server, { root: '.', timeoutMs: 1000 })).error).toMatch(/\$\{input:/);
  });

  it('expands environment variables', () => {
    expect(expandVars('${A}-${B:-dflt}-${env:A}', { A: 'x' })).toBe('x-dflt-x');
    expect(sseMessages('data: {"id":1}\n\n: ping\n\ndata: nope\n\n')).toEqual([{ id: 1 }]);
  });

  it('quotes arguments for cmd.exe on Windows', () => {
    expect(cmdQuote('server.mjs')).toBe('server.mjs');
    expect(cmdQuote('setInterval(() => {}, 1000)')).toBe('"setInterval(() => {}, 1000)"');
    expect(cmdQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(cmdQuote('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
  });
});

describe('MCP in the audit', () => {
  const servers = () => parseMcpConfigs(discoverMcpConfigs(MCP)).servers;
  const files = [{ path: 'AGENTS.md', text: 'Run `npm test` before every commit.' }];

  it('lists configured servers as not measured without --mcp, and adds their agents', async () => {
    const report = await audit(files, { models: gpt, mcp: { servers: servers() } });
    expect(report.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(['claude-code', 'cursor', 'copilot']));
    const cursor = report.tools.find((t) => t.tool === 'cursor')!;
    expect(cursor).toMatchObject({ mcpServers: 1, mcpPerTurnO200k: 0, mcpMeasured: false });
    expect(report.mcp.find((m) => m.name === 'off')!.status).toBe('disabled');
    const text = renderText(report);
    expect(text).toContain('MCP servers');
    expect(text).toContain('run with --mcp');
    expect(renderMarkdown(report)).toContain('## MCP servers');
  });

  it('adds measured tool definitions to the total, names only for Claude Code', async () => {
    const tools = [{ name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object' } }];
    const full = countO200k(toolDefinitionsText(tools));
    const names = countO200k('search_docs');
    const key = (s: McpServer) => JSON.stringify(['stdio', s.command ?? '', s.args ?? [], s.url ?? '', s.cwd ?? '']);
    const docs = servers().find((s) => s.name === 'docs')!;
    const measured = new Map([[key(docs), { tools: 1, o200k: full, namesO200k: names }]]);
    const report = await audit(files, { tools: ['cursor', 'claude-code'], models: gpt, mcp: { servers: servers(), measured } });
    const cursor = report.tools.find((t) => t.tool === 'cursor')!;
    expect(cursor.mcpPerTurnO200k).toBe(full);
    expect(cursor.mcpMeasured).toBe(true);
    expect(cursor.totalPerTurnO200k).toBe(cursor.perTurnO200k + full);
    const claudeRow = report.mcp.find((m) => m.tool === 'claude-code' && m.name === 'docs')!;
    expect(claudeRow).toMatchObject({ status: 'measured', o200k: names, deferredO200k: full });
    expect(report.tools.find((t) => t.tool === 'claude-code')!.mcpMeasured).toBe(false); // "broken" is not measured
    expect(renderText(report)).toContain('names only');
  });
});
