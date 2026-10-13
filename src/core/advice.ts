import { dirname, linesWithFences, resolvePath, splitSections } from './markdown.js';
import { countO200k } from './tokenize.js';
import { TOOLS } from './tools.js';
import type { LoadedUnit, RepoFile, ToolId } from './types.js';

export type AdviceKind =
  | 'misconfigured'
  | 'size-limit'
  | 'duplicate'
  | 'contradiction'
  | 'oversized-section'
  | 'scopable-section'
  | 'non-english'
  | 'stale-reference';

export interface Advice {
  kind: AdviceKind;
  severity: 'high' | 'medium' | 'low';
  tools: ToolId[];
  paths: string[];
  line?: number;
  message: string;
  /** Estimated tokens saved per turn, counted with o200k_base as a reference. null when not applicable. */
  savingTokens: number | null;
  savingNote?: string;
}

export interface AdviceOptions {
  /** Checks whether a repo-relative path exists. Omit to skip stale-path checks (e.g. in the browser). */
  exists?: (path: string) => boolean;
  /** Script names from the root package.json; omit when there is none. */
  packageScripts?: Set<string>;
  /** English versions of files, keyed by repo path, supplied by the user or an opt-in translation. */
  english?: Map<string, string>;
  /** Sections at or above this many o200k tokens in always-loaded files are flagged. */
  sectionTokens?: number;
}

const DEFAULT_SECTION_TOKENS = 600;

export function buildAdvice(units: LoadedUnit[], files: RepoFile[], opts: AdviceOptions = {}): Advice[] {
  // User-level files take part in checks across files; moving sections or checking paths only makes sense in the repository.
  const repo = units.filter((u) => !u.scope);
  const advice: Advice[] = [
    ...misconfigured(units),
    ...sizeLimits(units, files),
    ...duplicates(units),
    ...contradictions(units),
    ...sections(repo, opts.sectionTokens ?? DEFAULT_SECTION_TOKENS),
    ...nonEnglish(units, opts.english),
    ...staleReferences(repo, opts),
  ];
  const order = { high: 0, medium: 1, low: 2 };
  return advice.sort((a, b) => order[a.severity] - order[b.severity] || (b.savingTokens ?? 0) - (a.savingTokens ?? 0));
}

/** Units that carry real instruction text (not skill descriptions), grouped by path. */
function contentUnits(units: LoadedUnit[], modes: Array<LoadedUnit['mode']> = ['always', 'on-demand']): LoadedUnit[] {
  return units.filter((u) => u.part !== 'description' && modes.includes(u.mode));
}

function uniqueByPath(units: LoadedUnit[]): LoadedUnit[] {
  const seen = new Map<string, LoadedUnit>();
  for (const u of units) if (!seen.has(u.path)) seen.set(u.path, u);
  return [...seen.values()];
}

function toolsWith(units: LoadedUnit[], path: string, mode: LoadedUnit['mode']): ToolId[] {
  return [...new Set(units.filter((u) => u.path === path && u.mode === mode && u.part !== 'description').map((u) => u.tool))];
}

function misconfigured(units: LoadedUnit[]): Advice[] {
  const byKey = new Map<string, Advice>();
  for (const u of units) {
    if (!u.problem) continue;
    const key = `${u.path}\0${u.problem}`;
    const prev = byKey.get(key);
    if (prev) prev.tools.push(u.tool);
    else
      byKey.set(key, {
        kind: 'misconfigured',
        severity: 'high',
        tools: [u.tool],
        paths: [u.path],
        message: u.problem,
        savingTokens: null,
        savingNote: 'Not loaded today; fixing it adds context.',
      });
  }
  return [...byKey.values()];
}

