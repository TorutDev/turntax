/**
 * MCP server configuration: which agent starts which server, read from the agents' config files.
 * Every server an agent starts adds its tool definitions (names, descriptions, JSON schemas) to the
 * context, so they are part of the per-turn cost. This module only parses configs; measuring the
 * tool definitions needs the server running (src/node/mcp.ts, opt-in with --mcp).
 */
import type { RepoFile, ToolId } from './types.js';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServer {
  /** Server name as written in the config. */
  name: string;
  tool: ToolId;
  /** Config file the server comes from: repo-relative, or `~/...` for user-level configs. */
  configPath: string;
  scope: 'project' | 'user';
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for stdio servers, when the config sets one. */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Turned off in the config; not started by the agent and not counted. */
  disabled: boolean;
  /** Claude Code `alwaysLoad: true`: the server's tool definitions are not deferred to tool search. */
  alwaysLoad?: boolean;
}

/** Tool definitions a server returned from tools/list, as the agent receives them. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpConfigSpec {
  tool: ToolId;
  /** Repo-relative path for project configs, home-relative for user configs. */
  path: string;
  scope: 'project' | 'user';
  /** Top-level key that holds the servers. */
  key: string;
  shape: 'standard' | 'gemini' | 'vscode' | 'opencode' | 'zed' | 'codex-toml' | 'claude-json';
  source: string;
}

const CHECKED_AT = '2026-10-11';

