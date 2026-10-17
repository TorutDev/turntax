/**
 * MCP server configuration: which agent starts which server, read from the agents' config files.
 * Every server an agent starts adds its tool definitions (names, descriptions, JSON schemas) and, for
 * some agents, its instructions to the context, so they are part of the per-turn cost. This module
 * parses configs and decides what each agent keeps; measuring needs the server running
 * (src/node/mcp.ts, opt-in with --mcp).
 */
import type { RepoFile, ToolId } from './types.js';

/** 'ws': Claude Code's WebSocket transport (`type: "ws"`). */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws';

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
  /**
   * Claude Code `alwaysLoad`: true loads every tool of the server upfront, false keeps every tool behind tool
   * search; unset leaves it to each tool's `_meta["anthropic/alwaysLoad"]`.
   */
  alwaysLoad?: boolean;
  /** Tool allow list from the config (see TOOL_FILTERS); empty or containing `*` allows every tool. */
  includeTools?: string[];
  /** Tool deny list from the config (see TOOL_FILTERS); wins over the allow list. */
  excludeTools?: string[];
  /** Something the config does not show that can change what the agent loads. */
  note?: string;
  /** From the `projects[<repo path>]` entry of ~/.claude.json (Claude Code's local scope). */
  local?: boolean;
  /**
   * Set when the agent finds the same server name in a config it prefers (see PRECEDENCE): that config, which the
   * agent uses instead of this definition. This copy is not started or counted.
   */
  overriddenBy?: string;
  /** The precedence behind `overriddenBy` is not documented; MCP_CONFIGS order decided it. */
  overrideAssumed?: boolean;
}

/** Tool definitions a server returned from tools/list, as the agent receives them. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** The tool's `_meta` object from tools/list; read for flags such as `anthropic/alwaysLoad`, never sent to the model. */
  _meta?: Record<string, unknown>;
}

export interface McpConfigSpec {
  tool: ToolId;
  /** Repo-relative path for project configs, home-relative for user configs. */
  path: string;
  scope: 'project' | 'user';
  /** Top-level key that holds the servers. */
  key: string;
  shape: 'standard' | 'gemini' | 'vscode' | 'opencode' | 'zed' | 'codex-toml' | 'claude-json';
  /** The file may also hold the servers as a bare top-level map, without `key` (Copilot CLI project files). */
  bare?: boolean;
  /** Shown with every server from this file. */
  note?: string;
  source: string;
}

const CHECKED_AT = '2026-10-17';

const CLAUDE = 'https://code.claude.com/docs/en/mcp';
const CURSOR = 'https://cursor.com/docs/mcp';
const COPILOT_CLI = 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers';
const VSCODE = 'https://code.visualstudio.com/docs/agent-customization/mcp-servers';
const GEMINI = 'https://geminicli.com/docs/tools/mcp-server/';
const KIRO = 'https://kiro.dev/docs/mcp/configuration/';
const ROO = 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo';
const OPENCODE = 'https://opencode.ai/docs/mcp-servers/';
const ZED = 'https://zed.dev/docs/ai/mcp';
const CODEX = 'https://learn.chatgpt.com/docs/extend/mcp';
const CASCADE = 'https://docs.devin.ai/desktop/cascade/mcp';
const DEVIN = 'https://docs.devin.ai/cli/extensibility/mcp/configuration';
const DEVIN_IMPORT = 'https://docs.devin.ai/cli/reference/configuration/read-config-from';
const AUGMENT = 'https://docs.augmentcode.com/cli/integrations';
const FACTORY = 'https://docs.factory.com/harness/mcp';
const KILO = 'https://kilo.ai/docs/automate/mcp/using-in-kilo-code';
const WARP = 'https://docs.warp.dev/agents/capabilities/mcp/';

const COPILOT_NOTE =
  'Copilot CLI defers MCP tools to tool search on supported models once there are more than about 30 tools (deferTools: "never" opts a server out); turntax counts them in full.';
const VSCODE_NOTE =
  'Deprecated for Copilot: Copilot CLI does not read .vscode/mcp.json, and VS Code forwards only servers that need no ${input:...} value to Copilot sessions.';
