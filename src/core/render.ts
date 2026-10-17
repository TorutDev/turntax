import type { McpRow, Report, ToolSummary } from './audit.js';
import type { ReportDiff } from './diff.js';
import { unifiedDiff, type FixPlan } from './fix.js';
import { DEFERRED_NOTE, INSTRUCTIONS_NOTE } from './mcp.js';
import type { CountMethod } from './types.js';

export const METHOD_LABEL: Record<CountMethod, string> = {
  'offline-exact': 'exact (offline tokenizer)',
  'offline-proxy': 'estimate (o200k_base proxy)',
  api: 'vendor API count',
  unavailable: 'not counted',
  'none-loaded': 'nothing always loaded',
};

export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtUsd(n: number | null): string {
  if (n === null) return 'n/a';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function table(rows: string[][], indent = ''): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => indent + r.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd()).join('\n');
}

/**
 * Agents that load exactly the same files with the same results share one row,
 * so a repository with only AGENTS.md does not print a dozen identical lines.
 */
export function groupTools(report: Report): Array<{ names: string[]; tool: Report['tools'][number] }> {
  const groups = new Map<string, { names: string[]; tool: Report['tools'][number] }>();
  for (const t of report.tools) {
    const files = report.files
      .filter((f) => f.tool === t.tool && f.mode !== 'ignored')
      .map((f) => [f.path, f.part, f.mode, f.o200k])
      .sort();
    const key = JSON.stringify([
      files,
      t.models.map(({ model, perTurn, method, reason }) => [model, perTurn, method, reason]),
      report.mcp.filter((m) => m.tool === t.tool).map((m) => [m.configPath, m.name, m.status, m.o200k]),
    ]);
    const g = groups.get(key);
    if (g) g.names.push(t.name);
    else groups.set(key, { names: [t.name], tool: t });
  }
  return [...groups.values()];
}

/** File rows that are identical across agents, merged with the list of agents. */
export function groupFiles(report: Report): Array<{ file: Report['files'][number]; tools: string[] }> {
  const groups = new Map<string, { file: Report['files'][number]; tools: string[] }>();
  for (const f of report.files) {
    const key = JSON.stringify([f.path, f.part, f.mode, f.trigger, f.o200k, f.importedFrom ?? '']);
    const g = groups.get(key);
    if (g) g.tools.push(f.tool);
    else groups.set(key, { file: f, tools: [f.tool] });
  }
  return [...groups.values()];
}

/**
 * Highest per-turn o200k total across the reported tools, for the badge and --max-tokens:
 * repository files plus measured project MCP tool definitions. User-level files never count here.
 */
export function headlineTokens(report: Report): number {
  return Math.max(0, ...report.tools.map((t) => t.perTurnO200k + (t.mcpPerTurnO200k ?? 0)));
}

/** MCP cell: measured tokens, a "+" when some servers could not be measured, or how many are unmeasured. */
export function mcpCell(t: ToolSummary): string {
  if (!t.mcpServers) return '-';
  if (t.mcpMeasured) return fmtTokens(t.mcpPerTurnO200k);
  return t.mcpPerTurnO200k > 0 ? `${fmtTokens(t.mcpPerTurnO200k)}+` : `${t.mcpServers} not measured`;
}

function signed(n: number): string {
  return n > 0 ? `+${fmtTokens(n)}` : n < 0 ? `-${fmtTokens(-n)}` : '0';
}

function fmtMaybe(n: number | null): string {
  return n === null ? '-' : fmtTokens(n);
}

/** Agents with the same before/after numbers share one line. */
function groupDeltas(diff: ReportDiff): Array<{ names: string[]; before: number | null; after: number | null; delta: number }> {
  const groups = new Map<string, { names: string[]; before: number | null; after: number | null; delta: number }>();
  for (const t of diff.tools) {
    const key = `${t.before}|${t.after}`;
    const g = groups.get(key);
    if (g) g.names.push(t.name);
    else groups.set(key, { names: [t.name], before: t.before, after: t.after, delta: t.delta });
  }
  return [...groups.values()].sort((a, b) => b.delta - a.delta);
}

