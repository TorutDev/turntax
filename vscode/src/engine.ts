/**
 * The views of an audit, made in the worker (worker.ts): they need the engine and its tokenizer, which the
 * extension's main thread does not load. Free of the vscode API so it can be unit tested.
 */
import type { Report } from '../../src/core/audit.js';
import { MODELS } from '../../src/core/prices.js';
import { fmtTokens, groupTools, headlineTokens, renderMarkdown } from '../../src/core/render.js';
import { loadConfig } from '../../src/node/config.js';
import { auditWorkspace, type WorkspaceAudit } from '../../src/node/workspace.js';
import type { AuditView, DiagnosticData, StatusView } from './view.js';

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

/**
 * The report for the Markdown preview, which loads remote images: no shields.io badge, and text quoted from
 * the repository (headings, lines, server names) cannot add an image or HTML either.
 */
export const reportMarkdown = (report: Report): string =>
  renderMarkdown(report, { badge: false }).replace(/!\[/g, '!\\[').replace(/</g, '&lt;');

/** The worker's audit job: `root` audited as `turntax <root>` does, and what the extension shows for it. */
export async function auditFolder(root: string): Promise<AuditView> {
  const audit = await auditWorkspace(root);
  const { report } = audit;
  return {
    agents: report.tools.length,
    status: statusView(report),
    diagnostics: diagnosticsFrom(audit),
    markdown: reportMarkdown(report),
    files: report.files.map(({ tool, path, part, mode, o200k, importedFrom }) => ({ tool, path, part, mode, o200k, ...(importedFrom ? { importedFrom } : {}) })),
    // auditWorkspace has read and checked the config already.
    ignore: loadConfig(root, undefined, MODELS).ignore ?? [],
  };
}
