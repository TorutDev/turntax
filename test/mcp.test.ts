import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, type McpMeasurement } from '../src/core/audit.js';
import {
  INSTRUCTIONS_NOTE,
  filterTools,
  parseCodexToml,
  parseJsonc,
  parseMcpConfigs,
  serverKey,
  toolDefinitionsText,
  toolNamesText,
  type McpServer,
  type McpToolDef,
} from '../src/core/mcp.js';
import { MODELS } from '../src/core/prices.js';
import { renderMarkdown, renderText } from '../src/core/render.js';
import { countO200k } from '../src/core/tokenize.js';
import { discoverMcpConfigs, discoverUser } from '../src/node/discover.js';
import { cmdQuote, expandVars, measureServer, sseMessages } from '../src/node/mcp.js';
import { materialize, mcpFixture } from './helpers.js';

const MCP = mcpFixture();

const gpt = MODELS.filter((m) => m.id === 'gpt-6.1-sol');

/** The two tools and the instructions test/fixtures/mcp/server.mjs returns. */
const SEARCH: McpToolDef = { name: 'search_docs', description: 'Search the project documentation.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const TICKET: McpToolDef = {
  name: 'open_ticket',
  description: 'Open a ticket in the tracker.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
  _meta: { 'anthropic/alwaysLoad': true },
};
const INSTRUCTIONS = 'Search the docs before answering questions about the project. Open a ticket for every bug you find.';

