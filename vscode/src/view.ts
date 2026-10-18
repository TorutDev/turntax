/** What the extension shows for a report, kept free of the vscode API so it can be unit tested. */
import type { AdviceKind } from '../../src/core/advice.js';
import type { Report } from '../../src/core/audit.js';
import { isInstructionFile, isSkippedDir } from '../../src/core/files.js';
import type { FileChange, FixKind, FixPlan } from '../../src/core/fix.js';
import { isMcpConfigFile } from '../../src/core/mcp.js';
import { fmtTokens, groupTools, headlineTokens, renderMarkdown } from '../../src/core/render.js';
import { CONFIG_FILE } from '../../src/node/config.js';
import type { WorkspaceAudit } from '../../src/node/workspace.js';

export interface StatusView {
  text: string;
  tooltip: string;
}

/** Status bar text (the CLI badge's number) and a tooltip line per agent group; undefined when no agent loads anything. */
export function statusView(report: Report): StatusView | undefined {
  if (!report.files.some((f) => f.mode !== 'ignored') && !report.tools.some((t) => t.mcpServers > 0)) return undefined;
  const lines = groupTools(report).map(({ names, tool: t }) => {
    const unmeasured = t.mcpServers && !t.mcpMeasured ? ` + ${t.mcpServers} MCP server${t.mcpServers === 1 ? '' : 's'} not measured` : '';
    return `${names.join(', ')}: ${fmtTokens(t.perTurnO200k + t.mcpPerTurnO200k)} tokens/turn${unmeasured}`;
  });
  return {
    text: `$(dashboard) ${fmtTokens(headlineTokens(report))} tok/turn`,
    tooltip: [...lines, 'Counts are o200k_base estimates, made offline.'].join('\n'),
  };
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

/**
 * One diagnostic per advice item on a repository file, placed as the GitHub Action annotations are
 * (`renderAnnotations`), plus one per MCP config that could not be parsed. User-level files are skipped.
 */
export function diagnosticsFrom({ report, problems }: WorkspaceAudit): DiagnosticData[] {
  const advice = report.advice.flatMap((a): DiagnosticData[] => {
    const path = a.paths.find((p) => !p.startsWith('~'));
    if (!path) return [];
    const saving = a.savingTokens ? ` (saves ~${fmtTokens(a.savingTokens)} tokens/turn)` : '';
    // `line` belongs to the first path.
    const line = a.line && path === a.paths[0] ? a.line : 1;
    return [{ path, line, severity: a.severity === 'low' ? 'information' : 'warning', kind: a.kind, message: a.message + saving }];
  });
  const unparsed = problems.map((p): DiagnosticData => ({ path: p.path, line: 1, severity: 'warning', message: p.message }));
  return [...advice, ...unparsed];
}

/** The advice kinds `--fix` handles. A Record, so a new fix kind does not compile until it is listed here. */
const FIXABLE: Record<FixKind, true> = { duplicate: true, 'scopable-section': true, 'oversized-section': true, misconfigured: true };

export const isFixable = (kind: string | undefined): boolean => kind !== undefined && Object.hasOwn(FIXABLE, kind);

/**
 * True when a change to `path` (repository-relative) can change the report: instruction files, project
 * MCP configs, turntax.config.json, package.json (its scripts are checked), and files or folders the last
 * report read (such as @imports).
 */
export function affectsAudit(path: string, known: Iterable<string>): boolean {
  for (const k of known) if (k === path || k.startsWith(`${path}/`)) return true;
  const dirs = path.split('/').slice(0, -1);
  if (dirs.some((_, i) => isSkippedDir(dirs.slice(0, i + 1).join('/')))) return false;
  return isInstructionFile(path) || isMcpConfigFile(path) || path === CONFIG_FILE || path === 'package.json';
}

/**
 * The report for the Markdown preview, which loads remote images: no shields.io badge, and text quoted from
 * the repository (headings, lines, server names) cannot add an image or HTML either.
 */
export const reportMarkdown = (report: Report): string =>
  renderMarkdown(report, { badge: false }).replace(/!\[/g, '!\\[').replace(/</g, '&lt;');

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
