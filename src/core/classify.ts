import { basename, dirname, findImports, firstParagraph, parseFrontmatter, resolvePath, stripHtmlComments } from './markdown.js';
import { TOOLS, type FileRule, type ToolSpec } from './tools.js';
import type { LoadMode, LoadedUnit, RepoFile, ToolId } from './types.js';

/** Works out which files each tool loads, when, and with what text. */
export function classify(files: RepoFile[], toolIds?: ToolId[]): LoadedUnit[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tools = toolIds ? TOOLS.filter((t) => toolIds.includes(t.id)) : TOOLS;
  const units: LoadedUnit[] = [];
  for (const tool of tools) {
    const toolUnits: LoadedUnit[] = [];
    for (const rule of tool.rules) toolUnits.push(...applyRule(tool, rule, files, byPath));
    units.push(...dedupe(toolUnits));
  }
  return units;
}

/** Tools that read at least one of the given files (in any mode except ignored). */
export function detectTools(units: LoadedUnit[]): ToolId[] {
  return TOOLS.map((t) => t.id).filter((id) => units.some((u) => u.tool === id && u.mode !== 'ignored'));
}

function unit(
  tool: ToolId,
  path: string,
  mode: LoadMode,
  trigger: string,
  text: string,
  extra: Partial<LoadedUnit> = {},
): LoadedUnit {
  return { tool, path, part: 'full', mode, trigger, text, notes: [], ...extra };
}

/** Directory level a hierarchical file belongs to, e.g. `pkg/.claude/CLAUDE.md` -> `pkg`. */
function levelOf(path: string, sameLevelDirs: string[] = []): string {
  const dir = dirname(path);
  for (const same of sameLevelDirs) {
    if (dir === same) return '';
    if (dir.endsWith('/' + same)) return dir.slice(0, -same.length - 1);
  }
  return dir;
}

function isRootClaudeMd(f: RepoFile): boolean {
  return ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.local.md'].includes(f.path);
}

function applyRule(tool: ToolSpec, rule: FileRule, files: RepoFile[], byPath: Map<string, RepoFile>): LoadedUnit[] {
  switch (rule.kind) {
    case 'root-file': {
      const f = byPath.get(rule.path);
      if (!f) return [];
      return [unit(tool.id, f.path, 'always', 'project root', f.text, { notes: rule.note ? [rule.note] : [] })];
    }
    case 'ignored':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .map((f) => unit(tool.id, f.path, 'ignored', rule.reason, f.text, { problem: rule.reason }));
    case 'frontmatter':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .flatMap((f) => {
          const { frontmatter, body } = parseFrontmatter(f.text);
          const d = rule.decide(frontmatter);
          const notes = d.note ? [d.note] : [];
          const problem = d.problem;
          if (!d.descriptionOnly) return [unit(tool.id, f.path, d.mode, d.trigger, body, { notes, problem })];
          const description = String(frontmatter.description ?? '');
          return [
            unit(tool.id, f.path, 'always', 'description shown to the agent', description, { part: 'description', notes }),
            unit(tool.id, f.path, d.mode, d.trigger, body, { part: 'body' }),
          ];
        });
    case 'skill':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .flatMap((f) => {
          const { frontmatter, body } = parseFrontmatter(f.text);
          const isRoot = f.path.startsWith(rule.rootPrefix);
          const hidden = rule.hideFlag ? frontmatter[rule.hideFlag] === true : false;
          const name = String(frontmatter.name ?? basename(dirname(f.path)) ?? '');
          let description = String(frontmatter.description ?? '') || firstParagraph(body);
          if (frontmatter.when_to_use) description += ' ' + String(frontmatter.when_to_use);
          const notes: string[] = [];
          if (rule.descriptionCap && description.length > rule.descriptionCap) {
            description = description.slice(0, rule.descriptionCap);
            notes.push(`Description cut to ${rule.descriptionCap} characters in the listing.`);
          }
          const listed = `${name}: ${description}`;
          const descMode: LoadMode = hidden ? 'manual' : isRoot ? 'always' : 'on-demand';
          const descTrigger = hidden
            ? `${rule.hideFlag}: true`
            : isRoot
              ? 'listed every session'
              : `listed when working in ${f.path.slice(0, f.path.indexOf('/.') + 1) || './'}`;
          return [
            unit(tool.id, f.path, descMode, descTrigger, listed, { part: 'description', notes }),
            unit(tool.id, f.path, hidden ? 'manual' : 'on-demand', rule.bodyTrigger, body, { part: 'body' }),
          ];
        });
    case 'hierarchical':
      return applyHierarchical(tool, rule, files, byPath);
  }
}

