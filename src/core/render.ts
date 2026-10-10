import type { Report } from './audit.js';
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
    const key = JSON.stringify([files, t.models.map(({ model, perTurn, method, reason }) => [model, perTurn, method, reason])]);
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

/** Highest always-loaded o200k total across the reported tools. */
export function headlineTokens(report: Report): number {
  return Math.max(0, ...report.tools.map((t) => t.perTurnO200k));
}

export function renderText(report: Report, root?: string): string {
  const out: string[] = [];
  out.push(`turntax: per-turn context tax${root ? ` for ${root}` : ''}`);
  out.push('');
  if (!report.tools.length) {
    out.push('No agent instruction files found.');
    return out.join('\n');
  }
  const rows = [
    ['always', 'o200k/turn', 'on-demand', 'model', 'tokens/turn', 'counted by', `${report.turns} turns`, 'cached', 'agents'],
  ];
  for (const { names, tool: t } of groupTools(report)) {
    const head = [String(t.alwaysFiles), fmtTokens(t.perTurnO200k), fmtTokens(t.onDemandO200k)];
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
  const notes = [...new Set(report.files.flatMap((f) => f.notes.map((n) => `${f.path}: ${n}`)))];
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
