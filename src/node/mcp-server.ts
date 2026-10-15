import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { audit } from '../core/audit.js';
import { unifiedDiff } from '../core/fix.js';
import { globMatcher } from '../core/glob.js';
import { parseMcpConfigs } from '../core/mcp.js';
import { DEFAULT_MODEL_IDS, MODELS } from '../core/prices.js';
import { renderText } from '../core/render.js';
import { TOOL_IDS } from '../core/tools.js';
import type { ToolId } from '../core/types.js';
import { loadConfig } from './config.js';
import { discover, discoverMcpConfigs, existsIn, packageScripts } from './discover.js';
import { fixLines, fixPlan } from './fix-plan.js';

/**
 * `turntax mcp`: turntax as a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 * It speaks the revisions that start with an initialize handshake; a client that also speaks 2026-07-28
 * probes with server/discover, gets "method not found" and falls back to initialize, as that revision specifies.
 * Both tools are read-only: they never write files, start MCP servers or call vendor APIs.
 */

const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const LATEST_PROTOCOL = '2025-11-25';
/** Supported protocol revisions, newest first. */
export const PROTOCOL_VERSIONS: string[] = [LATEST_PROTOCOL, '2025-06-18', '2025-03-26', '2024-11-05'];

const HELP = `turntax mcp
Runs turntax as an MCP (Model Context Protocol) server over stdio, so coding agents can measure their own
context tax.

Tools (read-only: they never write files, start MCP servers or call vendor APIs):
  audit         Per-turn token cost of the instruction files and MCP servers, per agent, with advice
                Arguments: path, tools, models
  fix_preview   The safe fixes of turntax --fix as a unified diff, without applying them
                Arguments: path, tools

path defaults to the project folder (CLAUDE_PROJECT_DIR) or else the folder the server starts in. A
turntax.config.json in the audited folder applies as on the command line; arguments override it.

Add it to Claude Code:
  claude mcp add turntax -- npx -y turntax mcp

Or add it to .mcp.json (Claude Code), .cursor/mcp.json (Cursor) or another client's mcpServers map:
  {
    "mcpServers": {
      "turntax": { "command": "npx", "args": ["-y", "turntax", "mcp"] }
    }
  }

Or install the Claude Code plugin, which adds the server and the /turntax:context-tax command:
  /plugin marketplace add TorutDev/turntax
  /plugin install turntax@turntax
`;

const MODEL_IDS = MODELS.map((m) => m.id);
const PATH_ARG = { type: 'string', description: 'Folder to audit (default: the project folder). Its turntax.config.json applies.' };

