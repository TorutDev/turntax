import { buildAdvice, type Advice, type AdviceOptions } from './advice.js';
import { classify, detectTools } from './classify.js';
import type { ReportDiff } from './diff.js';
import {
  defersTool,
  descriptionCut,
  filterTools,
  instructionsText,
  serverKey,
  toolDefinitionsText,
  toolNamesText,
  type McpServer,
  type McpToolDef,
  type McpTransport,
} from './mcp.js';
import { countO200k, offlineCounter } from './tokenize.js';
import { TOOLS } from './tools.js';
import { classifyUser } from './user.js';
import type { Counter, LoadedUnit, ModelInfo, RepoFile, TokenCount, ToolId } from './types.js';

export interface AuditOptions {
  /** Tools to report. Defaults to every tool that reads at least one file. */
  tools?: ToolId[];
  models: ModelInfo[];
  /** Network counters, present only when the user opted in. */
  counters?: { claude?: Counter; gemini?: Counter };
  advice?: AdviceOptions;
  /** Turns used for the cost projection. */
  turns?: number;
  /** User-level files (paths start with `~/`), counted only when the user asks for them. */
  userFiles?: RepoFile[];
  /** MCP servers from the agents' config files, and tool definitions measured with --mcp (keyed by serverKey). */
  mcp?: { servers: McpServer[]; measured?: Map<string, McpMeasurement> };
}

/** What a server returned with --mcp: its tool definitions and initialize instructions, or why it was not measured. */
export type McpMeasurement = { tools: McpToolDef[]; instructions?: string } | { error: string };

export interface McpRow {
  name: string;
  tool: ToolId;
  configPath: string;
  scope: 'project' | 'user';
  transport: McpTransport;
  /**
   * not-measured - found in a config; tool definitions are counted only with --mcp
   * measured     - started and listed; `tools` and `o200k` are set
   * failed       - could not be measured; `error` says why
   * disabled     - turned off in the config, so the agent does not start it
   * overridden   - the agent uses the same server name from another config (`overriddenBy`) instead
   */
  status: 'not-measured' | 'measured' | 'failed' | 'disabled' | 'overridden';
  /** The config whose definition the agent uses instead, when `status` is 'overridden'. */
  overriddenBy?: string;
  /** Set when that precedence is not documented (MCP_CONFIGS order decided it). */
  overrideAssumed?: boolean;
  /** Tools that reach the agent, after the config's tool filters. */
  tools?: number;
  /** Tools the server lists that the config's tool filters keep out of context. */
  excludedTools?: number;
  /**
   * o200k reference tokens this server adds to every turn: the tool definitions (names, descriptions, input schemas
   * as JSON), only the names of tools the agent defers, and the server instructions when the agent sends them.
   */
  o200k?: number;
  /** Set when the agent defers some definitions (Claude Code tool search): how many, and their full size, loaded when a tool is used. */
  deferredTools?: number;
  deferredO200k?: number;
  /** Server instructions counted in `o200k`. */
  instructionsO200k?: number;
  error?: string;
  /** Something the config does not show that can change what the agent loads. */
  note?: string;
}

export interface FileRow {
  tool: ToolId;
  path: string;
  part: LoadedUnit['part'];
  mode: LoadedUnit['mode'];
  trigger: string;
  importedFrom?: string;
  notes: string[];
  /** 'user' for files in the home directory; absent for repository files. */
  scope?: 'user';
  /** Reference count with OpenAI o200k_base, for every file. */
  o200k: number;
  /** Per selected model that this tool runs. */
  counts: Record<string, TokenCount>;
}

export interface ModelCost {
  model: string;
  label: string;
  /** Tokens added to every turn by always-loaded content, or null when it could not be counted. */
  perTurn: number | null;
  method: TokenCount['method'];
  reason?: string;
  /** USD for `turns` turns with no prompt caching. */
  uncached: number | null;
  /** USD for `turns` turns when every turn reads the context from the prompt cache. */
  cached: number | null;
}

