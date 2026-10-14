import { sectionScope } from './advice.js';
import { classify } from './classify.js';
import { isInstructionFile } from './files.js';
import { basename, findImports, linesWithFences, parseFrontmatter, splitSections } from './markdown.js';
import { countO200k } from './tokenize.js';
import { TOOLS } from './tools.js';
import type { LoadMode, LoadedUnit, RepoFile, ToolId } from './types.js';

/**
 * Safe, deterministic fixes for some advice. Every fix is checked by classifying the files again:
 * each agent must still read every line it read before, at least as often (see `check`).
 */

export type FixKind = 'duplicate' | 'scopable-section' | 'misconfigured';

export interface Fix {
  kind: FixKind;
  paths: string[];
  message: string;
  /** Estimated o200k tokens saved per turn for the agents that loaded the text every turn. */
  savingTokens: number | null;
}

export interface SkippedFix {
  kind: FixKind;
  paths: string[];
  reason: string;
}

/** One file's change; `before` null creates the file. With `renamedFrom`, `before` is the old file's text. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string;
  renamedFrom?: string;
}

export interface FixPlan {
  fixes: Fix[];
  skipped: SkippedFix[];
  changes: FileChange[];
}

export interface FixOptions {
  /** Agents whose context must be preserved. Default: every supported agent. */
  tools?: ToolId[];
  /** Checks whether a repo-relative path exists; the folder a section is about is never created. */
  exists?: (path: string) => boolean;
  /** Files that must not be changed, such as symlinks and their targets. */
  readOnly?: (path: string) => boolean;
}

const RANK: Record<LoadMode, number> = { ignored: 0, manual: 1, 'on-demand': 2, always: 3 };

const toolName = (id: ToolId) => TOOLS.find((t) => t.id === id)?.name ?? id;
const names = (ids: Iterable<ToolId>) => [...ids].map(toolName).join(', ');