/** Tool definitions. Agents may send them with every turn, so the descriptions stay short. */
export const TOOLS = [
  {
    name: 'audit',
    title: 'Audit context tax',
    description:
      'Per-turn token cost of the coding-agent instruction files (AGENTS.md, CLAUDE.md, Cursor rules, ...) and MCP servers in a folder, per agent, with advice. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        tools: { type: 'array', items: { type: 'string', enum: TOOL_IDS }, description: 'Agents to report (default: agents with files).' },
        models: {
          type: 'array',
          items: { type: 'string', enum: MODEL_IDS },
          description: `Models to price (default: ${DEFAULT_MODEL_IDS.join(', ')}).`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'fix_preview',
    title: 'Preview safe fixes',
    description:
      'Unified diff of the safe fixes turntax --fix would make: duplicate lines, sections that can load only in their folder, misnamed Cursor rules. Every agent keeps reading the moved text. Read-only: nothing is applied.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        tools: { type: 'array', items: { type: 'string', enum: TOOL_IDS }, description: 'Agents whose context must be kept (default: all).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type Id = string | number;
type Obj = Record<string, unknown>;
export type RpcResponse = { jsonrpc: '2.0'; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number';
const result = (id: Id, value: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result: value });
const failure = (id: Id | null, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function runMcp(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let help: boolean | undefined;
  try {
    help = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } }).values.help;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (help) {
    process.stdout.write(HELP);
    return 0;
  }
  process.stderr.write(`turntax ${VERSION} MCP server on stdio\n`);
  await serve(process.stdin, process.stdout, env.CLAUDE_PROJECT_DIR || process.cwd());
  return 0;
}

/** Answers each line of `input` on `output`, one message at a time, until `input` ends. `cwd` is the default folder. */
export async function serve(input: Readable, output: Writable, cwd: string): Promise<void> {
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const response = await handleLine(line, cwd);
    if (response) output.write(JSON.stringify(response) + '\n');
  }
}

/** The response to one line, or undefined for blank lines, notifications and client responses. */
export async function handleLine(line: string, cwd: string): Promise<RpcResponse | undefined> {
  if (!line.trim()) return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return failure(null, -32700, 'Parse error');
  }
  // Batches (arrays) were dropped from MCP in 2025-06-18; they get Invalid Request like any non-object.
  if (!isObj(msg) || msg.jsonrpc !== '2.0') return failure(isObj(msg) && isId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
  if (typeof msg.method !== 'string') {
    // The server sends no requests, so a response from the client needs no answer.
    if (isId(msg.id) && ('result' in msg || 'error' in msg)) return undefined;
    return failure(isId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
  }
  // Notifications (notifications/initialized, notifications/cancelled, ...) get no answer.
  if (!('id' in msg)) return undefined;
  if (!isId(msg.id)) return failure(null, -32600, 'Invalid Request: id must be a string or a number');
  const id = msg.id;
  const params = msg.params ?? {};
  if (!isObj(params)) return failure(id, -32602, 'Invalid params: params must be an object');
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return result(id, {
        protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'turntax', version: VERSION },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(id, params, cwd);
    default:
      return failure(id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(id: Id, params: Obj, cwd: string): Promise<RpcResponse> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
  const raw = params.arguments ?? {};
  if (!isObj(raw)) return failure(id, -32602, 'Invalid params: arguments must be an object');
  try {
    const args = toolArgs(raw, Object.keys(tool.inputSchema.properties), cwd);
    const text = tool.name === 'audit' ? await auditText(args) : await fixPreviewText(args);
    return result(id, { content: [{ type: 'text', text }] });
  } catch (e) {
    // Bad arguments, missing folders and invalid configs are tool errors, so the agent can correct the call.
    return result(id, { content: [{ type: 'text', text: `turntax: ${(e as Error).message}` }], isError: true });
  }
}

interface ToolArgs {
  root: string;
  tools?: ToolId[];
  models?: string[];
}

function toolArgs(args: Obj, allowed: string[], cwd: string): ToolArgs {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unknown argument "${key}". Use: ${allowed.join(', ')}.`);
  if (args.path !== undefined && (typeof args.path !== 'string' || !args.path)) throw new Error('"path" must be a non-empty string.');
  const root = resolve(cwd, args.path ?? '.');
  const stat = statSync(root, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Folder not found: ${root}`);
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${root}`);
  return { root, tools: ids(args.tools, 'tool', TOOL_IDS) as ToolId[] | undefined, models: ids(args.models, 'model', MODEL_IDS) };
}

/** A non-empty list of known ids, or undefined when the argument is absent. */
function ids(value: unknown, kind: string, known: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === 'string'))
    throw new Error(`"${kind}s" must be a non-empty array of ${kind} ids.`);
  for (const v of value) if (!known.includes(v)) throw new Error(`Unknown ${kind} "${v}". Use: ${known.join(', ')}`);
  return value;
}

/** The report `turntax <root>` prints, set up as the CLI does without flags: config, ignored files, project MCP configs. */
async function auditText({ root, tools, models }: ToolArgs): Promise<string> {
  const config = loadConfig(root, undefined, MODELS);
  const ignored = globMatcher(config.ignore ?? []);
  const files = (await discover(root)).filter((f) => !ignored(f.path));
  const mcp = parseMcpConfigs(discoverMcpConfigs(root), root);
  const report = await audit(files, {
    tools: tools ?? config.tools,
    models: (models ?? config.models ?? DEFAULT_MODEL_IDS).flatMap((id) => MODELS.filter((m) => m.id === id)),
    turns: config.turns ?? 100,
    mcp: { servers: mcp.servers },
    advice: { exists: existsIn(root), packageScripts: packageScripts(root), sectionTokens: config.sectionTokens ?? 600 },
  });
  return [...mcp.problems.map((p) => `turntax: ${p.path} ${p.message}`), renderText(report, root)].join('\n');
}

/** The fix plan as `turntax --fix` prints it: fixes, skipped fixes, then the diff. */
async function fixPreviewText({ root, tools }: ToolArgs): Promise<string> {
  const config = loadConfig(root, undefined, MODELS);
  const plan = fixPlan(root, await discover(root), tools ?? config.tools, globMatcher(config.ignore ?? []), config.sectionTokens);
  const lines = fixLines(plan);
  if (!plan.changes.length) return [...lines, 'Nothing to fix automatically.'].join('\n');
  const command = `npx turntax${tools ? ` --tools ${tools.join(',')}` : ''} --fix --write`;
  return [
    ...lines,
    '',
    // Only the final newline goes: a CRLF file's last diff line keeps its \r, so the saved diff still applies.
    unifiedDiff(plan.changes).replace(/\n$/, ''),
    '',
    `Preview only; nothing was changed. To apply, run \`${command}\` in ${root}, or save the diff and use git apply.`,
  ].join('\n');
}