export function renderDiffText(diff: ReportDiff): string {
  const out = [`Change vs ${diff.base} (o200k tokens per turn, repository files)`];
  const changed = groupDeltas(diff).filter((g) => g.delta !== 0);
  if (!changed.length) out.push('  No change in per-turn tokens.');
  else {
    const rows = [['before', 'after', 'change', 'agents']];
    for (const g of changed) rows.push([fmtMaybe(g.before), fmtMaybe(g.after), signed(g.delta), g.names.join(', ')]);
    out.push(table(rows, '  '));
  }
  if (diff.files.length) {
    out.push('  Files loaded every turn');
    const rows = [['before', 'after', 'change', 'file']];
    for (const f of diff.files) rows.push([fmtMaybe(f.before), fmtMaybe(f.after), signed(f.delta), f.part === 'full' ? f.path : `${f.path} (${f.part})`]);
    out.push(table(rows, '    '));
  }
  for (const s of diff.mcp.added) out.push(`  MCP server added: ${s}`);
  for (const s of diff.mcp.removed) out.push(`  MCP server removed: ${s}`);
  return out.join('\n');
}

export function renderDiffMarkdown(diff: ReportDiff): string {
  const out = [`## Change vs \`${diff.base}\``, ''];
  const changed = groupDeltas(diff).filter((g) => g.delta !== 0);
  if (!changed.length) out.push('No change in per-turn tokens (o200k, repository files).');
  else {
    out.push('o200k tokens added to every turn by repository instruction files.', '');
    out.push('| Agents | Before | After | Change |', '| --- | ---: | ---: | ---: |');
    for (const g of changed) out.push(`| ${g.names.join(', ')} | ${fmtMaybe(g.before)} | ${fmtMaybe(g.after)} | **${signed(g.delta)}** |`);
  }
  if (diff.files.length) {
    out.push('', '| File loaded every turn | Before | After | Change |', '| --- | ---: | ---: | ---: |');
    for (const f of diff.files)
      out.push(`| \`${f.part === 'full' ? f.path : `${f.path} (${f.part})`}\` | ${fmtMaybe(f.before)} | ${fmtMaybe(f.after)} | ${signed(f.delta)} |`);
  }
  if (diff.mcp.added.length || diff.mcp.removed.length) {
    out.push('');
    for (const s of diff.mcp.added) out.push(`- MCP server added: ${s}`);
    for (const s of diff.mcp.removed) out.push(`- MCP server removed: ${s}`);
  }
  return out.join('\n');
}

/** MCP rows that are identical apart from the agent, merged. */
function groupMcp(rows: McpRow[]): Array<{ row: McpRow; tools: string[] }> {
  const groups = new Map<string, { row: McpRow; tools: string[] }>();
  for (const r of rows) {
    const key = JSON.stringify([
      r.configPath,
      r.name,
      r.status,
      r.tools,
      r.excludedTools,
      r.o200k,
      r.deferredO200k,
      r.instructionsO200k,
      r.error,
      r.overriddenBy,
      r.overrideAssumed,
    ]);
    const g = groups.get(key);
    if (g) g.tools.push(r.tool);
    else groups.set(key, { row: r, tools: [r.tool] });
  }
  return [...groups.values()];
}

function mcpDetail(r: McpRow): string {
  if (r.status === 'measured') {
    const parts = [`${r.tools} tools${r.excludedTools ? ` (${r.excludedTools} more left out by the config)` : ''}`];
    if (r.deferredO200k !== undefined) {
      const upfront = (r.tools ?? 0) - (r.deferredTools ?? 0);
      parts.push(`${upfront ? `${upfront} in full, ${r.deferredTools} as ` : ''}names only, full definitions (${fmtTokens(r.deferredO200k)}) load when used`);
    }
    if (r.instructionsO200k) parts.push(`server instructions ${fmtTokens(r.instructionsO200k)}`);
    return parts.join('; ');
  }
  if (r.status === 'disabled') return 'disabled in the config';
  if (r.status === 'overridden') return `overridden by ${r.overriddenBy}${r.overrideAssumed ? ' (precedence assumed)' : ''}`;
  if (r.status === 'failed') return r.error ?? 'failed';
  return 'run with --mcp to count its tool definitions';
}

