/**
 * What the extension's main thread shows, kept free of the vscode API so it can be unit tested. It must not
 * load the engine (render.ts, fix.ts and audit.ts at runtime pull in the tokenizer): engine.ts makes the
 * views in the worker, and this module only reads them.
 */
import type { AdviceKind } from '../../src/core/advice.js';
import type { FileRow } from '../../src/core/audit.js';
import { isInstructionFile, isSkippedDir } from '../../src/core/files.js';
import type { FileChange, FixKind, FixPlan } from '../../src/core/fix.js';
import { fmtTokens } from '../../src/core/format.js';
import { globMatcher } from '../../src/core/glob.js';
import { isMcpConfigFile } from '../../src/core/mcp.js';
import { TOOLS } from '../../src/core/tools.js';
import type { LoadMode, ToolId } from '../../src/core/types.js';
import { CONFIG_FILE } from '../../src/node/config.js';

export interface StatusView {
  text: string;
  tooltip: string;
}

export interface DiagnosticData {
  /** Repository-relative path. */
  path: string;
  /** 1-based. */
  line: number;
  severity: 'warning' | 'information';
  /** Absent for config files that could not be parsed. */
  kind?: AdviceKind;
  message: string;
}

/** The parts of a report row the main thread keeps. */
export type LensRow = Pick<FileRow, 'tool' | 'path' | 'part' | 'mode' | 'o200k' | 'importedFrom'>;

/** An audit as the worker sends it: plain data, made by engine.ts. */
export interface AuditView {
  /** Agents in the report; 0 when no agent instruction files were found. */
  agents: number;
  /** Undefined when no agent loads anything. */
  status?: StatusView;
  diagnostics: DiagnosticData[];
  /** The report for the Markdown preview. */
  markdown: string;
  /** Every report row: the files the report read, and how each agent loads them. */
  files: LensRow[];
  /** The `ignore` globs of turntax.config.json. */
  ignore: string[];
}

/** The advice kinds `--fix` handles. A Record, so a new fix kind does not compile until it is listed here. */
const FIXABLE: Record<FixKind, true> = { duplicate: true, 'scopable-section': true, 'oversized-section': true, misconfigured: true };

export const isFixable = (kind: string | undefined): boolean => kind !== undefined && Object.hasOwn(FIXABLE, kind);

/** True when a folder on `path` is one the audit never searches, such as node_modules. */
function inSkippedDir(path: string): boolean {
  const dirs = path.split('/').slice(0, -1);
  return dirs.some((_, i) => isSkippedDir(dirs.slice(0, i + 1).join('/')));
}

/**
 * True when a change to `path` (repository-relative) can change the report: instruction files, project
 * MCP configs, turntax.config.json, package.json (its scripts are checked), and files or folders the last
 * report read (such as @imports).
 */
export function affectsAudit(path: string, known: Iterable<string>): boolean {
  // Files the report read come first: an @import can point into a folder the search skips (build/, vendor/).
  for (const k of known) if (k === path || k.startsWith(`${path}/`)) return true;
  if (inSkippedDir(path)) return false;
  return isInstructionFile(path) || isMcpConfigFile(path) || path === CONFIG_FILE || path === 'package.json';
}

/** True when a new plan would make exactly the previewed changes. */
export const samePlan = (a: FixPlan, b: FixPlan): boolean => JSON.stringify(a.changes) === JSON.stringify(b.changes);

/** "Nothing to fix automatically.", with the first reason a fix was skipped. */
export function nothingToFix(plan: FixPlan): string {
  const first = plan.skipped[0];
  const more = plan.skipped.length > 1 ? ` (+${plan.skipped.length - 1} more; run npx turntax --fix for all)` : '';
  return first ? `Nothing to fix automatically. Skipped: ${first.reason}${more}` : 'Nothing to fix automatically.';
}

/** "2 safe fixes (saves ~150 o200k tokens/turn)", as in the pull request comment. */
export function fixSummary(plan: FixPlan): string {
  const n = plan.fixes.length;
  const saving = plan.fixes.reduce((a, f) => a + (f.savingTokens ?? 0), 0);
  return `${n} safe ${n === 1 ? 'fix' : 'fixes'}${saving ? ` (saves ~${fmtTokens(saving)} o200k tokens/turn)` : ''}`;
}