function sizeLimits(units: LoadedUnit[], files: RepoFile[]): Advice[] {
  const out: Advice[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const tool of TOOLS) {
    for (const limit of tool.limits) {
      for (const u of uniqueByPath(contentUnits(units.filter((x) => x.tool === tool.id)))) {
        const f = byPath.get(u.path);
        if (!f || !limit.pattern.test(u.path)) continue;
        let size: number;
        let overflow: string;
        if (limit.unit === 'lines') {
          const lines = f.text.split(/\r?\n/);
          size = lines.length;
          overflow = lines.slice(limit.max).join('\n');
        } else if (limit.unit === 'chars') {
          size = f.text.length;
          overflow = f.text.slice(limit.max);
        } else {
          const bytes = new TextEncoder().encode(f.text);
          size = bytes.length;
          overflow = new TextDecoder().decode(bytes.slice(limit.max));
        }
        if (size <= limit.max) continue;
        const notes = {
          truncate: `About ${countO200k(overflow)} tokens past the limit never reach the agent; move them somewhere it reads.`,
          limit: `About ${countO200k(overflow)} tokens are over the tool's limit; shorten the file.`,
          advice: 'Tokens beyond the recommended size.',
        };
        out.push({
          kind: 'size-limit',
          severity: limit.severity === 'advice' ? 'medium' : 'high',
          tools: [tool.id],
          paths: [u.path],
          message: `${size} ${limit.unit} (limit ${limit.max}). ${limit.text} Source: ${limit.source}`,
          savingTokens: limit.severity === 'advice' ? countO200k(overflow) : null,
          savingNote: notes[limit.severity],
        });
      }
    }
  }
  return out;
}

/** Lowercased, whitespace-collapsed form of a line without list markers or emphasis, used to compare lines. */
export function normalizeLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalized instruction lines long enough to be meaningful, mapped to their original text. */
export function normalizedLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { line, inFence } of linesWithFences(text)) {
    if (inFence) continue;
    const norm = normalizeLine(line);
    if (norm.length >= 30 && !norm.startsWith('#')) out.set(norm, line);
  }
  return out;
}

function duplicates(units: LoadedUnit[]): Advice[] {
  const files = uniqueByPath(contentUnits(units, ['always', 'on-demand', 'ignored']));
  const lines = files.map((u) => ({ path: u.path, lines: normalizedLines(u.text) }));
  const out: Advice[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      const shared = [...a.lines.keys()].filter((k) => b.lines.has(k));
      if (!shared.length) continue;
      const tokens = countO200k(shared.map((k) => a.lines.get(k)!).join('\n'));
      if (shared.length < 3 && tokens < 50) continue;
      const bothAlways = toolsWith(units, a.path, 'always').filter((t) => toolsWith(units, b.path, 'always').includes(t));
      out.push({
        kind: 'duplicate',
        severity: bothAlways.length ? 'high' : 'low',
        tools: bothAlways,
        paths: [a.path, b.path],
        message: bothAlways.length
          ? `${shared.length} identical lines are loaded twice every turn by ${bothAlways.join(', ')}. Keep them in one file.`
          : `${shared.length} identical lines are maintained in two files that different tools read. No tool pays twice, but the copies can drift; consider one source (for example a CLAUDE.md that imports @AGENTS.md).`,
        savingTokens: bothAlways.length ? tokens : 0,
        savingNote: bothAlways.length ? undefined : 'Maintenance only; no per-turn saving.',
      });
    }
  }
  return out;
}

interface Directive {
  topic: string;
  value: string;
  path: string;
  line: number;
  text: string;
}

interface DirectivePattern {
  topic: string;
  re: RegExp;
  value: (m: RegExpMatchArray) => string;
  /** Style rules are often per language ("4 spaces for Python"); a "for X" qualifier scopes the topic. */
  scoped?: boolean;
}

const DIRECTIVES: DirectivePattern[] = [
  {
    topic: 'package manager',
    re: /\b(?:use|prefer)\s+(npm|pnpm|yarn|bun)\b(?!\s+(?:run|scripts?)\b)/gi,
    value: (m) => m[1]!.toLowerCase(),
  },
  {
    topic: 'indentation',
    re: /\b(?:indent(?:ation)?\s+(?:with|using|of)\s+|use\s+)(tabs|\d(?=[- ]?spaces?\b))/gi,
    value: (m) => (m[1]!.toLowerCase() === 'tabs' ? 'tabs' : `${m[1]} spaces`),
    scoped: true,
  },
  {
    topic: 'indentation',
    re: /\b(\d)[- ]space indent(?:ation|s)?\b/gi,
    value: (m) => `${m[1]} spaces`,
    scoped: true,
  },
  {
    topic: 'quotes',
    re: /\b(?:use|prefer)\s+(single|double)\s+quotes\b/gi,
    value: (m) => m[1]!.toLowerCase(),
    scoped: true,
  },
  { topic: 'semicolons', re: /\b(?:use|add|require)\s+semicolons\b/gi, value: () => 'semicolons' },
  // Already negative: "no semicolons" means the same as "do not use semicolons".
  { topic: 'semicolons', re: /\b(?:no|omit|without)\s+semicolons\b/gi, value: () => 'not semicolons' },
];