export function renderText(report: Report, root?: string): string {
  const out: string[] = [];
  out.push(`turntax: per-turn context tax${root ? ` for ${root}` : ''}`);
  out.push('');
  if (!report.tools.length) {
    out.push('No agent instruction files found.');
    return out.join('\n');
  }
  if (report.diff) {
    out.push(renderDiffText(report.diff));
    out.push('');
  }
  const showMcp = report.tools.some((t) => t.mcpServers > 0);
  const showUser = report.tools.some((t) => t.userAlwaysFiles > 0 || t.userPerTurnO200k > 0);
  const extra = [...(showMcp ? ['mcp/turn'] : []), ...(showUser ? ['user/turn'] : []), ...(showMcp || showUser ? ['total'] : [])];
  const rows = [
    ['always', 'o200k/turn', 'on-demand', ...extra, 'model', 'tokens/turn', 'counted by', `${report.turns} turns`, 'cached', 'agents'],
  ];
  for (const { names, tool: t } of groupTools(report)) {
    const head = [
      String(t.alwaysFiles),
      fmtTokens(t.perTurnO200k),
      fmtTokens(t.onDemandO200k),
      ...(showMcp ? [mcpCell(t)] : []),
      ...(showUser ? [fmtTokens(t.userPerTurnO200k)] : []),
      ...(showMcp || showUser ? [fmtTokens(t.totalPerTurnO200k) + (t.mcpMeasured ? '' : '+')] : []),
    ];
    const blank = head.map(() => '');
    const agents = names.join(', ');
    if (!t.models.length) rows.push([...head, '(no selected model)', '', '', '', '', agents]);
    t.models.forEach((m, i) =>
      rows.push([
        ...(i === 0 ? head : blank),
        m.label,
        ...(m.perTurn === null
          ? ['-', m.reason ?? METHOD_LABEL[m.method], '-', '-']
          : [fmtTokens(m.perTurn), METHOD_LABEL[m.method], fmtUsd(m.uncached), fmtUsd(m.cached)]),
        i === 0 ? agents : '',
      ]),
    );
  }
  out.push(table(rows));
  out.push('');

  out.push('Files');
  const fileRows = [['mode', 'file', 'o200k', 'loads', 'agents']];
  for (const { file: f, tools } of groupFiles(report)) {
    const name = f.part === 'full' ? f.path : `${f.path} (${f.part})`;
    fileRows.push([f.mode, name + (f.importedFrom ? ` <- @${f.importedFrom}` : ''), fmtTokens(f.o200k), f.trigger, tools.join(', ')]);
  }
  out.push(table(fileRows, '  '));
  if (report.mcp.length) {
    out.push('');
    out.push('MCP servers (tool definitions are sent every turn)');
    const mcpRows = [['status', 'server', 'config', 'o200k', 'detail', 'agents']];
    for (const { row: r, tools } of groupMcp(report.mcp))
      mcpRows.push([r.status, r.name, r.configPath, r.o200k === undefined ? '-' : fmtTokens(r.o200k), mcpDetail(r), tools.join(', ')]);
    out.push(table(mcpRows, '  '));
  }
  const notes = [
    ...new Set([
      ...report.files.flatMap((f) => f.notes.map((n) => `${f.path}: ${n}`)),
      ...report.mcp.flatMap((m) => (m.note ? [`${m.configPath}: ${m.note}`] : [])),
    ]),
  ];
  if (notes.length) {
    out.push('');
    out.push('Notes');
    for (const n of notes) out.push(`  - ${n}`);
  }

  out.push('');
  out.push('Advice (savings are estimates in o200k tokens per turn)');
  if (!report.advice.length) out.push('  No issues found.');
  for (const a of report.advice) {
    const saving = a.savingTokens === null ? '' : ` [saves ~${fmtTokens(a.savingTokens)} tokens/turn]`;
    const where = a.paths.join(', ') + (a.line ? `:${a.line}` : '');
    out.push(`  ${a.severity.toUpperCase()} ${a.kind} ${where}${saving}`);
    out.push(`    ${a.message}${a.savingNote ? ` (${a.savingNote})` : ''}`);
  }

  out.push('');
  out.push(footer(report));
  return out.join('\n');
}