const server = (over: Partial<McpServer>): McpServer => ({ name: 's', tool: 'claude-code', configPath: '.mcp.json', scope: 'project', transport: 'stdio', command: 'x', disabled: false, ...over });

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
    // Every agent that reads a file gets its servers: Copilot CLI and Devin read .mcp.json too, Kilo Code and Devin opencode.json.
    expect(servers.filter((s) => s.name === 'a').map((s) => s.tool)).toEqual(['claude-code', 'copilot', 'devin']);
    expect(servers.filter((s) => s.name === 'l').map((s) => s.tool)).toEqual(['opencode', 'kilo-code', 'devin']);
  });

  it('reads user and per-project servers from ~/.claude.json', () => {
    const text = JSON.stringify({ mcpServers: { u: { command: 'u' } }, projects: { 'C:\\Repo\\App': { mcpServers: { p: { command: 'p' } } }, '/other': { mcpServers: { o: { command: 'o' } } } } });
    const { servers } = parseMcpConfigs([{ path: '~/.claude.json', text }], 'c:/repo/app/');
    const of = (tool: string) => servers.filter((s) => s.tool === tool).map((s) => [s.name, s.scope, s.configPath]);
    expect(of('claude-code')).toEqual([
      ['u', 'user', '~/.claude.json'],
      ['p', 'user', '~/.claude.json'],
    ]);
    // Devin imports the Claude Code servers by default.
    expect(of('devin')).toEqual(of('claude-code'));
  });

  it('parses JSON with comments and trailing commas, keeping // inside strings', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}')).toEqual({ a: 'http://x', b: [1, 2] });
  });

  it('reads Codex TOML inline tables and http_headers', () => {
    const t = parseCodexToml('[mcp_servers."my-srv"]\nurl = "https://x"\nhttp_headers = { Authorization = "Bearer y" }\n');
    expect(t['my-srv']).toMatchObject({ url: 'https://x', headers: { Authorization: 'Bearer y' } });
  });

  it('reads Claude Code WebSocket servers as their own transport, and alwaysLoad either way', () => {
    const { servers } = parseMcpConfigs([
      {
        path: '.mcp.json',
        text: '{"mcpServers":{"ws":{"type":"ws","url":"wss://x/socket","headers":{"Authorization":"Bearer t"}},"up":{"command":"u","alwaysLoad":true},"down":{"command":"d","alwaysLoad":false},"auto":{"command":"a"}}}',
      },
    ]);
    const claude = (name: string) => servers.find((s) => s.tool === 'claude-code' && s.name === name)!;
    expect(claude('ws')).toMatchObject({ transport: 'ws', url: 'wss://x/socket', headers: { Authorization: 'Bearer t' } });
    expect(claude('up').alwaysLoad).toBe(true);
    expect(claude('down').alwaysLoad).toBe(false);
    expect('alwaysLoad' in claude('auto')).toBe(false);
  });

  it('reads Copilot CLI configs, including a bare server map in .github/mcp.json', () => {
    const { servers } = parseMcpConfigs([
      { path: '.mcp.json', text: '{"mcpServers":{"wrapped":{"type":"local","command":"w","tools":["*"]}}}' },
      { path: '.github/mcp.json', text: '{"bare":{"type":"local","command":"b","args":["1"],"tools":["one","two"]},"$schema":"x","servers":{"inputs":[]}}' },
      { path: '~/.copilot/mcp-config.json', text: '{"mcpServers":{"mine":{"type":"http","url":"https://m/mcp","tools":["*"]}}}' },
      { path: '.vscode/mcp.json', text: '{"servers":{"vs":{"command":"v"}}}' },
    ]);
    const copilot = servers.filter((s) => s.tool === 'copilot');
    expect(copilot.map((s) => [s.name, s.configPath, s.scope])).toEqual([
      ['wrapped', '.mcp.json', 'project'],
      ['bare', '.github/mcp.json', 'project'],
      ['mine', '~/.copilot/mcp-config.json', 'user'],
      ['vs', '.vscode/mcp.json', 'project'],
    ]);
    expect(copilot[1]).toMatchObject({ command: 'b', args: ['1'], includeTools: ['one', 'two'] });
    expect(copilot[3]!.note).toMatch(/Deprecated for Copilot/);
    // Claude Code reads .mcp.json only in its mcpServers form.
    expect(parseMcpConfigs([{ path: '.mcp.json', text: '{"bare":{"command":"b"}}' }]).servers.map((s) => s.tool)).toEqual(['copilot']);
  });

  it('keeps one definition per agent and server name: Claude Code prefers local, then project, then user', () => {
    const claudeJson = (local: boolean) =>
      JSON.stringify({ mcpServers: { same: { command: 'user' } }, projects: local ? { '/repo': { mcpServers: { same: { command: 'local' } } } } : {} });
    const parse = (local: boolean) =>
      parseMcpConfigs(
        [
          { path: '~/.claude.json', text: claudeJson(local) },
          { path: '.mcp.json', text: '{"mcpServers":{"same":{"command":"project"}}}' },
        ],
        '/repo',
      ).servers.filter((s) => s.tool === 'claude-code');
    const view = (servers: McpServer[]) => servers.map((s) => [s.command, s.overriddenBy ?? null, s.overrideAssumed ?? false]);
    // Project and user scope, in either file order: the project definition wins, as documented.
    expect(view(parse(false))).toEqual([
      ['user', '.mcp.json', false],
      ['project', null, false],
    ]);
    expect(view(parse(true))).toEqual([
      ['user', '~/.claude.json (local)', false],
      ['local', null, false],
      ['project', '~/.claude.json (local)', false],
    ]);
  });

  it('follows Copilot CLI precedence and marks undocumented precedence as assumed', () => {
    const { servers } = parseMcpConfigs([
      { path: '.vscode/mcp.json', text: '{"servers":{"same":{"command":"vscode"},"two":{"command":"vscode"}}}' },
      { path: '.github/mcp.json', text: '{"same":{"command":"github"}}' },
      { path: '.mcp.json', text: '{"mcpServers":{"same":{"command":"root"},"two":{"command":"root"}}}' },
    ]);
    const copilot = servers.filter((s) => s.tool === 'copilot').map((s) => [s.configPath, s.name, s.overriddenBy ?? null, s.overrideAssumed ?? false]);
    expect(copilot).toEqual([
      ['.vscode/mcp.json', 'same', '.mcp.json', true],
      ['.vscode/mcp.json', 'two', '.mcp.json', true],
      ['.github/mcp.json', 'same', '.mcp.json', false],
      ['.mcp.json', 'same', null, false],
      ['.mcp.json', 'two', null, false],
    ]);
    // Agents without documented precedence keep the first config in MCP_CONFIGS order (Devin: .mcp.json before .cursor/mcp.json).
    const devin = parseMcpConfigs([
      { path: '.cursor/mcp.json', text: '{"mcpServers":{"same":{"command":"c"}}}' },
      { path: '.mcp.json', text: '{"mcpServers":{"same":{"command":"m"}}}' },
    ]).servers.filter((s) => s.tool === 'devin');
    expect(devin.map((s) => [s.configPath, s.overriddenBy ?? null, s.overrideAssumed ?? false])).toEqual([
      ['.cursor/mcp.json', '.mcp.json', true],
      ['.mcp.json', null, false],
    ]);
  });

  it('prefers .kilo/ over the root Kilo config, kilo.json over legacy opencode.json, and project over user', () => {
    const same = (command: string) => JSON.stringify({ mcp: { same: { type: 'local', command: [command] } } });
    const kilo = (paths: string[]) =>
      parseMcpConfigs(paths.map((path) => ({ path, text: same(path) })))
        .servers.filter((s) => s.tool === 'kilo-code')
        .map((s) => [s.configPath, s.overriddenBy ?? null, s.overrideAssumed ?? false]);
    expect(kilo(['opencode.json', 'kilo.json', '.kilo/kilo.jsonc', '~/.config/kilo/kilo.json'])).toEqual([
      ['opencode.json', '.kilo/kilo.jsonc', false],
      ['kilo.json', '.kilo/kilo.jsonc', false],
      ['.kilo/kilo.jsonc', null, false],
      ['~/.config/kilo/kilo.json', '.kilo/kilo.jsonc', false],
    ]);
    // The order of the root files among themselves is not documented.
    expect(kilo(['opencode.jsonc', 'kilo.jsonc'])).toEqual([
      ['opencode.jsonc', 'kilo.jsonc', true],
      ['kilo.jsonc', null, false],
    ]);
  });

  it("prefers Devin's own configs, local first, over imported ones (assumed)", () => {
    const same = (command: string) => JSON.stringify({ mcpServers: { same: { command } } });
    const devin = parseMcpConfigs(
      ['.mcp.json', '.devin/mcp_config.json', '.devin/mcp_config.local.json', '~/.config/devin/mcp_config.json'].map((path) => ({ path, text: same(path) })),
    ).servers.filter((s) => s.tool === 'devin');
    expect(devin.map((s) => [s.configPath, s.overriddenBy ?? null, s.overrideAssumed ?? false])).toEqual([
      ['.mcp.json', '.devin/mcp_config.local.json', true],
      ['.devin/mcp_config.json', '.devin/mcp_config.local.json', true],
      ['.devin/mcp_config.local.json', null, false],
      ['~/.config/devin/mcp_config.json', '.devin/mcp_config.local.json', true],
    ]);
  });

  it("reads each agent's tool filters and keeps only the tools they allow", () => {
    const { servers } = parseMcpConfigs([
      { path: '.codex/config.toml', text: '[mcp_servers.c]\ncommand = "c"\nenabled_tools = ["one", "two"]\ndisabled_tools = ["two"]\n' },
      { path: '.gemini/settings.json', text: '{"mcpServers":{"g":{"command":"g","includeTools":["one","two"],"excludeTools":["two"]}}}' },
      { path: '.factory/mcp.json', text: '{"mcpServers":{"f":{"command":"f","enabledTools":[],"disabledTools":["three"]}}}' },
      { path: '.kiro/settings/mcp.json', text: '{"mcpServers":{"k":{"command":"k","disabledTools":["one"]}}}' },
      { path: '.roo/mcp.json', text: '{"mcpServers":{"r":{"command":"r","disabledTools":["one"]}}}' },
      { path: '~/.config/devin/mcp_config.json', text: '{"mcpServers":{"w":{"command":"w","disabledTools":["one"]}}}' },
      { path: '.mcp.json', text: '{"mcpServers":{"cl":{"command":"cl","disabledTools":["one"],"tools":["one"]}}}' },
    ]);
    const tools = ['one', 'two', 'three'].map((name) => ({ name }));
    const kept = (name: string, tool: string) => filterTools(servers.find((s) => s.name === name && s.tool === tool)!, tools).map((t) => t.name);
    expect(kept('c', 'codex')).toEqual(['one']);
    expect(kept('g', 'gemini-cli')).toEqual(['one']);
    // Factory: an empty allow list allows every tool.
    expect(kept('f', 'factory-droid')).toEqual(['one', 'two']);
    expect(kept('k', 'kiro')).toEqual(['two', 'three']);
    expect(kept('r', 'roo-code')).toEqual(['two', 'three']);
    expect(kept('w', 'windsurf')).toEqual(['two', 'three']);
    // The same entry is filtered only by the fields each agent documents.
    expect(kept('w', 'devin')).toEqual(['one', 'two', 'three']);
    expect(kept('cl', 'claude-code')).toEqual(['one', 'two', 'three']);
    expect(kept('cl', 'copilot')).toEqual(['one']);
  });

  it('gives Copilot no tools for an empty tools list and every tool for ["*"]', () => {
    const { servers } = parseMcpConfigs([
      { path: '.github/mcp.json', text: '{"mcpServers":{"none":{"command":"n","tools":[]},"all":{"command":"a","tools":["*"]},"unset":{"command":"u"}}}' },
    ]);
    const tools = ['one', 'two'].map((name) => ({ name }));
    const kept = (name: string) => filterTools(servers.find((s) => s.name === name)!, tools).map((t) => t.name);
    expect(kept('none')).toEqual([]);
    expect(kept('all')).toEqual(['one', 'two']);
    expect(kept('unset')).toEqual(['one', 'two']);
  });

  it('finds the MCP configs of Augment, Factory, Kilo Code, Devin and Warp', () => {
    const repo = materialize('mcp', {
      '.augment/settings.json': '{\n  // JSONC\n  "mcpServers": { "aug": { "type": "sse", "url": "https://a/sse" }, },\n}\n',
      '.augment/settings.local.json': '{ "mcpServers": { "mine": { "command": "m" } } }',
      '.factory/mcp.json': '{ "mcpServers": { "fac": { "type": "http", "url": "https://f/mcp", "headers": { "K": "${KEY}" }, "disabled": true } } }',
      'kilo.jsonc': '{ "mcp": { "kilo": { "type": "local", "command": ["k", "1"], "enabled": true } } }',
      '.kilo/kilo.json': '{ "mcp": { "kilo2": { "type": "remote", "url": "https://k/mcp" } } }',
      '.devin/mcp_config.json': '{ "mcpServers": { "dev": { "url": "https://d/sse", "transport": "sse" } } }',
      '.devin/mcp_config.local.json': '{ "mcpServers": { "devlocal": { "command": "d" } } }',
      '.warp/.mcp.json': '{ "mcpServers": { "warpproject": { "command": "w" } } }',
      '.trae/mcp.json': '{ "mcpServers": { "trae": { "command": "t" } } }',
    });
    const project = parseMcpConfigs(discoverMcpConfigs(repo)).servers;
    const by = (name: string) => project.filter((s) => s.name === name);
    expect(by('aug')).toMatchObject([{ tool: 'augment', transport: 'sse', url: 'https://a/sse', configPath: '.augment/settings.json' }]);
    expect(by('aug')[0]!.note).toMatch(/enableToolSearch/);
    expect(by('mine')).toMatchObject([{ tool: 'augment', command: 'm', configPath: '.augment/settings.local.json' }]);
    expect(by('fac')).toMatchObject([{ tool: 'factory-droid', transport: 'http', headers: { K: '${KEY}' }, disabled: true }]);
    expect(by('kilo')).toMatchObject([{ tool: 'kilo-code', command: 'k', args: ['1'], configPath: 'kilo.jsonc' }]);
    expect(by('kilo2')).toMatchObject([{ tool: 'kilo-code', transport: 'http', configPath: '.kilo/kilo.json' }]);
    expect(by('dev')).toMatchObject([{ tool: 'devin', transport: 'sse' }]);
    expect(by('devlocal')).toMatchObject([{ tool: 'devin', command: 'd' }]);
    // Warp never starts project servers by itself, and TRAE needs a switch with an undocumented default.
    expect(by('warpproject')).toEqual([]);
    expect(by('trae')).toEqual([]);

    const home = materialize('home', {
      '.warp/.mcp.json': '{ "mcpServers": { "warp": { "command": "node", "args": ["w.mjs"], "working_directory": "/srv/w" } } }',
      '.factory/mcp.json': '{ "mcpServers": { "facuser": { "command": "f" } } }',
      '.augment/settings.json': '{ "mcpServers": { "auguser": { "command": "a" } } }',
      '.config/kilo/kilo.json': '{ "mcp": { "kilouser": { "type": "local", "command": ["k"] } } }',
      '.config/devin/mcp_config.json': '{ "mcpServers": { "shared": { "command": "s" } } }',
      '.copilot/mcp-config.json': '{ "mcpServers": { "cop": { "command": "c", "tools": ["*"] } } }',
    });
    const user = parseMcpConfigs(discoverUser(home).mcpConfigs).servers;
    const tools = (name: string) => user.filter((s) => s.name === name).map((s) => s.tool);
    expect(user.find((s) => s.name === 'warp')).toMatchObject({ tool: 'warp', scope: 'user', cwd: '/srv/w', configPath: '~/.warp/.mcp.json' });
    expect(tools('facuser')).toEqual(['factory-droid']);
    expect(tools('auguser')).toEqual(['augment']);
    expect(tools('kilouser')).toEqual(['kilo-code']);
    // Windsurf's legacy Cascade agent and Devin Local share ~/.config/devin/mcp_config.json.
    expect(tools('shared')).toEqual(['windsurf', 'devin']);
    expect(tools('cop')).toEqual(['copilot']);
  });
});

