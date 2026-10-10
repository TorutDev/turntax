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
    ['tool', 'always', 'o200k/turn', 'on-demand', 'model', 'tokens/turn', 'counted by', `${report.turns} turns`, 'cached'],
  ];
  for (const t of report.tools) {
    const head = [t.name, String(t.alwaysFiles), fmtTokens(t.perTurnO200k), fmtTokens(t.onDemandO200k)];
    const blank = head.map(() => '');
    if (!t.models.length) rows.push([...head, '(no selected model)', '', '', '', '']);
    t.models.forEach((m, i) =>
      rows.push([
        ...(i === 0 ? head : blank),
        m.label,
        ...(m.perTurn === null
          ? ['-', m.reason ?? METHOD_LABEL[m.method], '-', '-']
          : [fmtTokens(m.perTurn), METHOD_LABEL[m.method], fmtUsd(m.uncached), fmtUsd(m.cached)]),
      ]),
    );
  }
  out.push(table(rows));
  out.push('');

  out.push('Files');
  const fileRows = [['tool', 'mode', 'file', 'o200k', 'loads']];
  for (const f of report.files) {
    const name = f.part === 'full' ? f.path : `${f.path} (${f.part})`;
    fileRows.push([f.tool, f.mode, name + (f.importedFrom ? ` <- @${f.importedFrom}` : ''), fmtTokens(f.o200k), f.trigger]);
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
  out.push('## Per tool', '');
  out.push('| Tool | Model | Tokens / turn | Counted by | Uncached | Cached |', '| --- | --- | ---: | --- | ---: | ---: |');
  for (const t of report.tools) {
    if (!t.models.length) out.push(`| ${t.name} | - | ${fmtTokens(t.perTurnO200k)} (o200k) | reference | - | - |`);
    for (const m of t.models)
      out.push(
        m.perTurn === null
          ? `| ${t.name} | ${m.label} | - | ${m.reason ?? ''} | - | - |`
          : `| ${t.name} | ${m.label} | ${fmtTokens(m.perTurn)} | ${METHOD_LABEL[m.method]} | ${fmtUsd(m.uncached)} | ${fmtUsd(m.cached)} |`,
      );
  }
  out.push('', '## Files', '', '| Tool | Mode | File | o200k tokens | Loads |', '| --- | --- | --- | ---: | --- |');
  for (const f of report.files) {
    const name = f.part === 'full' ? f.path : `${f.path} (${f.part})`;
    out.push(`| ${f.tool} | ${f.mode} | \`${name}\` | ${fmtTokens(f.o200k)} | ${escapeCell(f.trigger)} |`);
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