/** Matches a negation right before a directive: "never use", "do not use", "don't prefer". */
const NEGATED = /\b(?:never|not|don['’]?t|avoid|no)\s+(?:\w+\s+)?$/i;

/** Words after "for"/"in" that do not name a language or file type, so they do not scope a style rule. */
const NOT_A_SCOPE = new Set(
  'indentation indent this the all every each any code files file everything general new our your my repo repository project here it them'.split(' '),
);

function directivesIn(line: string): Array<{ topic: string; value: string }> {
  const found: Array<{ topic: string; value: string }> = [];
  for (const d of DIRECTIVES) {
    for (const m of line.matchAll(d.re)) {
      let value = d.value(m);
      if (!value.startsWith('not ') && NEGATED.test(line.slice(0, m.index))) value = `not ${value}`;
      const rest = line.slice((m.index ?? 0) + m[0].length);
      const word = d.scoped
        ? /^[^.;]{0,25}?\b(?:for|in)\s+([A-Za-z][\w.+#-]*)/.exec(rest)?.[1]?.replace(/[.-]+$/, '')
        : undefined;
      const scope = word && !NOT_A_SCOPE.has(word.toLowerCase()) ? word : undefined;
      found.push({ topic: scope ? `${d.topic} (${scope.toLowerCase()})` : d.topic, value });
    }
  }
  return found;
}

/** "not x" conflicts only with "x"; two positive values conflict when they differ. */
function conflicts(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.startsWith('not ') || b.startsWith('not ')) return a === `not ${b}` || b === `not ${a}`;
  return true;
}

function contradictions(units: LoadedUnit[]): Advice[] {
  const found = new Map<string, Advice>();
  const tools = [...new Set(units.map((u) => u.tool))];
  for (const tool of tools) {
    const directives: Directive[] = [];
    for (const u of uniqueByPath(contentUnits(units.filter((x) => x.tool === tool), ['always']))) {
      linesWithFences(u.text).forEach(({ line, inFence }, i) => {
        if (inFence) return;
        for (const d of directivesIn(line)) directives.push({ ...d, path: u.path, line: i + 1, text: line.trim() });
      });
    }
    for (let i = 0; i < directives.length; i++) {
      for (let j = i + 1; j < directives.length; j++) {
        const a = directives[i]!;
        const b = directives[j]!;
        if (a.topic !== b.topic || !conflicts(a.value, b.value)) continue;
        const key = [a.topic, `${a.path}:${a.line}`, `${b.path}:${b.line}`].join('|');
        const prev = found.get(key);
        if (prev) {
          prev.tools.push(tool);
          continue;
        }
        const shorter = a.text.length <= b.text.length ? a.text : b.text;
        found.set(key, {
          kind: 'contradiction',
          severity: 'high',
          tools: [tool],
          paths: [...new Set([a.path, b.path])],
          message: `Conflicting ${a.topic}: "${a.text}" (${a.path}:${a.line}) vs "${b.text}" (${b.path}:${b.line}).`,
          savingTokens: countO200k(shorter),
          savingNote: 'Removing the outdated line.',
        });
      }
    }
  }
  return [...found.values()];
}

/** Path-like references: backticked paths, or bare tokens with a slash and a file extension / trailing slash. */
export function pathRefs(text: string): string[] {
  const refs: string[] = [];
  for (const { line, inFence } of linesWithFences(text)) {
    if (inFence) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) refs.push(m[1]!);
    const bare = line.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const m of bare.matchAll(/(?:^|[\s(])((?:\.{0,2}[\w-][\w.-]*\/)+(?:[\w-][\w.-]*\.[a-z0-9]+|))(?=[\s),.;:]|$)/gi))
      refs.push(m[1]!);
  }
  return refs
    .map((r) => r.replace(/^\.\//, '').replace(/[),.;:]+$/, ''))
    .filter((r) => r.includes('/') && !/^(https?:|~|\/|[A-Za-z]:|@|<)/.test(r) && !/[*?{}<>$]/.test(r));
}

function sections(units: LoadedUnit[], threshold: number): Advice[] {
  const out: Advice[] = [];
  for (const u of uniqueByPath(contentUnits(units, ['always']))) {
    const tools = toolsWith(units, u.path, 'always');
    for (const s of splitSections(u.text)) {
      const tokens = countO200k(s.text);
      const scope = sectionScope(s.text);
      if (scope) {
        out.push({
          kind: 'scopable-section',
          severity: 'medium',
          tools,
          paths: [u.path],
          line: s.line,
          message: `Section "${s.heading}" is mostly about ${scope}/. Move it to ${scope}/AGENTS.md (or CLAUDE.md), a path-scoped rule, or an instructions file with applyTo so it loads only when the agent works there.`,
          savingTokens: tokens,
          savingNote: 'Saved on turns that do not touch that directory.',
        });
      } else if (tokens >= threshold) {
        out.push({
          kind: 'oversized-section',
          severity: 'medium',
          tools,
          paths: [u.path],
          line: s.line,
          message: `Section "${s.heading}" is ${tokens} tokens and loads every turn. If it is a procedure (release, deploy, migration), move it into an on-demand skill or rule and keep a one-line pointer.`,
          savingTokens: Math.max(0, tokens - 30),
          savingNote: 'Assumes about 30 tokens remain for the skill description or pointer.',
        });
      }
    }
  }
  return out;
}

/** The directory a section is mostly about (for example `packages/api`), or null when it is not scopable. */
export function sectionScope(text: string): string | null {
  if (countO200k(text) < 100) return null;
  const refs = pathRefs(text).filter((r) => !r.startsWith('.'));
  const dirs = refs.map((r) => r.split('/')[0]!);
  const top = mostCommon(dirs);
  if (!top || top.count < 2 || top.count / dirs.length < 0.6) return null;
  return commonDir(refs.filter((r) => r.startsWith(top.value + '/')));
}

/** Longest directory prefix shared by all refs, e.g. `packages/api` for `packages/api/db.ts` and `packages/api/handlers/`. */
function commonDir(refs: string[]): string {
  const dirs = refs.map((r) => (r.endsWith('/') ? r.slice(0, -1) : r.slice(0, r.lastIndexOf('/'))).split('/'));
  const first = dirs[0] ?? [];
  let n = first.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && d[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, Math.max(1, n)).join('/');
}

function mostCommon(values: string[]): { value: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: string; count: number } | null = null;
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count };
  return best;
}

const EN_STOPWORDS = new Set(
  'the a an and or of to in on for with is are be it this that as by at from not do does use when if you your we our all any must should can will before after into only than then'.split(
    ' ',
  ),
);

const SCRIPTS: Array<[string, RegExp]> = [
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['CJK', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
];

export interface LanguageGuess {
  nonEnglish: boolean;
  script: string;
}

/** Script- and stopword-based guess. Deterministic; it does not name the language. */
export function guessLanguage(text: string): LanguageGuess {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const letters = [...prose].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 40) return { nonEnglish: false, script: 'Latin' };
  for (const [name, re] of SCRIPTS) {
    const n = letters.filter((c) => re.test(c)).length;
    if (n / letters.length > 0.2) return { nonEnglish: true, script: name };
  }
  const words = prose.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 15) return { nonEnglish: false, script: 'Latin' };
  const stop = words.filter((w) => EN_STOPWORDS.has(w)).length / words.length;
  const diacritics = letters.filter((c) => /[^\u0000-\u007F]/.test(c)).length / letters.length;
  return { nonEnglish: stop < 0.12 || (diacritics > 0.03 && stop < 0.2), script: 'Latin' };
}