function footer(report: Report): string {
  const lines = [
    'o200k = OpenAI o200k_base, counted offline. It is a reference for every file, not a Claude or Gemini count.',
    'Claude and Gemini tokenizers are not public: their counts come only from the vendor APIs (--claude-api, --gemini-api).',
    `Cost = tokens/turn x ${report.turns} turns x input price. "Cached" assumes every turn reads the context from the prompt cache.`,
    ...(report.mcp.length
      ? ['MCP tool definitions are counted as JSON with o200k (an estimate of what the agent sends) and are not included in model costs.']
      : []),
    ...(report.mcp.some((m) => m.deferredO200k !== undefined) ? [DEFERRED_NOTE] : []),
    ...(report.mcp.some((m) => m.instructionsO200k) ? [INSTRUCTIONS_NOTE] : []),
    'Prices (USD per 1M input tokens):',
  ];
  for (const m of report.models) {
    lines.push(
      `  ${m.label}: ${m.inputPerMTok ?? 'n/a'} input, ${m.cachedInputPerMTok ?? 'n/a'} cached` +
        `${m.priceNote ? ` (${m.priceNote})` : ''}; ${m.source}, checked ${m.checkedAt}`,
    );
  }
  return lines.join('\n');
}

export function renderMarkdown(report: Report): string {
  const out: string[] = ['# Agent context tax report', ''];
  if (report.diff) out.push(renderDiffMarkdown(report.diff), '');
  out.push(`Every agent re-sends its always-loaded instruction files with each turn. Costs are for ${report.turns} turns.`, '');
  out.push('## Per agent', '');
  out.push('| Agents | Model | Tokens / turn | Counted by | Uncached | Cached |', '| --- | --- | ---: | --- | ---: | ---: |');
  for (const { names, tool: t } of groupTools(report)) {
    const agents = names.join(', ');
    if (!t.models.length) out.push(`| ${agents} | - | ${fmtTokens(t.perTurnO200k)} (o200k) | reference | - | - |`);
    for (const m of t.models)
      out.push(
        m.perTurn === null
          ? `| ${agents} | ${m.label} | - | ${m.reason ?? ''} | - | - |`
          : `| ${agents} | ${m.label} | ${fmtTokens(m.perTurn)} | ${METHOD_LABEL[m.method]} | ${fmtUsd(m.uncached)} | ${fmtUsd(m.cached)} |`,
      );
  }
  if (report.tools.some((t) => t.mcpServers > 0 || t.userAlwaysFiles > 0 || t.userPerTurnO200k > 0)) {
    out.push('', '### Every turn, by source (o200k)', '');
    out.push('| Agents | Repository files | MCP tools | User level | Total |', '| --- | ---: | ---: | ---: | ---: |');
    for (const { names, tool: t } of groupTools(report))
      out.push(
        `| ${names.join(', ')} | ${fmtTokens(t.perTurnO200k)} | ${mcpCell(t)} | ${fmtTokens(t.userPerTurnO200k)} | ${fmtTokens(t.totalPerTurnO200k)}${t.mcpMeasured ? '' : '+'} |`,
      );
  }
  if (report.mcp.length) {
    out.push('', '## MCP servers', '', '| Status | Server | Config | o200k tokens | Detail | Agents |', '| --- | --- | --- | ---: | --- | --- |');
    for (const { row: r, tools } of groupMcp(report.mcp))
      out.push(
        `| ${r.status} | ${escapeCell(r.name)} | \`${r.configPath}\` | ${r.o200k === undefined ? '-' : fmtTokens(r.o200k)} | ${escapeCell(mcpDetail(r))} | ${tools.join(', ')} |`,
      );
  }
  out.push('', '## Files', '', '| Mode | File | o200k tokens | Loads | Agents |', '| --- | --- | ---: | --- | --- |');
  for (const { file: f, tools } of groupFiles(report)) {
    const name = f.part === 'full' ? f.path : `${f.path} (${f.part})`;
    out.push(`| ${f.mode} | \`${name}\` | ${fmtTokens(f.o200k)} | ${escapeCell(f.trigger)} | ${tools.join(', ')} |`);
  }
  out.push('', '## Advice', '');
  if (!report.advice.length) out.push('No issues found.');
  for (const a of report.advice) {
    const saving = a.savingTokens === null ? '' : ` Saves about ${fmtTokens(a.savingTokens)} tokens per turn.`;
    out.push(`- **${a.severity}** \`${a.kind}\` ${a.paths.map((p) => `\`${p}\``).join(', ')}${a.line ? ` line ${a.line}` : ''}: ${a.message}${saving}${a.savingNote ? ` _${a.savingNote}_` : ''}`);
  }
  out.push('', '## Method', '');
  out.push('- o200k = OpenAI `o200k_base`, counted offline; a reference, not a Claude or Gemini count.');
  out.push('- Claude counts come only from Anthropic `count_tokens`; Gemini counts only from Google `countTokens`.');
  out.push('- "Cached" assumes every turn reads the context from the prompt cache.');
  if (report.mcp.length) out.push('- MCP tool definitions are counted as JSON with o200k, an estimate of what the agent sends; they are not in the model costs.');
  if (report.mcp.some((m) => m.deferredO200k !== undefined)) out.push(`- ${DEFERRED_NOTE}`);
  if (report.mcp.some((m) => m.instructionsO200k)) out.push(`- ${INSTRUCTIONS_NOTE}`);
  for (const m of report.models)
    out.push(`- ${m.label}: $${m.inputPerMTok ?? 'n/a'} input / $${m.cachedInputPerMTok ?? 'n/a'} cached per 1M tokens ([source](${m.source}), checked ${m.checkedAt}).`);
  out.push('', badgeMarkdown(report));
  return out.join('\n') + '\n';
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function shieldsEscape(s: string): string {
  return encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
}

export function badgeUrl(report: Report): string {
  const n = headlineTokens(report);
  const value = n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens/turn` : `${n} tokens/turn`;
  const color = n < 2000 ? 'brightgreen' : n < 5000 ? 'yellow' : n < 10000 ? 'orange' : 'red';
  return `https://img.shields.io/badge/${shieldsEscape('context tax (o200k)')}-${shieldsEscape(value)}-${color}`;
}