export interface ToolSummary {
  tool: ToolId;
  name: string;
  alwaysFiles: number;
  onDemandFiles: number;
  /** o200k reference tokens of always-loaded repository files. */
  perTurnO200k: number;
  onDemandO200k: number;
  /** User-level files (only with --include-user). */
  userAlwaysFiles: number;
  /** o200k tokens of always-loaded user-level files plus measured user-level MCP servers. */
  userPerTurnO200k: number;
  /** Enabled MCP servers this agent starts (project and user level). */
  mcpServers: number;
  /** o200k tokens of measured project MCP tool definitions; 0 when none were measured. */
  mcpPerTurnO200k: number;
  /** True when every enabled MCP server of this agent was measured. */
  mcpMeasured: boolean;
  /** Repository files + project MCP + user level: what this agent sends every turn, as far as measured. */
  totalPerTurnO200k: number;
  /** Per model: always-loaded files (repository and user level). MCP tool definitions are not priced. */
  models: ModelCost[];
  notes: string[];
  sources: string[];
}

export interface Report {
  turns: number;
  tools: ToolSummary[];
  files: FileRow[];
  advice: Advice[];
  models: ModelInfo[];
  /** MCP servers found in the agents' config files. */
  mcp: McpRow[];
  /** Set when the report was compared with a baseline (--baseline, --compare). */
  diff?: ReportDiff;
}

export function modelsForTool(tool: ToolId, models: ModelInfo[]): ModelInfo[] {
  const spec = TOOLS.find((t) => t.id === tool)!;
  return spec.families.length ? models.filter((m) => spec.families.includes(m.family)) : models;
}

function counterFor(model: ModelInfo, opts: AuditOptions): Counter {
  if (model.family === 'claude' && opts.counters?.claude) return opts.counters.claude;
  if (model.family === 'gemini' && opts.counters?.gemini) return opts.counters.gemini;
  return offlineCounter;
}

export async function audit(files: RepoFile[], opts: AuditOptions): Promise<Report> {
  const turns = opts.turns ?? 100;
  const allUnits = [...classify(files), ...classifyUser(opts.userFiles ?? [])];
  // MCP_CONFIGS can name an agent before TOOLS has its loading rules; such servers cannot be reported yet.
  const servers = (opts.mcp?.servers ?? []).filter((s) => TOOLS.some((t) => t.id === s.tool));
  const toolIds =
    opts.tools ??
    [...new Set([...detectTools(allUnits), ...servers.filter((s) => !s.disabled && !s.overriddenBy).map((s) => s.tool)])].sort(
      (a, b) => TOOLS.findIndex((t) => t.id === a) - TOOLS.findIndex((t) => t.id === b),
    );
  const units = allUnits.filter((u) => toolIds.includes(u.tool));
  const mcp = servers.filter((s) => toolIds.includes(s.tool)).map((s) => mcpRow(s, opts.mcp?.measured));

  // Count each distinct text once per model, only for the tools that run that model.
  const counts = new Map<string, Map<string, TokenCount>>();
  for (const model of opts.models) {
    const relevant = units.filter(
      (u) => u.mode !== 'ignored' && modelsForTool(u.tool, opts.models).some((m) => m.id === model.id),
    );
    const texts = [...new Set(relevant.map((u) => u.text))];
    const results = await counterFor(model, opts).count(model, texts);
    counts.set(model.id, new Map(texts.map((t, i) => [t, results[i]!])));
  }

  const files_: FileRow[] = units.map((u) => {
    const row: FileRow = {
      tool: u.tool,
      path: u.path,
      part: u.part,
      mode: u.mode,
      trigger: u.trigger,
      notes: u.notes,
      o200k: countO200k(u.text),
      counts: {},
    };
    if (u.importedFrom) row.importedFrom = u.importedFrom;
    if (u.scope) row.scope = u.scope;
    if (u.mode !== 'ignored')
      for (const m of modelsForTool(u.tool, opts.models)) {
        const c = counts.get(m.id)?.get(u.text);
        if (c) row.counts[m.id] = c;
      }
    return row;
  });

  const tools: ToolSummary[] = toolIds.map((id) => {
    const spec = TOOLS.find((t) => t.id === id)!;
    const rows = files_.filter((r) => r.tool === id);
    const always = rows.filter((r) => r.mode === 'always');
    const repoAlways = always.filter((r) => !r.scope);
    const userAlways = always.filter((r) => r.scope === 'user');
    const onDemand = rows.filter((r) => r.mode === 'on-demand' && !r.scope);
    const models = modelsForTool(id, opts.models).map((m) => modelCost(m, always, turns));
    const toolMcp = mcp.filter((r) => r.tool === id && r.status !== 'disabled' && r.status !== 'overridden');
    const mcpTokens = (scope: McpRow['scope']) => sum(toolMcp.filter((r) => r.scope === scope).map((r) => r.o200k ?? 0));
    const perTurnO200k = sum(repoAlways.map((r) => r.o200k));
    const userPerTurnO200k = sum(userAlways.map((r) => r.o200k)) + mcpTokens('user');
    const mcpPerTurnO200k = mcpTokens('project');
    return {
      tool: id,
      name: spec.name,
      alwaysFiles: new Set(repoAlways.map((r) => r.path)).size,
      onDemandFiles: new Set(onDemand.map((r) => r.path)).size,
      perTurnO200k,
      onDemandO200k: sum(onDemand.map((r) => r.o200k)),
      userAlwaysFiles: new Set(userAlways.map((r) => r.path)).size,
      userPerTurnO200k,
      mcpServers: toolMcp.length,
      mcpPerTurnO200k,
      mcpMeasured: toolMcp.every((r) => r.status === 'measured'),
      totalPerTurnO200k: perTurnO200k + mcpPerTurnO200k + userPerTurnO200k,
      models,
      notes: spec.notes,
      sources: spec.sources,
    };
  });

  const adviceFiles = [...files, ...(opts.userFiles ?? [])];
  return { turns, tools, files: files_, advice: buildAdvice(units, adviceFiles, opts.advice), models: opts.models, mcp };
}

