import { buildAdvice, type Advice, type AdviceOptions } from './advice.js';
import { classify, detectTools } from './classify.js';
import { countO200k, offlineCounter } from './tokenize.js';
import { TOOLS } from './tools.js';
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
}

export interface FileRow {
  tool: ToolId;
  path: string;
  part: LoadedUnit['part'];
  mode: LoadedUnit['mode'];
  trigger: string;
  importedFrom?: string;
  notes: string[];
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
  /** o200k reference tokens of always-loaded content. */
  perTurnO200k: number;
  onDemandO200k: number;
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
  const allUnits = classify(files);
  const toolIds = opts.tools ?? detectTools(allUnits);
  const units = allUnits.filter((u) => toolIds.includes(u.tool));

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
    const onDemand = rows.filter((r) => r.mode === 'on-demand');
    const models = modelsForTool(id, opts.models).map((m) => modelCost(m, always, turns));
    return {
      tool: id,
      name: spec.name,
      alwaysFiles: new Set(always.map((r) => r.path)).size,
      onDemandFiles: new Set(onDemand.map((r) => r.path)).size,
      perTurnO200k: sum(always.map((r) => r.o200k)),
      onDemandO200k: sum(onDemand.map((r) => r.o200k)),
      models,
      notes: spec.notes,
      sources: spec.sources,
    };
  });

  return { turns, tools, files: files_, advice: buildAdvice(units, files, opts.advice), models: opts.models };
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
  // Nothing always loaded: the cost is zero whichever counter would have been used.
  const method = counts[0]?.method ?? 'offline-exact';
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