/** Where each agent reads MCP servers from. Paths and keys come from the cited pages. */
export const MCP_CONFIGS: McpConfigSpec[] = [
  { tool: 'claude-code', path: '.mcp.json', scope: 'project', key: 'mcpServers', shape: 'standard', source: 'https://code.claude.com/docs/en/mcp' },
  { tool: 'cursor', path: '.cursor/mcp.json', scope: 'project', key: 'mcpServers', shape: 'standard', source: 'https://cursor.com/docs/context/mcp' },
  { tool: 'copilot', path: '.vscode/mcp.json', scope: 'project', key: 'servers', shape: 'vscode', source: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers' },
  { tool: 'gemini-cli', path: '.gemini/settings.json', scope: 'project', key: 'mcpServers', shape: 'gemini', source: 'https://geminicli.com/docs/tools/mcp-server/' },
  { tool: 'kiro', path: '.kiro/settings/mcp.json', scope: 'project', key: 'mcpServers', shape: 'standard', source: 'https://kiro.dev/docs/mcp/configuration/' },
  { tool: 'roo-code', path: '.roo/mcp.json', scope: 'project', key: 'mcpServers', shape: 'standard', source: 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo' },
  { tool: 'opencode', path: 'opencode.json', scope: 'project', key: 'mcp', shape: 'opencode', source: 'https://opencode.ai/docs/mcp-servers/' },
  { tool: 'opencode', path: 'opencode.jsonc', scope: 'project', key: 'mcp', shape: 'opencode', source: 'https://opencode.ai/docs/mcp-servers/' },
  { tool: 'zed', path: '.zed/settings.json', scope: 'project', key: 'context_servers', shape: 'zed', source: 'https://zed.dev/docs/ai/mcp' },
  { tool: 'codex', path: '.codex/config.toml', scope: 'project', key: 'mcp_servers', shape: 'codex-toml', source: 'https://learn.chatgpt.com/docs/extend/mcp' },

  { tool: 'claude-code', path: '.claude.json', scope: 'user', key: 'mcpServers', shape: 'claude-json', source: 'https://code.claude.com/docs/en/mcp' },
  { tool: 'cursor', path: '.cursor/mcp.json', scope: 'user', key: 'mcpServers', shape: 'standard', source: 'https://cursor.com/docs/context/mcp' },
  { tool: 'gemini-cli', path: '.gemini/settings.json', scope: 'user', key: 'mcpServers', shape: 'gemini', source: 'https://geminicli.com/docs/tools/mcp-server/' },
  { tool: 'kiro', path: '.kiro/settings/mcp.json', scope: 'user', key: 'mcpServers', shape: 'standard', source: 'https://kiro.dev/docs/mcp/configuration/' },
  { tool: 'windsurf', path: '.config/devin/mcp_config.json', scope: 'user', key: 'mcpServers', shape: 'standard', source: 'https://docs.devin.ai/desktop/cascade/mcp' },
  { tool: 'windsurf', path: 'AppData/Roaming/devin/mcp_config.json', scope: 'user', key: 'mcpServers', shape: 'standard', source: 'https://docs.devin.ai/desktop/cascade/mcp' },
  { tool: 'codex', path: '.codex/config.toml', scope: 'user', key: 'mcp_servers', shape: 'codex-toml', source: 'https://learn.chatgpt.com/docs/extend/mcp' },
  { tool: 'opencode', path: '.config/opencode/opencode.json', scope: 'user', key: 'mcp', shape: 'opencode', source: 'https://opencode.ai/docs/mcp-servers/' },
];

export const MCP_CHECKED_AT = CHECKED_AT;

/** True for a repo-relative path that holds project MCP servers for some agent. */
export function isMcpConfigFile(path: string): boolean {
  return MCP_CONFIGS.some((c) => c.scope === 'project' && c.path === path);
}

/** Home-relative paths of user-level MCP configs. */
export const USER_MCP_PATHS: string[] = [...new Set(MCP_CONFIGS.filter((c) => c.scope === 'user').map((c) => c.path))];

/** JSON with comments and trailing commas (VS Code, Zed and OpenCode accept both). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
const record = (v: unknown): Record<string, string> | undefined =>
  isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined;

function fromStandard(name: string, v: Obj, gemini = false): Omit<McpServer, 'tool' | 'configPath' | 'scope'> {
  const type = String(v.type ?? v.transport ?? '').toLowerCase();
  // Gemini CLI has no type field: `httpUrl` is streamable HTTP and `url` is SSE.
  // Elsewhere `url` (Windsurf: `serverUrl`) is streamable HTTP unless the type says SSE.
  const httpUrl = typeof v.httpUrl === 'string' ? v.httpUrl : undefined;
  const url = httpUrl ?? (typeof v.url === 'string' ? v.url : typeof v.serverUrl === 'string' ? v.serverUrl : undefined);
  const transport: McpTransport = !url ? 'stdio' : httpUrl ? 'http' : gemini || type === 'sse' ? 'sse' : 'http';
  return {
    name,
    transport,
    command: typeof v.command === 'string' ? v.command : undefined,
    args: strings(v.args),
    env: record(v.env),
    cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
    url,
    headers: record(v.headers),
    disabled: v.disabled === true || v.enabled === false,
    ...(v.alwaysLoad === true ? { alwaysLoad: true } : {}),
  };
}

function fromOpencode(name: string, v: Obj): Omit<McpServer, 'tool' | 'configPath' | 'scope'> {
  const command = strings(v.command) ?? [];
  const remote = v.type === 'remote' || typeof v.url === 'string';
  return {
    name,
    transport: remote ? 'http' : 'stdio',
    command: remote ? undefined : command[0],
    args: remote ? undefined : command.slice(1),
    env: record(v.environment),
    url: typeof v.url === 'string' ? v.url : undefined,
    headers: record(v.headers),
    disabled: v.enabled === false,
  };
}

function fromZed(name: string, v: Obj): Omit<McpServer, 'tool' | 'configPath' | 'scope'> {
  // Older Zed settings nest the command: { "command": { "path", "args", "env" } }.
  if (isObj(v.command)) {
    const c = v.command;
    return fromStandard(name, { ...v, command: c.path ?? c.command, args: c.args, env: c.env });
  }
  return fromStandard(name, v);
}

function serversIn(container: unknown, shape: McpConfigSpec['shape']): Array<Omit<McpServer, 'tool' | 'configPath' | 'scope'>> {
  if (!isObj(container)) return [];
  return Object.entries(container)
    .filter(([, v]) => isObj(v))
    .map(([name, v]) =>
      shape === 'opencode'
        ? fromOpencode(name, v as Obj)
        : shape === 'zed'
          ? fromZed(name, v as Obj)
          : fromStandard(name, v as Obj, shape === 'gemini'),
    );
}

/** Minimal TOML reader for Codex `[mcp_servers.<name>]` tables: strings, string arrays and inline tables. */
export function parseCodexToml(text: string): Obj {
  const servers: Obj = {};
  let current: Obj | null = null;
  let sub: string | null = null;
  const value = (raw: string): unknown => {
    const t = raw.trim();
    if (t.startsWith('[')) return [...t.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    if (t.startsWith('{'))
      return Object.fromEntries(
        [...t.matchAll(/([\w-]+|"[^"]*")\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)].map((m) => [m[1]!.replace(/"/g, ''), m[2] ?? m[3] ?? '']),
      );
    if (t === 'true' || t === 'false') return t === 'true';
    const s = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(t);
    return s ? (s[1] ?? s[2]) : t;
  };
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([\w-]+))(?:\.(\w+))?\s*\]/.exec(line);
    if (header) {
      const name = (header[1] ?? header[2])!;
      servers[name] ??= {};
      current = servers[name] as Obj;
      sub = header[3] ?? null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const kv = /^\s*([\w-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!kv || !current) continue;
    if (sub) {
      const table = (current[sub] ??= {}) as Obj;
      table[kv[1]!] = value(kv[2]!);
    } else current[kv[1]!] = value(kv[2]!);
  }
  // Codex calls HTTP headers `http_headers`.
  for (const v of Object.values(servers)) if (isObj(v) && v.http_headers && !v.headers) v.headers = v.http_headers;
  return servers;
}

export interface ParsedMcpConfig {
  servers: McpServer[];
  /** Config files that could not be parsed. */
  problems: Array<{ path: string; message: string }>;
}

/**
 * Parses the MCP configs among `files`. Project files use repo-relative paths; user files are passed
 * with a `~/` prefix. `projectRoot` (absolute) selects the per-project entry in ~/.claude.json.
 */
export function parseMcpConfigs(files: RepoFile[], projectRoot?: string): ParsedMcpConfig {
  const servers: McpServer[] = [];
  const problems: ParsedMcpConfig['problems'] = [];
  for (const f of files) {
    const user = f.path.startsWith('~/');
    const rel = user ? f.path.slice(2) : f.path;
    const specs = MCP_CONFIGS.filter((c) => c.path === rel && c.scope === (user ? 'user' : 'project'));
    if (!specs.length) continue;
    let data: unknown;
    try {
      data = specs[0]!.shape === 'codex-toml' ? parseCodexToml(f.text) : parseJsonc(f.text);
    } catch (e) {
      problems.push({ path: f.path, message: `could not be parsed: ${(e as Error).message}` });
      continue;
    }
    if (!isObj(data)) continue;
    for (const spec of specs) {
      const containers: unknown[] =
        spec.shape === 'codex-toml'
          ? [data]
          : spec.shape === 'claude-json'
            ? [data.mcpServers, projectEntry(data, projectRoot)?.mcpServers]
            : [data[spec.key]];
      for (const c of containers)
        for (const s of serversIn(c, spec.shape)) servers.push({ ...s, tool: spec.tool, configPath: f.path, scope: spec.scope });
    }
  }
  return { servers, problems };
}

/** The `projects["<abs path>"]` entry of ~/.claude.json for this repository, matched case- and slash-insensitively. */
function projectEntry(data: Obj, root?: string): Obj | undefined {
  if (!root || !isObj(data.projects)) return undefined;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const hit = Object.entries(data.projects).find(([p]) => norm(p) === norm(root));
  return hit && isObj(hit[1]) ? hit[1] : undefined;
}

/** Same server started by several agents or configs: one launch, one measurement. */
export function serverKey(s: McpServer): string {
  return JSON.stringify([s.transport, s.command ?? '', s.args ?? [], s.url ?? '', s.cwd ?? '']);
}

/**
 * Claude Code defers MCP tool definitions by default (tool search): only tool names are in context
 * until a tool is used. A server with `alwaysLoad: true` is exempt.
 */
export function defersTools(s: McpServer): boolean {
  return s.tool === 'claude-code' && !s.alwaysLoad;
}

export const DEFERRED_NOTE =
  'Claude Code defers MCP tool definitions by default (tool search): only tool names load every turn; full definitions load when a tool is used. Set ENABLE_TOOL_SEARCH=false or alwaysLoad: true to load them upfront.';

/** Tool names only, as listed when definitions are deferred. */
export function toolNamesText(tools: McpToolDef[]): string {
  return tools.map((t) => t.name).join('\n');
}

/** The text an agent receives for a server's tools, as one JSON document per tool. */
export function toolDefinitionsText(tools: McpToolDef[]): string {
  return tools.map((t) => JSON.stringify({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} })).join('\n');
}