/** True when any heading section of the text looks non-English. */
export function hasNonEnglish(text: string): boolean {
  return splitSections(text).some((s) => guessLanguage(s.text).nonEnglish);
}

function nonEnglish(units: LoadedUnit[], english?: Map<string, string>): Advice[] {
  const out: Advice[] = [];
  for (const u of uniqueByPath(contentUnits(units, ['always']))) {
    const parts = splitSections(u.text).filter((s) => guessLanguage(s.text).nonEnglish);
    if (!parts.length) continue;
    const script = guessLanguage(parts.map((p) => p.text).join('\n')).script;
    const tools = toolsWith(units, u.path, 'always');
    const tokens = countO200k(parts.map((p) => p.text).join('\n'));
    const en = english?.get(u.path);
    if (en !== undefined) {
      const fileTokens = countO200k(u.text);
      const enTokens = countO200k(en);
      const multiplier = enTokens ? fileTokens / enTokens : 0;
      out.push({
        kind: 'non-english',
        severity: multiplier > 1.1 ? 'medium' : 'low',
        tools,
        paths: [u.path],
        message: `${parts.length} section(s) in ${script} script look non-English. Measured: ${fileTokens} tokens vs ${enTokens} for the English version (x${multiplier.toFixed(2)}).`,
        savingTokens: Math.max(0, fileTokens - enTokens),
        savingNote: 'Measured against the English version you supplied or opted to translate.',
      });
    } else {
      out.push({
        kind: 'non-english',
        severity: 'low',
        tools,
        paths: [u.path],
        line: parts[0]!.line,
        message: `${parts.length} section(s) (${tokens} tokens) in ${script} script look non-English. Pass --english ${u.path}=<english file> or --translate to measure the multiplier.`,
        savingTokens: null,
        savingNote: 'Not measured without an English version.',
      });
    }
  }
  return out;
}