export function diffTitle(c: FileChange): string {
  if (c.renamedFrom) return `${c.renamedFrom} → ${c.path} (turntax fix)`;
  return c.before === null ? `${c.path} (new file, turntax fix)` : `${c.path} (turntax fix)`;
}

export interface LensView {
  title: string;
  tooltip: string;
}

const NOBODY = 'turntax: no agent reads this file';

/** Strongest first. */
const MODES: Array<{ mode: LoadMode; title: string; label: string }> = [
  { mode: 'always', title: 'every turn in', label: 'Every turn' },
  { mode: 'on-demand', title: 'on demand in', label: 'On demand' },
  { mode: 'manual', title: 'when referenced in', label: 'When referenced' },
  { mode: 'ignored', title: 'not read by', label: 'Not read' },
];

const rank = (mode: LoadMode) => MODES.findIndex((m) => m.mode === mode);
const toolName = (id: ToolId) => TOOLS.find((t) => t.id === id)?.name ?? id;

/** "Cursor, Devin (219 tokens); Claude Code (203 tokens)": the agents of `rows`, grouped by what they load, largest first. */
function loads(rows: LensRow[]): string {
  const groups = new Map<string, { o200k: number; names: Set<string> }>();
  for (const r of rows) {
    const extra = [...(r.part === 'full' ? [] : [r.part]), ...(r.importedFrom ? [`imported by ${r.importedFrom}`] : [])];
    const detail = [`${fmtTokens(r.o200k)} tokens`, ...extra].join(', ');
    const group = groups.get(detail) ?? groups.set(detail, { o200k: r.o200k, names: new Set() }).get(detail)!;
    group.names.add(toolName(r.tool));
  }
  return [...groups]
    .sort(([, a], [, b]) => b.o200k - a.o200k)
    .map(([detail, g]) => `${[...g.names].join(', ')} (${detail})`)
    .join('; ');
}

/**
 * The CodeLens at the top of `path` (repository-relative): how the agents of the last audit load it, such as
 * "turntax: 272 tokens every turn in 8 agents · on demand in 3 · not read by 2". Each agent counts once, under
 * the strongest mode it loads any part of the file in; the count is the largest always-loaded row. The tooltip
 * has a line per mode. Undefined for files that are neither in the report nor instruction files the audit reads.
 */
export function codeLensView(path: string, audit: Pick<AuditView, 'files' | 'ignore'>): LensView | undefined {
  const rows = audit.files.filter((r) => r.path === path);
  if (!rows.length) {
    if (!isInstructionFile(path) || inSkippedDir(path)) return undefined;
    if (globMatcher(audit.ignore)(path))
      return { title: `turntax: left out by ${CONFIG_FILE}`, tooltip: `The "ignore" list in ${CONFIG_FILE} leaves this file out of the report.` };
    return { title: NOBODY, tooltip: 'No agent in the report reads this file.' };
  }
  const strongest = new Map<ToolId, LoadMode>();
  for (const r of rows) if (!strongest.has(r.tool) || rank(r.mode) < rank(strongest.get(r.tool)!)) strongest.set(r.tool, r.mode);
  const tooltip = MODES.flatMap(({ mode, label }) => {
    // An agent that reads a part of the file is not listed for the part it ignores.
    const inMode = rows.filter((r) => (mode === 'ignored' ? strongest.get(r.tool) === 'ignored' : r.mode === mode));
    if (!inMode.length) return [];
    return [`${label}: ${mode === 'ignored' ? [...new Set(inMode.map((r) => toolName(r.tool)))].join(', ') : loads(inMode)}`];
  });
  const parts = MODES.map((m) => ({ ...m, n: [...strongest.values()].filter((s) => s === m.mode).length })).filter((p) => p.n > 0);
  if (parts[0]!.mode === 'ignored') return { title: NOBODY, tooltip: tooltip.join('\n') };
  const always = Math.max(...rows.filter((r) => r.mode === 'always').map((r) => r.o200k));
  const summary = parts.map(({ mode, title, n }, i) => {
    const tokens = mode === 'always' ? `${fmtTokens(always)} tokens ` : '';
    return `${tokens}${title} ${n}${i === 0 ? (n === 1 ? ' agent' : ' agents') : ''}`;
  });
  return { title: `turntax: ${summary.join(' · ')}`, tooltip: [...tooltip, 'Counts are o200k_base estimates, made offline.'].join('\n') };
}
