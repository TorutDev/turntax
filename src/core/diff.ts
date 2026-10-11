/**
 * Compares two reports: how much each agent's per-turn cost changed, and which always-loaded files caused it.
 * Only repository instruction files are compared (o200k reference counts), so the result does not depend
 * on API keys, user-level files or whether MCP servers were measured.
 */
import type { Report } from './audit.js';
import type { ToolId } from './types.js';

/** The parts of a report a diff needs. Older JSON reports (0.1, 0.2) have the same fields. */
export interface DiffInput {
  tools: Array<{ tool: ToolId; name: string; perTurnO200k: number }>;
  files: Array<{ tool: ToolId; path: string; part: string; mode: string; o200k: number; scope?: 'user' }>;
  mcp?: Array<{ name: string; tool: ToolId; scope: string; status: string }>;
}

export interface ToolDelta {
  tool: ToolId;
  name: string;
  /** null when the agent read no files in that report. */
  before: number | null;
  after: number | null;
  delta: number;
}

export interface FileDelta {
  path: string;
  part: string;
  before: number | null;
  after: number | null;
  delta: number;
  /** Agents that load this file every turn, in either report. */
  tools: ToolId[];
}

export interface ReportDiff {
  /** What the report was compared with: a file name or a git ref. */
  base: string;
  tools: ToolDelta[];
  /** Always-loaded files that were added, removed or changed size. */
  files: FileDelta[];
  mcp: { added: string[]; removed: string[] };
}

export function diffReports(before: DiffInput, after: DiffInput, base: string): ReportDiff {
  const ids = [...new Set([...after.tools.map((t) => t.tool), ...before.tools.map((t) => t.tool)])];
  const tools: ToolDelta[] = ids.map((id) => {
    const a = after.tools.find((t) => t.tool === id);
    const b = before.tools.find((t) => t.tool === id);
    const av = a?.perTurnO200k ?? null;
    const bv = b?.perTurnO200k ?? null;
    return { tool: id, name: (a ?? b)!.name, before: bv, after: av, delta: (av ?? 0) - (bv ?? 0) };
  });

  const alwaysFiles = (r: DiffInput) => {
    const m = new Map<string, { path: string; part: string; o200k: number; tools: Set<ToolId> }>();
    for (const f of r.files) {
      if (f.mode !== 'always' || f.scope === 'user') continue;
      const key = `${f.path}\0${f.part}`;
      const prev = m.get(key);
      if (prev) prev.tools.add(f.tool);
      else m.set(key, { path: f.path, part: f.part, o200k: f.o200k, tools: new Set([f.tool]) });
    }
    return m;
  };
  const bf = alwaysFiles(before);
  const af = alwaysFiles(after);
  const files: FileDelta[] = [];
  for (const key of new Set([...bf.keys(), ...af.keys()])) {
    const b = bf.get(key);
    const a = af.get(key);
    const delta = (a?.o200k ?? 0) - (b?.o200k ?? 0);
    if (a && b && delta === 0) continue;
    files.push({
      path: (a ?? b)!.path,
      part: (a ?? b)!.part,
      before: b?.o200k ?? null,
      after: a?.o200k ?? null,
      delta,
      tools: [...new Set([...(b?.tools ?? []), ...(a?.tools ?? [])])],
    });
  }
  files.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.path.localeCompare(y.path));

  const servers = (r: DiffInput) =>
    new Set((r.mcp ?? []).filter((s) => s.scope === 'project' && s.status !== 'disabled').map((s) => `${s.name} (${s.tool})`));
  const bs = servers(before);
  const as = servers(after);
  return {
    base,
    tools,
    files,
    mcp: { added: [...as].filter((s) => !bs.has(s)), removed: [...bs].filter((s) => !as.has(s)) },
  };
}

/** Largest per-turn increase across agents (0 when nothing grew). */
export function maxIncrease(diff: ReportDiff): number {
  return Math.max(0, ...diff.tools.map((t) => t.delta));
}

/** Validates a parsed JSON report enough to diff against it. */
export function asDiffInput(data: unknown): DiffInput {
  const r = data as Partial<Report>;
  if (!r || !Array.isArray(r.tools) || !Array.isArray(r.files)) throw new Error('not a turntax --json report');
  return r as DiffInput;
}
