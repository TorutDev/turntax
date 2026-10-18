import { globToRegExp } from './glob.js';
import { basename, configList, dirname, findImports, firstParagraph, parseFrontmatter, resolvePath, stripHtmlComments } from './markdown.js';
import { TOOLS, type FileRule, type Frontmatter, type ToolSpec } from './tools.js';
import type { LoadMode, LoadedUnit, RepoFile, ToolId } from './types.js';

/** Works out which files each tool loads, when, and with what text. */
export function classify(input: RepoFile[], toolIds?: ToolId[]): LoadedUnit[] {
  // Same text on every platform: a CRLF checkout must not count or compare differently.
  const files = input.map((f) => ({ path: f.path, text: f.text.replace(/\r\n/g, '\n') }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tools = toolIds ? TOOLS.filter((t) => toolIds.includes(t.id)) : TOOLS;
  const units: LoadedUnit[] = [];
  for (const tool of tools) {
    const toolUnits: LoadedUnit[] = [];
    const claims: SkillClaims = new Map();
    for (const rule of tool.rules) toolUnits.push(...applyRule(tool, rule, files, byPath, claims));
    units.push(...dedupe(toolUnits));
  }
  return units;
}

/** Skill names taken per level (`<dir>\0<name>`), with the file and rule that took them. */
type SkillClaims = Map<string, { path: string; rule: FileRule }>;

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

/** Directory holding a nested copy of a folder, e.g. `pkg/` for `pkg/.claude/skills/x/SKILL.md`; '' at the root. */
function nestedDir(path: string, rootPrefix: string): string {
  if (path.startsWith(rootPrefix)) return '';
  const i = path.indexOf('/' + rootPrefix);
  return i < 0 ? path.slice(0, path.indexOf('/.') + 1) : path.slice(0, i + 1);
}

const fmText = (v: Frontmatter[string] | undefined): string => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

/** A skill's name: frontmatter `name`, else its folder (SKILL.md) or its path below the folder (`frontend:component`). */
function skillName(path: string, rootPrefix: string, frontmatter: Frontmatter): string {
  if (frontmatter.name !== undefined && String(frontmatter.name) !== '') return String(frontmatter.name);
  if (basename(path) === 'SKILL.md') return basename(dirname(path));
  const rel = path.slice(path.indexOf(rootPrefix) + rootPrefix.length);
  return rel.replace(/\.md$/, '').split('/').join(':');
}

function applyRule(
  tool: ToolSpec,
  rule: FileRule,
  files: RepoFile[],
  byPath: Map<string, RepoFile>,
  claims: SkillClaims,
): LoadedUnit[] {
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
    case 'pattern':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .map((f) => unit(tool.id, f.path, rule.mode, rule.trigger, f.text, { notes: rule.note ? [rule.note] : [] }));
    case 'precedence': {
      const inGroup = (g: (typeof rule.groups)[number]) => files.filter((f) => g.patterns.some((p) => p.test(f.path)));
      const winner = rule.groups.find((g) => inGroup(g).length > 0);
      if (!winner) return [];
      return rule.groups.flatMap((g) =>
        inGroup(g).map((f) =>
          g === winner
            ? unit(tool.id, f.path, 'always', 'project instructions', f.text, { notes: rule.note ? [rule.note] : [] })
            : unit(tool.id, f.path, 'ignored', `${winner.label} takes precedence`, f.text),
        ),
      );
    }
    case 'config-list': {
      const config = byPath.get(rule.configPath);
      if (!config) return [];
      return configList(config, rule.key)
        .map((p) => byPath.get(p))
        .filter((f): f is RepoFile => f !== undefined)
        .map((f) => unit(tool.id, f.path, 'always', rule.trigger, f.text));
    }
    case 'frontmatter':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .flatMap((f) => {
          const { frontmatter, body } = parseFrontmatter(f.text);
          const d = rule.decide(frontmatter);
          const notes = d.note ? [d.note] : [];
          const problem = d.problem;
          // A rule folder inside a subdirectory only applies when the agent works there.
          const nestedIn = rule.rootPrefixes.some((p) => f.path.startsWith(p)) ? null : f.path.slice(0, f.path.indexOf('/.') + 1);
          const scoped = (mode: LoadMode, trigger: string): [LoadMode, string] =>
            nestedIn && mode === 'always' ? ['on-demand', `when working in ${nestedIn}`] : [mode, trigger];
          if (!d.descriptionOnly) {
            const [mode, trigger] = scoped(d.mode, d.trigger);
            return [unit(tool.id, f.path, mode, trigger, body, { notes, problem })];
          }
          const description = String(frontmatter.description ?? '');
          const [descMode, descTrigger] = scoped('always', 'description shown to the agent');
          return [
            unit(tool.id, f.path, descMode, descTrigger, description, { part: 'description', notes }),
            unit(tool.id, f.path, d.mode, d.trigger, body, { part: 'body' }),
          ];
        });
    case 'skill':
      return files
        .filter((f) => rule.pattern.test(f.path))
        .flatMap((f) => {
          const { frontmatter, body } = parseFrontmatter(f.text);
          const dir = nestedDir(f.path, rule.rootPrefix);
          const name = skillName(f.path, rule.rootPrefix, frontmatter);
          let description = String(frontmatter.description ?? '') || firstParagraph(body);
          if (frontmatter.when_to_use) description += ' ' + String(frontmatter.when_to_use);
          const notes: string[] = [];
          if (rule.descriptionCap && description.length > rule.descriptionCap) {
            description = description.slice(0, rule.descriptionCap);
            notes.push(`Description cut to ${rule.descriptionCap} characters in the listing.`);
          }
          const listed = `${name}: ${description}${rule.listsPath ? ` (${f.path})` : ''}`;
          const skip = (reason: string) => [
            unit(tool.id, f.path, 'ignored', reason, listed, { part: 'description' }),
            unit(tool.id, f.path, 'ignored', reason, body, { part: 'body' }),
          ];
          if (dir && rule.nested === 'ignored') return skip(`${rule.nestedTrigger ?? 'not read from the root'} ${dir}`);
          if (rule.dedupeByName) {
            // The first rule (in the tool's precedence order) to list a name at this level keeps it.
            const key = `${dir}\0${name}`;
            const prev = claims.get(key);
            if (prev && prev.rule !== rule) return skip(`same skill name as ${prev.path}, which takes precedence`);
            if (!prev) claims.set(key, { path: f.path, rule });
          }
          const hidden = rule.hideFlag ? frontmatter[rule.hideFlag] === true : false;
          const pathsKey = rule.pathsKeys?.find((k) => fmText(frontmatter[k]).trim() !== '');
          const [descMode, descTrigger]: [LoadMode, string] = hidden
            ? ['manual', `${rule.hideFlag}: true`]
            : dir
              ? ['on-demand', `${rule.nestedTrigger ?? 'listed when working in'} ${dir}`]
              : pathsKey
                ? ['on-demand', `${pathsKey}: ${fmText(frontmatter[pathsKey])}`]
                : ['always', 'listed every session'];
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

  // Every matching file is read, except where the tool reads only one file per directory.
  const firstPerLevel = new Map<string, RepoFile>();
  const read: RepoFile[] = [];
  const out: LoadedUnit[] = [];
  for (const name of rule.names) {
    for (const f of matches.filter((m) => basename(m.path) === name)) {
      const level = levelOf(f.path, rule.sameLevelDirs);
      // The docs do not say when subdirectory copies load, so they are not counted either way.
      if (level !== '' && rule.nested === 'skip') continue;
      const first = firstPerLevel.get(level);
      if (rule.onePerDirectory && first) {
        out.push(unit(tool.id, f.path, 'ignored', `${basename(first.path)} takes precedence`, f.text));
        continue;
      }
      if (!first) firstPerLevel.set(level, f);
      read.push(f);
    }
  }

  for (const f of read) {
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
      out.push(unit(tool.id, f.path, 'ignored', rule.nestedTrigger || 'only the root file is read', f.text));
      continue;
    }
    const mode: LoadMode = isRoot || rule.nested === 'always' ? 'always' : 'on-demand';
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
    // A glob mention pulls in every matching file, but only for tools that expand globs.
    const re = resolved.includes('*') ? globToRegExp(resolved) : null;
    const targets = !re ? [resolved] : rule.globMentions ? [...byPath.keys()].filter((p) => re.test(p)).sort() : [];
    for (const path of targets) {
      if (seen.has(path)) continue;
      const f = byPath.get(path);
      if (!f) continue;
      seen.add(path);
      const notes: string[] = [];
      let mode = parent.mode;
      let trigger = parent.trigger;
      let text = f.text;
      if (rule.importGlobs) {
        const { frontmatter, body } = parseFrontmatter(f.text);
        if (frontmatter.globs !== undefined && String(frontmatter.globs) !== '') {
          mode = 'on-demand';
          trigger = `globs: ${Array.isArray(frontmatter.globs) ? frontmatter.globs.join(', ') : String(frontmatter.globs)}`;
          text = body;
        }
      }
      const child = unit(tool, f.path, mode, trigger, transform(text, rule, notes), {
        importedFrom: parent.path,
        notes,
      });
      out.push(child, ...expandImports(tool, child, rule, byPath, depth - 1, seen));
    }
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