describe('MCP measurement', () => {
  const closers: Array<() => void> = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));

  it('lists every page of tools from a stdio server with its instructions and _meta, skipping non-JSON output', async () => {
    const server = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'docs')!;
    const r = await measureServer(server, { root: MCP, timeoutMs: 10_000 });
    expect(r.error).toBeUndefined();
    expect(r.tools).toEqual([SEARCH, TICKET]);
    expect(r.instructions).toBe(INSTRUCTIONS);
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

  // On Windows the server runs under cmd.exe, and a process that exits right after measuring (a vitest worker)
  // takes cmd.exe down with it but not the server: the tree must be gone before the measurement resolves.
  it.runIf(process.platform === 'win32')('ends a server that ignores its closed stdin before resolving', async () => {
    // Answers with its process id as the instructions and keeps running after stdin closes.
    const script = `require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.id) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { instructions: String(process.pid), tools: [] } })); }); setInterval(() => {}, 1000)`;
    const r = await measureServer(server({ command: 'node', args: ['-e', script] }), { root: MCP, timeoutMs: 10_000 });
    const pid = Number(r.instructions);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
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
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, instructions: 'Use remote_tool.' }
            : { tools: [{ name: 'remote_tool', description: 'd', inputSchema: { type: 'object' } }] };
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
    expect(r.instructions).toBe('Use remote_tool.');
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(seen[2]).toMatchObject({ session: 'sess-1', auth: 'Bearer secret' });
  });

  it('does not start a server that needs a VS Code input', async () => {
    const server = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'remote')!;
    expect((await measureServer(server, { root: '.', timeoutMs: 1000 })).error).toMatch(/\$\{input:/);
  });

  it('lists WebSocket and legacy SSE servers without connecting to them', async () => {
    const fetchFn = (() => Promise.reject(new Error('should not connect'))) as typeof fetch;
    const ws = parseMcpConfigs(discoverMcpConfigs(MCP)).servers.find((s) => s.name === 'socket')!;
    expect((await measureServer(ws, { root: '.', timeoutMs: 1000, fetchFn })).error).toMatch(/WebSocket transport is not supported/);
    const sse = server({ transport: 'sse', url: 'https://x/sse', command: undefined });
    expect((await measureServer(sse, { root: '.', timeoutMs: 1000, fetchFn })).error).toMatch(/legacy SSE/);
  });

  it('expands environment variables and the workspace folder', () => {
    expect(expandVars('${A}-${B:-dflt}-${env:A}', { A: 'x' })).toBe('x-dflt-x');
    expect(expandVars('Bearer {env:A}', { A: 'x' })).toBe('Bearer x');
    expect(expandVars('${workspaceFolder}/.env', { workspaceFolder: 'no' }, '/repo')).toBe('/repo/.env');
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
  const docsMeasured = (instructions = INSTRUCTIONS) => new Map<string, McpMeasurement>([[serverKey(servers().find((s) => s.name === 'docs')!), { tools: [SEARCH, TICKET], instructions }]]);

  it('lists configured servers as not measured without --mcp, and adds their agents', async () => {
    const report = await audit(files, { models: gpt, mcp: { servers: servers() } });
    expect(report.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(['claude-code', 'cursor', 'copilot', 'gemini-cli']));
    const cursor = report.tools.find((t) => t.tool === 'cursor')!;
    expect(cursor).toMatchObject({ mcpServers: 1, mcpPerTurnO200k: 0, mcpMeasured: false });
    expect(report.mcp.find((m) => m.name === 'off')!.status).toBe('disabled');
    const text = renderText(report);
    expect(text).toContain('MCP servers');
    expect(text).toContain('run with --mcp');
    expect(text).toContain('.vscode/mcp.json: Deprecated for Copilot');
    expect(renderMarkdown(report)).toContain('## MCP servers');
  });

  it('counts per agent: deferred names and alwaysLoad tools for Claude Code, filters, and instructions where documented', async () => {
    const report = await audit(files, { tools: ['claude-code', 'cursor', 'copilot', 'gemini-cli'], models: gpt, mcp: { servers: servers(), measured: docsMeasured() } });
    const row = (tool: string, configPath: string) => report.mcp.find((m) => m.tool === tool && m.configPath === configPath && m.name !== 'off' && m.status === 'measured')!;
    const instructions = countO200k(INSTRUCTIONS);

    // Claude Code: open_ticket asks to load upfront, search_docs stays behind tool search; instructions load every turn.
    expect(row('claude-code', '.mcp.json')).toMatchObject({
      status: 'measured',
      tools: 2,
      o200k: countO200k(toolDefinitionsText([TICKET])) + countO200k(toolNamesText([SEARCH])) + instructions,
      deferredTools: 1,
      deferredO200k: countO200k(toolDefinitionsText([SEARCH])),
      instructionsO200k: instructions,
    });
    // Cursor documents no deferral and no server instructions.
    const cursor = row('cursor', '.cursor/mcp.json');
    expect(cursor).toMatchObject({ tools: 2, o200k: countO200k(toolDefinitionsText([SEARCH, TICKET])) });
    expect(cursor.instructionsO200k).toBeUndefined();
    expect(report.tools.find((t) => t.tool === 'cursor')).toMatchObject({ mcpPerTurnO200k: cursor.o200k, mcpMeasured: true });
    // Copilot's tools list and Gemini's excludeTools leave open_ticket out; Gemini appends the instructions.
    expect(row('copilot', '.github/mcp.json')).toMatchObject({ tools: 1, excludedTools: 1, o200k: countO200k(toolDefinitionsText([SEARCH])) });
    expect(row('copilot', '.mcp.json')).toMatchObject({ tools: 2, o200k: countO200k(toolDefinitionsText([SEARCH, TICKET])) });
    expect(row('gemini-cli', '.gemini/settings.json')).toMatchObject({ tools: 1, excludedTools: 1, o200k: countO200k(toolDefinitionsText([SEARCH])) + instructions });

    expect(report.mcp.find((m) => m.name === 'socket' && m.tool === 'claude-code')).toMatchObject({ transport: 'ws', status: 'not-measured' });
    expect(report.tools.find((t) => t.tool === 'claude-code')!.mcpMeasured).toBe(false); // "broken" and "socket" are not measured
    const text = renderText(report);
    expect(text).toContain('2 tools; 1 in full, 1 as names only, full definitions');
    expect(text).toContain('1 tools (1 more left out by the config)');
    expect(text).toContain(`server instructions ${instructions}`);
    expect(text).toContain(INSTRUCTIONS_NOTE);
    expect(renderMarkdown(report)).toContain(INSTRUCTIONS_NOTE);
  });

  it('lists an overridden copy of a server without starting or counting it', async () => {
    const { servers: parsed } = parseMcpConfigs([
      { path: '.mcp.json', text: '{"mcpServers":{"same":{"command":"project"}}}' },
      { path: '.vscode/mcp.json', text: '{"servers":{"same":{"command":"vscode"}}}' },
      { path: '~/.claude.json', text: '{"mcpServers":{"same":{"command":"user"}}}' },
    ]);
    const tools = [SEARCH];
    const measured = new Map<string, McpMeasurement>(parsed.map((s) => [serverKey(s), { tools }]));
    const report = await audit([], { tools: ['claude-code', 'copilot'], models: [], mcp: { servers: parsed, measured } });
    const row = (tool: string, configPath: string) => report.mcp.find((m) => m.tool === tool && m.configPath === configPath)!;
    expect(row('claude-code', '~/.claude.json')).toMatchObject({ status: 'overridden', overriddenBy: '.mcp.json' });
    expect(row('claude-code', '~/.claude.json').o200k).toBeUndefined();
    expect(row('copilot', '.vscode/mcp.json')).toMatchObject({ status: 'overridden', overriddenBy: '.mcp.json', overrideAssumed: true });
    for (const tool of ['claude-code', 'copilot'] as const)
      expect(report.tools.find((t) => t.tool === tool)).toMatchObject({ mcpServers: 1, mcpMeasured: true, userPerTurnO200k: 0 });
    const text = renderText(report);
    expect(text).toContain('overridden by .mcp.json (precedence assumed)');
    expect(text).toMatch(/overridden\s+same\s+~\/\.claude\.json\s+-\s+overridden by \.mcp\.json\s+claude-code/);
  });

  it("follows Claude Code's alwaysLoad setting over the tools' own _meta", async () => {
    const measured = (s: McpServer) => new Map<string, McpMeasurement>([[serverKey(s), { tools: [SEARCH, TICKET] }]]);
    const rowFor = async (s: McpServer) => (await audit([], { tools: ['claude-code'], models: [], mcp: { servers: [s], measured: measured(s) } })).mcp[0]!;
    expect(await rowFor(server({ alwaysLoad: true }))).toMatchObject({ o200k: countO200k(toolDefinitionsText([SEARCH, TICKET])) });
    expect((await rowFor(server({ alwaysLoad: true }))).deferredO200k).toBeUndefined();
    expect(await rowFor(server({ alwaysLoad: false }))).toMatchObject({ o200k: countO200k(toolNamesText([SEARCH, TICKET])), deferredTools: 2 });
  });

  it('cuts Claude Code server instructions and upfront descriptions at 4,096 characters, deferred ones at 16,384', async () => {
    const long = 'word '.repeat(5000); // 25,000 characters
    const tools: McpToolDef[] = [
      { name: 'upfront', description: long, _meta: { 'anthropic/alwaysLoad': true } },
      { name: 'deferred', description: long },
    ];
    const claude = server({});
    const gemini = server({ tool: 'gemini-cli', configPath: '.gemini/settings.json' });
    const measured = new Map<string, McpMeasurement>([[serverKey(claude), { tools, instructions: long }]]);
    const report = await audit([], { tools: ['claude-code', 'gemini-cli'], models: [], mcp: { servers: [claude, gemini], measured } });
    const [c, g] = report.mcp;
    const cut = (n: number) => long.slice(0, n);
    expect(c).toMatchObject({
      instructionsO200k: countO200k(cut(4096)),
      o200k: countO200k(toolDefinitionsText([{ ...tools[0]!, description: cut(4096) }])) + countO200k('deferred') + countO200k(cut(4096)),
      deferredO200k: countO200k(toolDefinitionsText([{ ...tools[1]!, description: cut(16_384) }])),
    });
    // Gemini CLI documents no cut.
    expect(g).toMatchObject({ instructionsO200k: countO200k(long), o200k: countO200k(toolDefinitionsText(tools)) + countO200k(long) });
  });
});
