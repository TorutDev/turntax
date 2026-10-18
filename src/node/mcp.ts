import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { McpServer, McpToolDef } from '../core/mcp.js';

/**
 * Starts MCP servers and asks them for their instructions and tool definitions (initialize + tools/list).
 * Runs only with --mcp: stdio servers execute the command from the config file. Streamable HTTP is spoken;
 * legacy SSE and WebSocket servers are listed but not measured.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'turntax', version: '0' };

export interface MeasureResult {
  tools?: McpToolDef[];
  /** The `instructions` the server returned from initialize. */
  instructions?: string;
  error?: string;
}

/**
 * Expands `${VAR}`, `${VAR:-default}`, `${env:VAR}`, OpenCode/Kilo `{env:VAR}` and `${workspaceFolder}` (the repository
 * folder, as Cursor, VS Code and Augment define it); returns null when a VS Code `${input:...}` is needed.
 */
export function expandVars(value: string, env: NodeJS.ProcessEnv, root = ''): string | null {
  if (/\$\{input:[^}]+\}/.test(value)) return null;
  return value
    .replace(/\$\{(env:)?([A-Za-z_][\w]*)(?::-([^}]*))?\}/g, (_, prefix: string | undefined, name: string, fallback?: string) =>
      !prefix && name === 'workspaceFolder' ? root : (env[name] ?? fallback ?? ''),
    )
    .replace(/\{env:([A-Za-z_][\w]*)\}/g, (_, name: string) => env[name] ?? '');
}

function expandAll(server: McpServer, env: NodeJS.ProcessEnv, root: string): McpServer | string {
  const one = (v: string | undefined) => (v === undefined ? undefined : expandVars(v, env, root));
  const many = (vs: string[] | undefined) => vs?.map((v) => expandVars(v, env, root));
  const map = (m: Record<string, string> | undefined) =>
    m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, expandVars(v, env, root)])) : undefined;
  const out = { ...server, command: one(server.command), args: many(server.args), env: map(server.env), url: one(server.url), headers: map(server.headers) };
  const values = [out.command, ...(out.args ?? []), ...Object.values(out.env ?? {}), out.url, ...Object.values(out.headers ?? {})];
  if (values.some((v) => v === null)) return 'needs a value VS Code prompts for (${input:...}); not measured';
  return out as McpServer;
}

export async function measureServer(
  server: McpServer,
  opts: { root: string; timeoutMs: number; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch },
): Promise<MeasureResult> {
  if (server.transport === 'sse') return { error: 'legacy SSE transport is not supported; not measured' };
  if (server.transport === 'ws') return { error: 'WebSocket transport is not supported; not measured' };
  const expanded = expandAll(server, opts.env ?? process.env, opts.root);
  if (typeof expanded === 'string') return { error: expanded };
  try {
    if (expanded.transport === 'stdio') return await viaStdio(expanded, opts.root, opts.timeoutMs, opts.env ?? process.env);
    return await viaHttp(expanded, opts.timeoutMs, opts.fetchFn ?? fetch);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

type Rpc = (method: string, params?: unknown) => Promise<any>;
type Listed = { tools: McpToolDef[]; instructions?: string };

async function listTools(rpc: Rpc, notify: (method: string) => Promise<void>): Promise<Listed> {
  const init = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
  await notify('notifications/initialized');
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await rpc('tools/list', cursor ? { cursor } : {});
    for (const t of r?.tools ?? [])
      tools.push({
        name: String(t.name),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t._meta && typeof t._meta === 'object' ? { _meta: t._meta } : {}),
      });
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return { tools, ...(typeof init?.instructions === 'string' ? { instructions: init.instructions } : {}) };
}

function viaStdio(server: McpServer, root: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<Listed> {
  if (!server.command) return Promise.reject(new Error('no command in the config'));
  const cwd = server.cwd ? (isAbsolute(server.cwd) ? server.cwd : resolve(root, server.cwd)) : root;
  // npx and similar launchers are .cmd shims on Windows, which only start through the shell.
  const windows = process.platform === 'win32';
  const child = windows
    ? spawn([server.command, ...(server.args ?? [])].map(cmdQuote).join(' '), { cwd, env: { ...env, ...server.env }, shell: true, windowsHide: true })
    : spawn(server.command, server.args ?? [], { cwd, env: { ...env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let failed: Error | null = null;
  const failAll = (e: Error) => {
    failed ??= e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Servers sometimes log to stdout; skip non-JSON lines.
      }
      const p = typeof msg?.id === 'number' ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`server error: ${msg.error.message ?? 'unknown'}`));
      else p.resolve(msg.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s: string) => (stderr = (stderr + s).slice(-500)));
  child.on('error', (e) => failAll(new Error(`could not start "${server.command}": ${e.message}`)));
  child.on('exit', (code) => failAll(new Error(`exited with code ${code} before answering${stderr.trim() ? `: ${lastLine(stderr)}` : ''}`)));

  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
  const rpc: Rpc = (method, params) =>
    failed
      ? Promise.reject(failed)
      : new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          send({ jsonrpc: '2.0', id, method, params });
        });
  const notify = async (method: string) => void send({ jsonrpc: '2.0', method });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([listTools(rpc, notify), timeout]).finally(() => {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.on('error', () => {});
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    // On Windows the server runs under cmd.exe; end the whole process tree, not just the shell. cmd.exe exits only
    // after the server, so an exited shell needs no taskkill (and its process id may belong to another process now).
    if (!windows || !child.pid) child.kill();
    else if (child.exitCode === null) return killTree(child.pid);
  });
}

/**
 * Runs taskkill on a process tree and waits for it (at most a few seconds). Windows ends the children of a Node
 * process when it exits, but not their children: exiting before taskkill finishes leaves the server running.
 */
function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    const end = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(end, 5000);
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', end).on('exit', end);
  });
}

/** Quotes one argument for cmd.exe so spaces, quotes and characters such as > & ( ) reach the program unchanged. */
export function cmdQuote(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

/** The most useful stderr line: the first that names an error, else the last. */
function lastLine(s: string): string {
  const lines = s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|not found|cannot|denied/i.test(l)) ?? lines.at(-1) ?? '').slice(0, 200);
}

async function viaHttp(server: McpServer, timeoutMs: number, fetchFn: typeof fetch): Promise<Listed> {
  const url = server.url!;
  let session: string | undefined;
  let nextId = 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const post = async (body: unknown) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(session ? { 'mcp-session-id': session } : {}),
        ...server.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (needs authorization)' : ''}`);
    session = res.headers.get('mcp-session-id') ?? session;
    return res;
  };
  const rpc: Rpc = async (method, params) => {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const type = res.headers.get('content-type') ?? '';
    const messages = type.includes('text/event-stream') ? sseMessages(await res.text()) : [await res.json()];
    const msg = messages.find((m: any) => m?.id === id);
    if (!msg) throw new Error(`no response to ${method}`);
    if (msg.error) throw new Error(`server error: ${msg.error.message ?? 'unknown'}`);
    return msg.result;
  };
  const notify = async (method: string) => void (await post({ jsonrpc: '2.0', method }));
  try {
    return await listTools(rpc, notify);
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-RPC messages from the `data:` lines of a server-sent event stream. */
export function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Ignore keep-alive and non-JSON events.
    }
  }
  return out;
}