const AUGMENT_NOTE = 'Augment loads every MCP tool upfront unless enableToolSearch is on; turntax does not read that setting.';
const DEVIN_CLAUDE_NOTE = 'Devin imports Claude Code MCP servers from this file; that it uses the same per-project servers as Claude Code is assumed.';

const spec = (
  tool: ToolId,
  path: string,
  scope: McpConfigSpec['scope'],
  key: string,
  shape: McpConfigSpec['shape'],
  source: string,
  extra: Pick<McpConfigSpec, 'bare' | 'note'> = {},
): McpConfigSpec => ({ tool, path, scope, key, shape, source, ...extra });

/**
 * Where each agent reads MCP servers from. Paths and keys come from the cited pages. The agent that owns a file is
 * listed first; Devin entries for other agents' files are the imports Devin CLI does by default (`read_config_from`).
 */
export const MCP_CONFIGS: McpConfigSpec[] = [
  spec('claude-code', '.mcp.json', 'project', 'mcpServers', 'standard', CLAUDE),
  spec('copilot', '.mcp.json', 'project', 'mcpServers', 'standard', COPILOT_CLI, { bare: true, note: COPILOT_NOTE }),
  spec('devin', '.mcp.json', 'project', 'mcpServers', 'standard', DEVIN_IMPORT),
  spec('cursor', '.cursor/mcp.json', 'project', 'mcpServers', 'standard', CURSOR),
  spec('devin', '.cursor/mcp.json', 'project', 'mcpServers', 'standard', DEVIN_IMPORT),
  spec('copilot', '.github/mcp.json', 'project', 'mcpServers', 'standard', COPILOT_CLI, { bare: true, note: COPILOT_NOTE }),
  spec('copilot', '.vscode/mcp.json', 'project', 'servers', 'vscode', VSCODE, { note: VSCODE_NOTE }),
  spec('gemini-cli', '.gemini/settings.json', 'project', 'mcpServers', 'gemini', GEMINI),
  spec('kiro', '.kiro/settings/mcp.json', 'project', 'mcpServers', 'standard', KIRO),
  spec('roo-code', '.roo/mcp.json', 'project', 'mcpServers', 'standard', ROO),
  spec('opencode', 'opencode.json', 'project', 'mcp', 'opencode', OPENCODE),
  spec('kilo-code', 'opencode.json', 'project', 'mcp', 'opencode', KILO),
  spec('devin', 'opencode.json', 'project', 'mcp', 'opencode', DEVIN_IMPORT),
  spec('opencode', 'opencode.jsonc', 'project', 'mcp', 'opencode', OPENCODE),
  spec('kilo-code', 'opencode.jsonc', 'project', 'mcp', 'opencode', KILO),
  spec('kilo-code', 'kilo.json', 'project', 'mcp', 'opencode', KILO),
  spec('kilo-code', 'kilo.jsonc', 'project', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.kilo/kilo.json', 'project', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.kilo/kilo.jsonc', 'project', 'mcp', 'opencode', KILO),
  spec('zed', '.zed/settings.json', 'project', 'context_servers', 'zed', ZED),
  spec('devin', '.zed/settings.json', 'project', 'context_servers', 'zed', DEVIN_IMPORT),
  spec('codex', '.codex/config.toml', 'project', 'mcp_servers', 'codex-toml', CODEX),
  spec('augment', '.augment/settings.json', 'project', 'mcpServers', 'standard', AUGMENT, { note: AUGMENT_NOTE }),
  spec('augment', '.augment/settings.local.json', 'project', 'mcpServers', 'standard', AUGMENT, { note: AUGMENT_NOTE }),
  spec('factory-droid', '.factory/mcp.json', 'project', 'mcpServers', 'standard', FACTORY),
  spec('devin', '.devin/mcp_config.json', 'project', 'mcpServers', 'standard', DEVIN),
  spec('devin', '.devin/mcp_config.local.json', 'project', 'mcpServers', 'standard', DEVIN),

  spec('claude-code', '.claude.json', 'user', 'mcpServers', 'claude-json', CLAUDE),
  spec('devin', '.claude.json', 'user', 'mcpServers', 'claude-json', DEVIN_IMPORT, { note: DEVIN_CLAUDE_NOTE }),
  spec('copilot', '.copilot/mcp-config.json', 'user', 'mcpServers', 'standard', COPILOT_CLI, { note: COPILOT_NOTE }),
  spec('cursor', '.cursor/mcp.json', 'user', 'mcpServers', 'standard', CURSOR),
  spec('gemini-cli', '.gemini/settings.json', 'user', 'mcpServers', 'gemini', GEMINI),
  spec('kiro', '.kiro/settings/mcp.json', 'user', 'mcpServers', 'standard', KIRO),
  spec('windsurf', '.config/devin/mcp_config.json', 'user', 'mcpServers', 'standard', CASCADE),
  spec('devin', '.config/devin/mcp_config.json', 'user', 'mcpServers', 'standard', DEVIN),
  spec('windsurf', 'AppData/Roaming/devin/mcp_config.json', 'user', 'mcpServers', 'standard', CASCADE),
  spec('devin', 'AppData/Roaming/devin/mcp_config.json', 'user', 'mcpServers', 'standard', DEVIN),
  spec('devin', '.codeium/windsurf/mcp_config.json', 'user', 'mcpServers', 'standard', DEVIN_IMPORT),
  spec('codex', '.codex/config.toml', 'user', 'mcp_servers', 'codex-toml', CODEX),
  spec('opencode', '.config/opencode/opencode.json', 'user', 'mcp', 'opencode', OPENCODE),
  spec('devin', '.config/opencode/opencode.json', 'user', 'mcp', 'opencode', DEVIN_IMPORT),
  spec('devin', '.config/zed/settings.json', 'user', 'context_servers', 'zed', DEVIN_IMPORT),
  spec('kilo-code', '.config/kilo/kilo.json', 'user', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.config/kilo/kilo.jsonc', 'user', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.config/kilo/opencode.json', 'user', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.config/kilo/opencode.jsonc', 'user', 'mcp', 'opencode', KILO),
  spec('kilo-code', '.config/kilo/config.json', 'user', 'mcp', 'opencode', KILO),
  spec('augment', '.augment/settings.json', 'user', 'mcpServers', 'standard', AUGMENT, { note: AUGMENT_NOTE }),
  spec('factory-droid', '.factory/mcp.json', 'user', 'mcpServers', 'standard', FACTORY),
  spec('warp', '.warp/.mcp.json', 'user', 'mcpServers', 'standard', WARP),
];

/**
 * Per-server tool filters, by agent: the config field holding the allow list and the deny list. Tools they leave
 * out are never given to the model (Codex, Gemini CLI, Factory, Kiro, Roo Code and Windsurf docs; Copilot CLI's
 * required `tools` list, `["*"]` for all).
 */
const TOOL_FILTERS: Partial<Record<ToolId, { include?: string; exclude?: string }>> = {
  codex: { include: 'enabled_tools', exclude: 'disabled_tools' },
  'gemini-cli': { include: 'includeTools', exclude: 'excludeTools' },
  'factory-droid': { include: 'enabledTools', exclude: 'disabledTools' },
  copilot: { include: 'tools' },
  kiro: { exclude: 'disabledTools' },
  'roo-code': { exclude: 'disabledTools' },
  windsurf: { exclude: 'disabledTools' },
};

/**
 * The documented order, highest first, in which an agent picks one definition for a server name found in several of
 * its configs. Entries are config paths as in `configPath` (`~/.claude.json#local` is its `projects[<repo path>]`
 * entry) or a scope. Configs left out, ties and agents left out follow MCP_CONFIGS order, which is assumed.
 */
const PRECEDENCE: Partial<Record<ToolId, { order: string[]; assumed?: true }>> = {
  'claude-code': { order: ['~/.claude.json#local', '.mcp.json', '~/.claude.json'] },
  copilot: { order: ['.mcp.json', '.github/mcp.json', '~/.copilot/mcp-config.json'] },
  'gemini-cli': { order: ['project', 'user'] },
  kiro: { order: ['project', 'user'] },
  'kilo-code': { order: ['project', 'user'] },
  augment: { order: ['.augment/settings.local.json', '.augment/settings.json', '~/.augment/settings.json'] },
  // Factory documents only that one definition loads. Turning a project server on or off writes a copy with the new
  // state to the user config, which implies the user config wins.
  'factory-droid': { order: ['~/.factory/mcp.json', '.factory/mcp.json'], assumed: true },
};

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
  // Elsewhere `url` (Windsurf: `serverUrl`) is streamable HTTP unless the type says SSE or WebSocket (Claude Code `ws`).
  const httpUrl = typeof v.httpUrl === 'string' ? v.httpUrl : undefined;
  const url = httpUrl ?? (typeof v.url === 'string' ? v.url : typeof v.serverUrl === 'string' ? v.serverUrl : undefined);
  const transport: McpTransport = !url ? 'stdio' : httpUrl ? 'http' : gemini || type === 'sse' ? 'sse' : type === 'ws' ? 'ws' : 'http';
  return {
    name,
    transport,
    command: typeof v.command === 'string' ? v.command : undefined,
    args: strings(v.args),
    env: record(v.env),
    // Warp calls it `working_directory`.
    cwd: typeof v.cwd === 'string' ? v.cwd : typeof v.working_directory === 'string' ? v.working_directory : undefined,
    url,
    headers: record(v.headers),
    disabled: v.disabled === true || v.enabled === false,
    ...(typeof v.alwaysLoad === 'boolean' ? { alwaysLoad: v.alwaysLoad } : {}),
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

function serversIn(container: unknown, spec: McpConfigSpec, configPath: string, local: boolean): McpServer[] {
  if (!isObj(container)) return [];
  const filter = TOOL_FILTERS[spec.tool];
  return Object.entries(container)
    .filter(([, v]) => isObj(v))
    .map(([name, v]) => {
      const s =
        spec.shape === 'opencode'
          ? fromOpencode(name, v as Obj)
          : spec.shape === 'zed'
            ? fromZed(name, v as Obj)
            : fromStandard(name, v as Obj, spec.shape === 'gemini');
      const include = filter?.include ? strings((v as Obj)[filter.include]) : undefined;
      const exclude = filter?.exclude ? strings((v as Obj)[filter.exclude]) : undefined;
      return {
        ...s,
        tool: spec.tool,
        configPath,
        scope: spec.scope,
        ...(include ? { includeTools: include } : {}),
        ...(exclude ? { excludeTools: exclude } : {}),
        ...(spec.note ? { note: spec.note } : {}),
        ...(local ? { local: true } : {}),
      };
    });
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
 * A server name an agent finds in several of its configs is marked `overriddenBy` on all but one copy.
 */
export function parseMcpConfigs(files: RepoFile[], projectRoot?: string): ParsedMcpConfig {
  const servers: McpServer[] = [];
  /** Position of each server's config in MCP_CONFIGS (the local entry of ~/.claude.json right after its file). */
  const order: number[] = [];
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
            : [spec.bare && !isObj(data[spec.key]) ? bareServers(data) : data[spec.key]];
      containers.forEach((c, i) => {
        const found = serversIn(c, spec, f.path, i === 1);
        servers.push(...found);
        order.push(...found.map(() => MCP_CONFIGS.indexOf(spec) * 2 + i));
      });
    }
  }
  return { servers: resolveOverrides(servers, order), problems };
}

/** Where a server comes from, as written in PRECEDENCE. */
const source = (s: McpServer): string => (s.local ? `${s.configPath}#local` : s.configPath);

/** Keeps one definition per agent and server name; the others are marked as overridden by the config that wins. */
function resolveOverrides(servers: McpServer[], order: number[]): McpServer[] {
  const out = [...servers];
  const groups = new Map<string, number[]>();
  servers.forEach((s, i) => {
    const key = JSON.stringify([s.tool, s.name]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const precedence = PRECEDENCE[servers[group[0]!]!.tool];
    const rank = (s: McpServer) => {
      const r = precedence?.order.findIndex((e) => e === source(s) || e === s.scope) ?? -1;
      return r < 0 ? Infinity : r;
    };
    const [win, ...rest] = [...group].sort((a, b) => rank(servers[a]!) - rank(servers[b]!) || order[a]! - order[b]!);
    const winner = servers[win!]!;
    for (const i of rest) {
      const s = servers[i]!;
      const documented = !precedence?.assumed && rank(winner) < rank(s) && rank(s) < Infinity;
      out[i] = { ...s, overriddenBy: winner.local ? `${winner.configPath} (local)` : winner.configPath, ...(documented ? {} : { overrideAssumed: true }) };
    }
  }
  return out;
}

/** A bare top-level server map: the entries that name a command or URL (Copilot CLI skips invalid entries). */
function bareServers(data: Obj): Obj {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => isObj(v) && (typeof v.command === 'string' || typeof v.url === 'string')));
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

/** The tools that reach the model after the config's allow and deny lists (TOOL_FILTERS). */
export function filterTools(s: McpServer, tools: McpToolDef[]): McpToolDef[] {
  const allow = s.includeTools?.length && !s.includeTools.includes('*') ? new Set(s.includeTools) : undefined;
  const deny = new Set(s.excludeTools);
  return tools.filter((t) => (!allow || allow.has(t.name)) && !deny.has(t.name));
}

/**
 * Claude Code defers MCP tool definitions by default (tool search): only the tool name is in context until the
 * tool is used. A tool whose `_meta["anthropic/alwaysLoad"]` is true loads upfront unless the server's config sets
 * `alwaysLoad: false`; `alwaysLoad: true` in the config loads every tool of the server upfront.
 */
export function defersTool(s: McpServer, t: McpToolDef): boolean {
  if (s.tool !== 'claude-code' || s.alwaysLoad === true) return false;
  return s.alwaysLoad === false || t._meta?.['anthropic/alwaysLoad'] !== true;
}

export const DEFERRED_NOTE =
  'Claude Code defers MCP tool definitions by default (tool search): only tool names and server instructions load every turn; full definitions load when a tool is used. Tools marked _meta["anthropic/alwaysLoad"] and servers with alwaysLoad: true load upfront, and ENABLE_TOOL_SEARCH=false loads every tool upfront.';

/**
 * Agents whose docs say a server's `instructions` (from initialize) reach the model, with the cut in characters.
 * Claude Code loads them at session start and cuts them at 4,096; Gemini CLI appends them to the system
 * instructions; Codex uses them as guidance alongside the tools; Kilo Code adds them to the model context.
 * No cut is documented for the last three.
 */
const INSTRUCTIONS_CUT: Partial<Record<ToolId, number>> = {
  'claude-code': 4096,
  'gemini-cli': Infinity,
  codex: Infinity,
  'kilo-code': Infinity,
};

export const INSTRUCTIONS_NOTE =
  'MCP server instructions are counted for Claude Code (cut at 4,096 characters), Gemini CLI, Codex and Kilo Code, whose docs say they reach the model.';

/** The part of a server's instructions this agent puts in context; '' when its docs do not say it sends them. */
export function instructionsText(s: McpServer, instructions: string | undefined): string {
  const cut = INSTRUCTIONS_CUT[s.tool];
  return cut === undefined || !instructions ? '' : instructions.slice(0, cut);
}

/**
 * Characters of a tool description the agent keeps: Claude Code cuts the description of a tool that loads upfront
 * at 4,096 and of one it loads through tool search at 16,384. No other agent documents a cut.
 */
export function descriptionCut(s: McpServer, deferred: boolean): number | undefined {
  if (s.tool !== 'claude-code') return undefined;
  return deferred ? 16_384 : 4096;
}

/** Tool names only, as listed when definitions are deferred. */
export function toolNamesText(tools: McpToolDef[]): string {
  return tools.map((t) => t.name).join('\n');
}

/** The text an agent receives for a server's tools, as one JSON document per tool; descriptions cut at `maxDescription`. */
export function toolDefinitionsText(tools: McpToolDef[], maxDescription?: number): string {
  return tools
    .map((t) => JSON.stringify({ name: t.name, description: (t.description ?? '').slice(0, maxDescription), input_schema: t.inputSchema ?? {} }))
    .join('\n');
}