/** True for instruction files that live in a package subdirectory rather than at the root or in a root tool folder. */
function isNested(path: string): boolean {
  const dir = dirname(path);
  return dir !== '' && !/^\.(claude|github|cursor|windsurf|devin|agents|clinerules|cline|roo|kiro|junie|continue)(\/|$)/.test(dir);
}

function staleReferences(units: LoadedUnit[], opts: AdviceOptions): Advice[] {
  const out: Advice[] = [];
  for (const u of uniqueByPath(contentUnits(units))) {
    const tools = [...new Set(units.filter((x) => x.path === u.path && x.mode !== 'ignored').map((x) => x.tool))];
    const missing: Array<{ ref: string; line: string; n: number }> = [];
    linesWithFences(u.text).forEach(({ line, inFence }, i) => {
      if (inFence) return;
      if (opts.exists) {
        for (const ref of pathRefs(line)) {
          // Directory mentions are often conventions ("put guides under docs/guides/"), so only files are checked.
          if (!/\/[^/]+\.[A-Za-z0-9]+$/.test(ref)) continue;
          const first = ref.split('/')[0]!;
          if (/^(path|example|foo|your|my)/i.test(first)) continue;
          // Only flag when the top-level folder exists but the file does not: likely moved or deleted.
          // Paths may be written relative to the repository root or to the instruction file.
          const local = resolvePath(u.path, ref);
          if (opts.exists(first) && !opts.exists(ref) && !(local && opts.exists(local))) missing.push({ ref, line, n: i + 1 });
        }
      }
      // Root package.json scripts only apply to root-level instruction files, not nested packages.
      if (opts.packageScripts && !isNested(u.path)) {
        for (const m of line.matchAll(/\b(?:npm|pnpm|yarn|bun) run (?!-)([\w:.-]+)/g)) {
          if (!opts.packageScripts.has(m[1]!)) missing.push({ ref: `script "${m[1]}"`, line, n: i + 1 });
        }
      }
    });
    if (!missing.length) continue;
    const uniqueLines = [...new Set(missing.map((m) => m.line))];
    out.push({
      kind: 'stale-reference',
      severity: 'medium',
      tools,
      paths: [u.path],
      line: missing[0]!.n,
      message: `References that no longer exist: ${[...new Set(missing.map((m) => `${m.ref} (line ${m.n})`))].join(', ')}.`,
      savingTokens: countO200k(uniqueLines.join('\n')),
      savingNote: 'If those lines are obsolete; update them instead if they are still relevant.',
    });
  }
  return out;
}