export function badgeMarkdown(report: Report): string {
  return `[![context tax (o200k)](${badgeUrl(report)})](https://github.com/TorutDev/turntax)`;
}

export const PR_COMMENT_MARKER = '<!-- turntax-report -->';
const COMMENT_LIMIT = 60_000;
/** Most of the comment the fix diff may take; the full report gets the rest. */
const FIX_DIFF_LIMIT = 20_000;

/**
 * A pull request comment: the change against the base branch first, then the safe fixes (when `fixes`
 * has changes), the full report folded below. Starts with a marker so the GitHub Action can update its
 * own comment instead of adding new ones.
 */
export function renderPrComment(report: Report, fixes?: FixPlan, fixCommand = 'npx turntax --fix'): string {
  const top = report.diff ? noMentions(renderDiffMarkdown(report.diff)) : '## Agent context tax';
  const headline = `Largest per-turn cost: **${fmtTokens(headlineTokens(report))}** o200k tokens (repository files and measured project MCP tools).`;
  const fixPart = fixes?.changes.length ? ['', renderFixes(fixes, fixCommand)] : [];
  // GitHub rejects comments over 65,536 characters; everything but the full report counts against the limit.
  const limit = Math.max(0, COMMENT_LIMIT - [top, headline, ...fixPart].join('\n').length);
  // Headings and messages quote instruction files, which may contain @names; keep them from mentioning people.
  let full = noMentions(renderMarkdown({ ...report, diff: undefined }).replace(/^# .*\n\n/, ''));
  if (full.length > limit) full = full.slice(0, limit) + '\n\n_Report cut to fit in a comment; run turntax locally for all of it._\n';
  return [PR_COMMENT_MARKER, top, '', headline, ...fixPart, '', '<details><summary>Full report</summary>', '', full, '</details>', ''].join('\n');
}

/** Breaks @name mentions in Markdown prose with a zero-width space; code spans and fenced blocks stay as they are. */
export function noMentions(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (fence === null || marker.startsWith(fence))) {
        fence = fence === null ? marker : null;
        return line;
      }
      if (fence !== null) return line;
      return line
        .split(/(`+[^`]*`+)/)
        // Not after a letter or digit, so email addresses (a@b.com) stay as they are.
        .map((part, i) => (i % 2 ? part : part.replace(/(^|[^A-Za-z0-9])@(?=[A-Za-z0-9])/g, '$1@&#8203;')))
        .join('');
    })
    .join('\n');
}

function renderFixes(plan: FixPlan, command: string): string {
  const n = plan.fixes.length;
  const saving = plan.fixes.reduce((a, f) => a + (f.savingTokens ?? 0), 0);
  let diff = unifiedDiff(plan.changes);
  let cut = '';
  if (diff.length > FIX_DIFF_LIMIT) {
    const end = diff.lastIndexOf('\n', FIX_DIFF_LIMIT);
    diff = diff.slice(0, end > 0 ? end + 1 : FIX_DIFF_LIMIT);
    cut = `\n_Diff cut to fit in a comment; run \`${command}\` for all of it._\n`;
  }
  // A fence longer than any backtick run in the diff, so moved code blocks cannot close it.
  const fence = '`'.repeat(Math.max(3, ...[...diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [
    `**${n} safe ${n === 1 ? 'fix' : 'fixes'} available**${saving ? ` (saves ~${fmtTokens(saving)} o200k tokens/turn)` : ''}: run \`${command}\` to preview.`,
    '',
    '<details><summary>Fixes</summary>',
    '',
    ...plan.fixes.map((f) => `- ${noMentions(f.message)}`),
    '',
    `${fence}diff`,
    diff.replace(/\n$/, ''),
    fence,
    cut,
    '</details>',
  ].join('\n');
}

/** GitHub workflow command escaping: message data, and property values (file, title). */
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * GitHub Actions annotations, one per advice item on a repository file, so findings show inline on a
 * pull request. `prefix` makes paths relative to the workspace when the audited folder is not its root.
 */
export function renderAnnotations(report: Report, prefix = ''): string {
  let out = '';
  for (const a of report.advice) {
    const path = a.paths.find((p) => !p.startsWith('~'));
    if (!path) continue;
    const props = [`file=${escapeProperty(prefix + path)}`];
    // `line` belongs to the first path.
    if (a.line && path === a.paths[0]) props.push(`line=${a.line}`);
    props.push(`title=${escapeProperty(`turntax ${a.kind}`)}`);
    const saving = a.savingTokens ? ` (saves ~${fmtTokens(a.savingTokens)} tokens/turn)` : '';
    out += `::${a.severity === 'low' ? 'notice' : 'warning'} ${props.join(',')}::${escapeData(a.message + saving)}\n`;
  }
  return out;
}