/** Text with LF line endings, plus the line ending to write back. */
function lf(text: string): { text: string; eol: string } {
  return { text: text.replace(/\r\n/g, '\n'), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function contentUnits(units: LoadedUnit[]): LoadedUnit[] {
  return units.filter((u) => u.part !== 'description' && u.mode !== 'ignored');
}

/**
 * A line as compared by the fixes: only list markers and whitespace are ignored. Case, underscores,
 * asterisks and backticks can carry meaning (`create_user`, globs), so lines that differ there differ.
 */
function lineKey(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Prose lines long enough to be meaningful (outside fenced code, not headings), by key. */
function proseLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { line, inFence } of linesWithFences(text)) {
    const key = lineKey(line);
    if (!inFence && key.length >= 30 && !key.startsWith('#')) out.set(key, line);
  }
  return out;
}

function keysOf(text: string): string[] {
  return text
    .split('\n')
    .map(lineKey)
    .filter((k) => k.replace(/[#\s]/g, '').length > 0);
}

/** For each tool, the highest load mode of every normalized line it reads. */
type Loaded = Map<ToolId, Map<string, number>>;

function loadedLines(units: LoadedUnit[]): Loaded {
  const out: Loaded = new Map();
  for (const u of contentUnits(units)) {
    const lines = out.get(u.tool) ?? new Map<string, number>();
    out.set(u.tool, lines);
    for (const key of keysOf(u.text)) lines.set(key, Math.max(lines.get(key) ?? 0, RANK[u.mode]));
  }
  return out;
}

/**
 * Agents that would lose something: every line an agent read before must still be read at least as
 * often, except the `edited` lines, which need only `need(before)`.
 */
function check(before: Loaded, after: Loaded, edited: Set<string>, need: (rank: number) => number): ToolId[] {
  const lost: ToolId[] = [];
  for (const [tool, lines] of before) {
    const now = after.get(tool);
    for (const [key, rank] of lines) {
      if ((now?.get(key) ?? 0) < (edited.has(key) ? need(rank) : rank)) {
        lost.push(tool);
        break;
      }
    }
  }
  return lost;
}

interface State {
  files: Map<string, RepoFile>;
  units: LoadedUnit[];
  loaded: Loaded;
}

class Workspace {
  state: State;
  constructor(
    input: RepoFile[],
    private tools?: ToolId[],
  ) {
    this.state = this.build(new Map(input.map((f) => [f.path, f])));
  }
  private build(files: Map<string, RepoFile>): State {
    const units = classify([...files.values()], this.tools);
    return { files, units, loaded: loadedLines(units) };
  }
  get files() {
    return this.state.files;
  }
  get units() {
    return this.state.units;
  }
  /** The state with `edits` applied (null deletes a file). */
  trial(edits: Map<string, string | null>): State {
    const files = new Map(this.state.files);
    for (const [path, text] of edits) {
      if (text === null) files.delete(path);
      else files.set(path, { path, text });
    }
    return this.build(files);
  }
  check(next: State, edited: Iterable<string>, need: (rank: number) => number): ToolId[] {
    return check(this.state.loaded, next.loaded, new Set(edited), need);
  }
  commit(next: State): void {
    this.state = next;
  }
}

export function planFixes(input: RepoFile[], opts: FixOptions = {}): FixPlan {
  // Only repository files are ever changed; user-level files (~/...) are not passed in.
  const ws = new Workspace(
    input.filter((f) => !f.path.startsWith('~')),
    opts.tools,
  );
  // Files reached only through @imports (a README, docs) are for people too; they are never changed.
  const readOnly = (path: string): string | null =>
    !isInstructionFile(path)
      ? `${path} is not an agent instruction file (it is @imported); it is left alone.`
      : opts.readOnly?.(path)
        ? `${path} is a symlink, in a symlinked folder or the target of a symlink; it is left alone.`
        : null;
  const original = new Map(ws.files);
  const renames = new Map<string, string>();
  const fixes: Fix[] = [];
  const skipped: SkippedFix[] = [];

  if (!opts.tools || opts.tools.includes('cursor')) renameCursorRules(ws, readOnly, renames, fixes, skipped);
  // Moves run before duplicate removal: a move may relax how often lines load, so a line must not be
  // removed elsewhere on the strength of a copy that is moved later.
  moveScopableSections(ws, opts, readOnly, fixes, skipped);
  removeDuplicates(ws, readOnly, fixes, skipped);

  const renamedTo = new Map([...renames].map(([from, to]) => [to, from]));
  const changes: FileChange[] = [];
  for (const [path, file] of ws.files) {
    const from = renamedTo.get(path);
    const before = original.get(from ?? path)?.text ?? null;
    if (from) changes.push({ path, before, after: file.text, renamedFrom: from });
    else if (before !== file.text) changes.push({ path, before, after: file.text });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { fixes, skipped, changes };
}

/** `.md` files in `.cursor/rules` are ignored by Cursor; `.mdc` is the documented extension. */
function renameCursorRules(
  ws: Workspace,
  readOnly: (path: string) => string | null,
  renames: Map<string, string>,
  fixes: Fix[],
  skipped: SkippedFix[],
): void {
  for (const f of [...ws.files.values()]) {
    if (!/^(?:.*\/)?\.cursor\/rules\/.+\.md$/.test(f.path)) continue;
    const to = f.path.replace(/\.md$/, '.mdc');
    const blocked = readOnly(f.path) ?? (ws.files.has(to) ? `${to} already exists.` : readOnly(to));
    if (blocked) {
      skipped.push({ kind: 'misconfigured', paths: [f.path], reason: blocked });
      continue;
    }
    const next = ws.trial(new Map([[f.path, null], [to, f.text]]));
    const lost = ws.check(next, [], (r) => r);
    if (lost.length) {
      skipped.push({ kind: 'misconfigured', paths: [f.path], reason: `${names(lost)} would stop reading it.` });
      continue;
    }
    const mode = next.units.find((u) => u.tool === 'cursor' && u.path === to && u.part !== 'description')?.mode;
    ws.commit(next);
    renames.set(f.path, to);
    fixes.push({
      kind: 'misconfigured',
      paths: [f.path, to],
      message:
        `Renamed ${f.path} to ${basename(to)} so Cursor reads it` +
        (mode === 'manual' ? '; without frontmatter it applies only when @-mentioned (add alwaysApply, globs or description).' : '.'),
      savingTokens: null,
    });
  }
}

/** Indexes of body lines (after any frontmatter) outside fenced code. */
function bodyLines(text: string): Array<{ line: string; index: number }> {
  const start = text.split('\n').length - parseFrontmatter(text).body.split('\n').length;
  return linesWithFences(text)
    .map(({ line, inFence }, index) => ({ line, inFence, index }))
    .filter((l) => !l.inFence && l.index >= start);
}

/** Drops the given line indexes; a blank line left next to another blank line where a line was removed goes too. */
function dropLines(lines: string[], drop: Set<number>): string[] {
  const kept: string[] = [];
  let removed = false;
  lines.forEach((line, i) => {
    if (drop.has(i)) {
      removed = true;
      return;
    }
    if (removed && line.trim() === '' && (kept.length === 0 || kept[kept.length - 1]!.trim() === '')) return;
    removed = false;
    kept.push(line);
  });
  return kept;
}

/**
 * Removes a line from a file when every agent that reads the file also reads the same line every turn
 * from another file. Files read by fewer agents are trimmed first, so the broadest copy stays.
 */
function removeDuplicates(ws: Workspace, readOnly: (path: string) => string | null, fixes: Fix[], skipped: SkippedFix[]): void {
  const readers = (path: string) => new Set(contentUnits(ws.units).filter((u) => u.path === path).map((u) => u.tool));
  const order = [...ws.files.keys()].sort((a, b) => readers(a).size - readers(b).size || b.localeCompare(a));
  for (const path of order) {
    const tools = readers(path);
    // Skill, command and subagent bodies are procedures or separate prompts; they are left whole.
    if (!tools.size || ws.units.some((u) => u.path === path && u.part === 'body')) continue;
    const { text, eol } = lf(ws.files.get(path)!.text);
    const elsewhere = (key: string) =>
      contentUnits(ws.units).filter((u) => u.path !== path && u.mode === 'always' && proseLines(u.text).has(key));
    // Lines this file shares with another file that some agent reads every turn.
    const shared = new Map<string, string[]>();
    const blockers = new Set<ToolId>();
    const removable = new Set<string>();
    for (const [key] of proseLines(text)) {
      const others = elsewhere(key);
      if (!others.length) continue;
      shared.set(key, [...new Set(others.map((u) => u.path))]);
      const missing = [...tools].filter((t) => !others.some((u) => u.tool === t));
      missing.forEach((t) => blockers.add(t));
      if (!missing.length) removable.add(key);
    }
    if (!shared.size) continue;
    const otherPaths = [...new Set([...shared.values()].flat())];
    if (readOnly(path)) {
      skipped.push({ kind: 'duplicate', paths: [path, ...otherPaths], reason: readOnly(path)! });
      continue;
    }
    if (removable.size) {
      const lines = text.split('\n');
      const drop = new Set(bodyLines(text).filter((l) => removable.has(lineKey(l.line))).map((l) => l.index));
      const removed = [...drop].map((i) => lines[i]!);
      const next = ws.trial(new Map([[path, dropLines(lines, drop).join('\n').replace(/\n/g, eol)]]));
      const lost = ws.check(next, removable, (r) => r);
      if (lost.length) {
        skipped.push({ kind: 'duplicate', paths: [path, ...otherPaths], reason: `Kept ${removable.size} line(s) in ${path}: ${names(lost)} would lose context without them (for example a file they @import).` });
      } else {
        const everyTurn = contentUnits(ws.units).some((u) => u.path === path && u.mode === 'always');
        const from = [...new Set([...removable].flatMap((k) => shared.get(k)!))];
        ws.commit(next);
        fixes.push({
          kind: 'duplicate',
          paths: [path, ...from],
          message: `Removed ${removed.length} line(s) from ${path} that ${names(tools)} already read every turn from ${from.join(', ')}.`,
          savingTokens: everyTurn ? countO200k(removed.join('\n')) : 0,
        });
      }
    }
    const kept = shared.size - removable.size;
    if (kept && blockers.size)
      skipped.push({
        kind: 'duplicate',
        paths: [path, ...otherPaths],
        reason: `Kept ${kept} line(s) in ${path} that are also in ${otherPaths.join(', ')}: ${names(blockers)} would lose them.`,
      });
  }
}

/** Where a section about `scope` can live so it loads only there: the same file name nested, AGENTS.md, or a Claude rule. */
function targets(source: string, scope: string, heading: string): Array<{ path: string; header: string }> {
  const name = basename(source);
  const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
  const out: Array<{ path: string; header: string }> = [];
  if (['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].includes(name)) out.push({ path: `${scope}/${name}`, header: '' });
  if (name !== 'AGENTS.md') out.push({ path: `${scope}/AGENTS.md`, header: '' });
  out.push({ path: `.claude/rules/${slug}.md`, header: `---\npaths:\n  - "${scope}/**"\n---\n\n` });
  return out;
}

const headingLevel = (line: string) => /^\s{0,3}(#{1,6})\s/.exec(line)?.[1]!.length ?? 0;

/** Level 2 and 3 sections of the LF text, each running to the next heading of the same or a higher level. */
function movableSections(text: string): Array<{ heading: string; body: string; start: number; end: number }> {
  const lines = text.split('\n');
  const all = splitSections(text).filter((s) => s.heading !== '(top)');
  return all
    .map((s) => ({ s, level: headingLevel(lines[s.line - 1]!) }))
    .filter((x) => x.level >= 2)
    .map(({ s, level }) => {
      const next = all.find((o) => o.line > s.line && headingLevel(lines[o.line - 1]!) <= level);
      const end = next ? next.line - 1 : lines.length;
      return { heading: s.heading, start: s.line - 1, end, body: lines.slice(s.line - 1, end).join('\n').replace(/\n+$/, '') };
    });
}

function moveScopableSections(ws: Workspace, opts: FixOptions, readOnly: (path: string) => string | null, fixes: Fix[], skipped: SkippedFix[]): void {
  const sources = [...new Set(ws.units.filter((u) => u.mode === 'always' && u.part === 'full').map((u) => u.path))].sort();
  const tried = new Set<string>();
  for (const path of sources) {
    // Sections are found in the raw file so that comments and formatting move as they are.
    for (;;) {
      const { text, eol } = lf(ws.files.get(path)!.text);
      const next = movableSections(text)
        .map((x) => ({ ...x, scope: sectionScope(x.body) }))
        .find((x) => x.scope && !tried.has(`${path}\0${x.body}`));
      if (!next) break;
      tried.add(`${path}\0${next.body}`);
      const { heading, body, start, end } = next;
      const scope = next.scope!;
      const reason = readOnly(path) ?? moveBlocker(body, scope, opts);
      if (reason) {
        skipped.push({ kind: 'scopable-section', paths: [path], reason: `Section "${heading}": ${reason}` });
        continue;
      }
      const lines = text.split('\n');
      const head = lines.slice(0, start);
      const tail = lines.slice(end);
      while (head.length && tail.length && head[head.length - 1]!.trim() === '' && tail[0]!.trim() === '') tail.shift();
      const rest = [...head, ...tail].join('\n').replace(/\n*$/, '\n');
      let moved = false;
      const refused: string[] = [];
      for (const t of targets(path, scope, heading)) {
        const existing = ws.files.get(t.path);
        if (t.path === path || readOnly(t.path) || (existing && t.header)) continue;
        const target = existing ? lf(existing.text) : { text: '', eol };
        const targetText = existing ? `${target.text.replace(/\n+$/, '')}\n\n${body}\n` : `${t.header}${body}\n`;
        const trial = ws.trial(
          new Map([
            [path, rest.replace(/\n/g, eol)],
            [t.path, targetText.replace(/\n/g, target.eol)],
          ]),
        );
        // Agents that loaded the section every turn may now load it only when working in that folder.
        const lost = ws.check(trial, keysOf(body), (r) => Math.min(r, RANK['on-demand']));
        if (lost.length) {
          refused.push(`${t.path} (${names(lost)} would lose context)`);
          continue;
        }
        const readers = [...new Set(ws.units.filter((u) => u.path === path && u.mode === 'always' && u.part !== 'description').map((u) => u.tool))];
        const reads = (l: Loaded, tool: ToolId) => keysOf(body).some((k) => l.get(tool)?.has(k));
        const added = [...trial.loaded.keys()].filter((tool) => !reads(ws.state.loaded, tool) && reads(trial.loaded, tool));
        const dropped = opts.tools ? leftOut(ws.files, trial.files, body, opts.tools) : [];
        ws.commit(trial);
        fixes.push({
          kind: 'scopable-section',
          paths: [path, t.path],
          message:
            `Moved section "${heading}" from ${path} to ${t.path}${existing ? '' : ' (new file)'}; ${names(readers)} load it only when working in ${scope}/.` +
            (added.length ? ` Now also read there by ${names(added)}.` : '') +
            (dropped.length ? ` Not kept for ${names(dropped)} (outside --tools).` : ''),
          savingTokens: countO200k(body),
        });
        moved = true;
        break;
      }
      if (!moved)
        skipped.push({
          kind: 'scopable-section',
          paths: [path],
          reason: `Section "${heading}": no target keeps every agent's context: ${refused.join('; ')}. Use --tools to choose the agents to keep it for.`,
        });
    }
  }
}

/** Agents outside `tools` that read some of `body` before the move and none of those lines after it. */
function leftOut(before: Map<string, RepoFile>, after: Map<string, RepoFile>, body: string, tools: ToolId[]): ToolId[] {
  const others = TOOLS.map((t) => t.id).filter((id) => !tools.includes(id));
  const was = loadedLines(classify([...before.values()], others));
  const now = loadedLines(classify([...after.values()], others));
  return others.filter((tool) => keysOf(body).some((k) => was.get(tool)?.has(k) && !now.get(tool)?.has(k)));
}

function moveBlocker(body: string, scope: string, opts: FixOptions): string | null {
  if (scope.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return `unusual folder ${scope}.`;
  if (opts.exists && !opts.exists(scope)) return `folder ${scope}/ does not exist.`;
  if (findImports(body).length) return 'it has @imports, which resolve relative to the file they are in.';
  if (/\]\((?!https?:|#|\/|mailto:)[^)]+\)/.test(body)) return 'it has relative links, which resolve relative to the file they are in.';
  return null;
}

/** Unified diff of the planned changes, in the format `git apply` accepts. */
export function unifiedDiff(changes: FileChange[]): string {
  let out = '';
  for (const c of changes) {
    const from = c.renamedFrom ?? c.path;
    out += `diff --git a/${from} b/${c.path}\n`;
    if (c.renamedFrom) {
      if (c.before === c.after) out += 'similarity index 100%\n';
      out += `rename from ${c.renamedFrom}\nrename to ${c.path}\n`;
      if (c.before === c.after) continue;
    }
    if (c.before === null) out += 'new file mode 100644\n';
    out += `--- ${c.before === null ? '/dev/null' : `a/${from}`}\n+++ b/${c.path}\n`;
    out += hunks(c.before ?? '', c.after);
  }
  return out;
}

interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
  /** Last line of its file without a trailing newline. */
  noEol: boolean;
}

function split(text: string): Array<{ text: string; noEol: boolean }> {
  if (text === '') return [];
  const lines = text.split('\n');
  const noEol = lines[lines.length - 1] !== '';
  if (!noEol) lines.pop();
  return lines.map((t, i) => ({ text: t, noEol: noEol && i === lines.length - 1 }));
}

/** Line diff by longest common subsequence; instruction files are small. */
function diffLines(a: ReturnType<typeof split>, b: ReturnType<typeof split>): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const same = (i: number, j: number) => a[i]!.text === b[j]!.text && a[i]!.noEol === b[j]!.noEol;
  if (n * m > 4_000_000)
    return [...a.map((l) => ({ op: '-' as const, ...l })), ...b.map((l) => ({ op: '+' as const, ...l }))];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = same(i, j) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) {
      out.push({ op: ' ', ...a[i++]! });
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: '-', ...a[i++]! });
    else out.push({ op: '+', ...b[j++]! });
  }
  return out;
}

function hunks(before: string, after: string, context = 3): string {
  const lines = diffLines(split(before), split(after));
  const changed = lines.map((l, i) => (l.op === ' ' ? -1 : i)).filter((i) => i >= 0);
  let out = '';
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k]! - context);
    let end = Math.min(lines.length, changed[k]! + context + 1);
    while (k + 1 < changed.length && changed[k + 1]! - context <= end) end = Math.min(lines.length, changed[++k]! + context + 1);
    k++;
    const slice = lines.slice(start, end);
    const prefix = lines.slice(0, start);
    const oldStart = prefix.filter((l) => l.op !== '+').length;
    const newStart = prefix.filter((l) => l.op !== '-').length;
    const oldLen = slice.filter((l) => l.op !== '+').length;
    const newLen = slice.filter((l) => l.op !== '-').length;
    out += `@@ -${oldLen ? oldStart + 1 : oldStart},${oldLen} +${newLen ? newStart + 1 : newStart},${newLen} @@\n`;
    for (const l of slice) out += `${l.op}${l.text}\n${l.noEol ? '\\ No newline at end of file\n' : ''}`;
  }
  return out;
}