function applyHierarchical(
  tool: ToolSpec,
  rule: Extract<FileRule, { kind: 'hierarchical' }>,
  files: RepoFile[],
  byPath: Map<string, RepoFile>,
): LoadedUnit[] {
  const matches = files.filter((f) => rule.names.includes(basename(f.path)));
  if (!matches.length) return [];

  let conditionFails: string | null = null;
  if (rule.condition === 'claude-reads-agents-md' && files.some(isRootClaudeMd))
    conditionFails = 'CLAUDE.md exists at the root, so Claude Code reads it instead of AGENTS.md (default setting).';
  if (rule.condition === 'copilot-no-agents-md' && files.some((f) => basename(f.path) === 'AGENTS.md'))
    conditionFails = 'AGENTS.md exists, which Copilot uses instead.';

  const winners = new Map<string, RepoFile>();
  const out: LoadedUnit[] = [];
  for (const name of rule.names) {
    for (const f of matches.filter((m) => basename(m.path) === name)) {
      const level = levelOf(f.path, rule.sameLevelDirs);
      if (rule.onePerDirectory && winners.has(level)) {
        out.push(unit(tool.id, f.path, 'ignored', `${basename(winners.get(level)!.path)} takes precedence`, f.text));
        continue;
      }
      winners.set(level, f);
    }
  }

  for (const f of winners.values()) {
    if (conditionFails) {
      out.push(unit(tool.id, f.path, 'ignored', conditionFails, f.text));
      continue;
    }
    const level = levelOf(f.path, rule.sameLevelDirs);
    const isRoot = level === '';
    // Claude reads a subdirectory AGENTS.md only when that directory has no CLAUDE.md of its own.
    if (
      rule.condition === 'claude-reads-agents-md' &&
      !isRoot &&
      files.some((o) => /^CLAUDE(\.local)?\.md$/.test(basename(o.path)) && levelOf(o.path, ['.claude']) === level)
    ) {
      out.push(unit(tool.id, f.path, 'ignored', `CLAUDE.md in ${level}/ is read instead`, f.text));
      continue;
    }
    if (!isRoot && rule.nested === 'ignored') {
      out.push(unit(tool.id, f.path, 'ignored', 'only the root file is read', f.text));
      continue;
    }
    const mode: LoadMode = isRoot ? 'always' : 'on-demand';
    const trigger = isRoot ? 'project root' : `${rule.nestedTrigger} ${level}/`;
    const notes = rule.note ? [rule.note] : [];
    const text = transform(f.text, rule, notes);
    const main = unit(tool.id, f.path, mode, trigger, text, { notes });
    out.push(main);
    if (rule.importDepth) out.push(...expandImports(tool.id, main, rule, byPath, rule.importDepth));
  }
  return out;
}

function transform(text: string, rule: Extract<FileRule, { kind: 'hierarchical' }>, notes: string[]): string {
  let t = text;
  if (rule.stripHtmlComments) {
    const stripped = stripHtmlComments(t);
    if (stripped.length !== t.length) notes.push('HTML comments removed before counting (the tool strips them).');
    t = stripped;
  }
  if (rule.maxBytes) {
    const bytes = new TextEncoder().encode(t);
    if (bytes.length > rule.maxBytes) {
      t = new TextDecoder().decode(bytes.slice(0, rule.maxBytes)).replace(/�$/, '');
      notes.push(`Truncated: only the first ${rule.maxBytes} of ${bytes.length} bytes are read; the rest never reaches the agent.`);
    }
  }
  return t;
}

function expandImports(
  tool: ToolId,
  parent: LoadedUnit,
  rule: Extract<FileRule, { kind: 'hierarchical' }>,
  byPath: Map<string, RepoFile>,
  depth: number,
  seen: Set<string> = new Set([parent.path]),
): LoadedUnit[] {
  if (depth <= 0) return [];
  const out: LoadedUnit[] = [];
  for (const target of findImports(parent.text)) {
    const resolved = resolvePath(parent.path, target);
    if (resolved === null) {
      parent.notes.push(`@${target} points outside the repository and is not counted.`);
      continue;
    }
    if (seen.has(resolved)) continue;
    const f = byPath.get(resolved);
    if (!f) continue;
    seen.add(resolved);
    const notes: string[] = [];
    const child = unit(tool, f.path, parent.mode, parent.trigger, transform(f.text, rule, notes), {
      importedFrom: parent.path,
      notes,
    });
    out.push(child, ...expandImports(tool, child, rule, byPath, depth - 1, seen));
  }
  return out;
}

/**
 * A file can be reached twice by one tool (for example imported and also loaded directly).
 * Keep the strongest load for each (path, part).
 */
function dedupe(units: LoadedUnit[]): LoadedUnit[] {
  const rank: Record<LoadMode, number> = { always: 0, 'on-demand': 1, manual: 2, ignored: 3 };
  const best = new Map<string, LoadedUnit>();
  for (const u of units) {
    const key = `${u.path}\0${u.part}`;
    const prev = best.get(key);
    if (!prev || rank[u.mode] < rank[prev.mode]) best.set(key, u);
  }
  return units.filter((u) => best.get(`${u.path}\0${u.part}`) === u);
}