function mcpRow(s: McpServer, measured?: Map<string, McpMeasurement>): McpRow {
  const row: McpRow = {
    name: s.name,
    tool: s.tool,
    configPath: s.configPath,
    scope: s.scope,
    transport: s.transport,
    status: 'not-measured',
    ...(s.note ? { note: s.note } : {}),
  };
  if (s.overriddenBy)
    return { ...row, status: 'overridden', overriddenBy: s.overriddenBy, ...(s.overrideAssumed ? { overrideAssumed: true } : {}) };
  if (s.disabled) return { ...row, status: 'disabled' };
  const m = measured?.get(serverKey(s));
  if (!m) return row;
  if ('error' in m) return { ...row, status: 'failed', error: m.error };
  // What this agent puts in context: the tools its config keeps, in full or (deferred) by name, and the instructions.
  const kept = filterTools(s, m.tools);
  const deferred = kept.filter((t) => defersTool(s, t));
  const upfront = kept.filter((t) => !defersTool(s, t));
  const instructionsO200k = countO200k(instructionsText(s, m.instructions));
  const o200k = countO200k(toolDefinitionsText(upfront, descriptionCut(s, false))) + countO200k(toolNamesText(deferred)) + instructionsO200k;
  return {
    ...row,
    status: 'measured',
    tools: kept.length,
    o200k,
    ...(kept.length < m.tools.length ? { excludedTools: m.tools.length - kept.length } : {}),
    ...(deferred.length
      ? { deferredTools: deferred.length, deferredO200k: countO200k(toolDefinitionsText(deferred, descriptionCut(s, true))) }
      : {}),
    ...(instructionsO200k ? { instructionsO200k } : {}),
  };
}

function modelCost(model: ModelInfo, always: FileRow[], turns: number): ModelCost {
  const counts = always.map((r) => r.counts[model.id]);
  const missing = counts.find((c) => c === undefined || c.tokens === null);
  if (counts.length && missing !== undefined) {
    return {
      model: model.id,
      label: model.label,
      perTurn: null,
      method: 'unavailable',
      reason: missing?.reason ?? 'not counted',
      uncached: null,
      cached: null,
    };
  }
  const perTurn = sum(counts.map((c) => c!.tokens!));
  const method = counts[0]?.method ?? 'none-loaded';
  const price = (p: number | null) => (p === null ? null : (perTurn * turns * p) / 1_000_000);
  return {
    model: model.id,
    label: model.label,
    perTurn,
    method,
    uncached: price(model.inputPerMTok),
    cached: price(model.cachedInputPerMTok),
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
