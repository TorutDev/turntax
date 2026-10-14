#!/usr/bin/env node
/**
 * Builds the "State of agent instruction files" dataset from popular public GitHub repositories.
 *
 *   npm run build
 *   GITHUB_TOKEN=$(gh auth token) node scripts/state-of.mjs [--limit 100] [--out web/state/2026-10.json]
 *
 * Talks only to api.github.com (with the token) and raw.githubusercontent.com (without it).
 * Every file is read at the default branch's head commit, pinned by SHA.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { audit } from '../dist/core/audit.js';
import { MAX_DEPTH, addImports, isInstructionFile, isSkippedDir } from '../dist/core/files.js';
import { planFixes } from '../dist/core/fix.js';
import { findImports, resolvePath } from '../dist/core/markdown.js';
import { countO200k } from '../dist/core/tokenize.js';
import { TOOLS } from '../dist/core/tools.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIN_STARS = 1000;
const PUSHED_SINCE = '2026-07-14';
const QUERY = `stars:>=${MIN_STARS} archived:false fork:false is:public pushed:>=${PUSHED_SINCE}`;
const MAX_RESULTS = 1000;
/** Folders that hold test data or examples; instruction files inside them are not counted. Case-insensitive. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'testdata', 'examples', 'example', 'samples']);
/** Same per-file cap as the CLI. */
const MAX_BYTES = 2 * 1024 * 1024;
const REPO_CONCURRENCY = 4;
const FILE_CONCURRENCY = 8;

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '100' },
    out: { type: 'string', default: resolve(ROOT, 'web/state/2026-10.json') },
  },
});
const LIMIT = Number(args.limit);
if (!Number.isInteger(LIMIT) || LIMIT <= 0) fail('--limit must be a positive integer.');
const OUT = resolve(args.out);

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) fail('GITHUB_TOKEN is not set. Run: GITHUB_TOKEN=$(gh auth token) node scripts/state-of.mjs');

function fail(message) {
  process.stderr.write(`state-of: ${message}\n`);
  process.exit(1);
}

const log = (line) => process.stderr.write(line + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sum = (values) => values.reduce((a, b) => a + b, 0);

class HttpError extends Error {
  constructor(status, path) {
    super(`HTTP ${status} for ${path}`);
    this.status = status;
  }
}

async function waitForReset(reset, why) {
  const ms = Math.max(0, reset * 1000 - Date.now()) + 2000;
  log(`  rate limit (${why}): waiting ${Math.ceil(ms / 1000)}s`);
  await sleep(ms);
}

/** GitHub REST call with the token. Waits out primary and secondary rate limits; retries server errors. */
async function api(path, accept = 'application/vnd.github+json') {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: accept, Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'turntax-state-of' },
      });
    } catch {
      if (attempt < 4) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new HttpError('network', path);
    }
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const resource = res.headers.get('x-ratelimit-resource') ?? 'core';
    if (res.ok) {
      const body = accept.endsWith('.sha') ? await res.text() : await res.json();
      if (res.headers.has('x-ratelimit-remaining') && remaining <= (resource === 'search' ? 1 : 25)) await waitForReset(reset, resource);
      return body;
    }
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter) {
        log(`  secondary rate limit: waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (remaining === 0 && reset) {
        await waitForReset(reset, resource);
        continue;
      }
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new HttpError(res.status, path);
  }
}

/** File text at a pinned commit, decoded like the CLI's readFileSync (a BOM is kept); null when missing. */
async function raw(fullName, sha, path) {
  const url = `https://raw.githubusercontent.com/${fullName}/${sha}/${encodePath(path)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'turntax-state-of' } });
      if (res.ok) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
      if (res.status === 404) return null;
    } catch {
      // retried below
    }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`could not download ${fullName}@${sha}:${path}`);
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Same filter as the CLI and the web page: no part of the path is a skipped folder. */
function keepPath(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) if (isSkippedDir(parts.slice(0, i).join('/'))) return false;
  return true;
}

const inTestData = (path) => path.split('/').slice(0, -1).some((seg) => TEST_DIRS.has(seg.toLowerCase()));
/** The CLI does not descend more than MAX_DEPTH folders. */
const withinDepth = (path) => path.split('/').length - 1 <= MAX_DEPTH;

/** Groups instruction file paths into the names people know them by. */
const LABELS = [
  [/(^|\/)\.cursor\/rules\/.+\.mdc$/, '.cursor/rules/*.mdc'],
  [/(^|\/)\.cursor\/rules\/.+\.md$/, '.cursor/rules/*.md'],
  [/^\.github\/copilot-instructions\.md$/, '.github/copilot-instructions.md'],
  [/^\.github\/instructions\//, '.github/instructions/*.instructions.md'],
  [/(^|\/)\.claude\/skills\//, '.claude/skills/*/SKILL.md'],
  [/(^|\/)\.claude\/commands\//, '.claude/commands/*.md'],
  [/(^|\/)\.claude\/agents\//, '.claude/agents/*.md'],
  [/(^|\/)\.claude\/rules\//, '.claude/rules/*.md'],
  [/(^|\/)\.agents\/skills\//, '.agents/skills/*/SKILL.md'],
  [/(^|\/)\.windsurf\/rules\//, '.windsurf/rules/*.md'],
  [/(^|\/)\.devin\/rules\//, '.devin/rules/*.md'],
  [/^\.(clinerules|cline\/rules)\//, '.clinerules/*.md'],
  [/^\.roo\/rules/, '.roo/rules*/'],
  [/^\.roorules-/, '.roorules-*'],
  [/^\.kiro\/steering\//, '.kiro/steering/*.md'],
  [/^\.junie\//, '.junie/*.md'],
  [/^\.continue\/rules\//, '.continue/rules/*.md'],
];
const labelOf = (path) => LABELS.find(([re]) => re.test(path))?.[1] ?? path.slice(path.lastIndexOf('/') + 1);

const ADVICE_KINDS = ['duplicate', 'contradiction', 'misconfigured', 'size-limit', 'oversized-section', 'scopable-section', 'stale-reference', 'non-english'];

async function searchRepos() {
  const items = [];
  const seen = new Set();
  let total = 0;
  let incomplete = false;
  for (let page = 1; items.length < MAX_RESULTS && page <= MAX_RESULTS / 100; page++) {
    const q = encodeURIComponent(QUERY);
    const res = await api(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`);
    total = res.total_count;
    incomplete ||= res.incomplete_results;
    for (const r of res.items) {
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      items.push(r);
    }
    if (res.items.length < 100) break;
  }
  return { items, total, incomplete };
}

/** Looks at one repository; returns its record when it has instruction files. */
async function scan(item) {
  try {
    return await scanRepo(item);
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

async function scanRepo(item) {
  const fullName = item.full_name;
  const sha = (await api(`/repos/${fullName}/commits/${encodeURIComponent(item.default_branch)}`, 'application/vnd.github.sha')).trim();
  const tree = await api(`/repos/${fullName}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) return { status: 'truncated' };

  const blobs = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
  const existing = new Set();
  for (const e of tree.tree) {
    const parts = e.path.split('/');
    for (let i = 1; i <= parts.length; i++) existing.add(parts.slice(0, i).join('/'));
  }
  const candidates = [...blobs.keys()]
    .filter((p) => isInstructionFile(p) && keepPath(p) && withinDepth(p) && !inTestData(p))
    .sort();
  if (!candidates.length) return { status: 'none' };

  // Symlinks: raw.githubusercontent.com serves the target path, so the target is read instead (one level).
  const links = new Map();
  const tooLarge = [];
  const read = async (path) => {
    const blob = blobs.get(path);
    if (!blob || !keepPath(path)) return null;
    if (blob.mode === '120000') {
      const target = (await raw(fullName, sha, path))?.trim();
      const resolved = target && /^[^\n]{1,512}$/.test(target) ? resolvePath(path, target) : null;
      const real = resolved ? blobs.get(resolved) : undefined;
      if (!real || real.mode === '120000') return null;
      links.set(path, resolved);
      return read(resolved);
    }
    if (blob.size > MAX_BYTES) {
      tooLarge.push(path);
      return null;
    }
    return raw(fullName, sha, path);
  };

  const texts = await mapLimited(candidates, FILE_CONCURRENCY, read);
  const found = new Map();
  const unreadable = [];
  candidates.forEach((path, i) => {
    if (texts[i] === null) unreadable.push(path);
    else found.set(path, { path, text: texts[i] });
  });
  const direct = new Set(found.keys());
  await addImports(found, read);
  const files = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));

  const exists = (p) => existing.has(p);
  const report = await audit(files, { models: [], advice: { exists } });
  const linked = new Set([...links.keys(), ...links.values()]);
  const plan = planFixes(files, { exists, readOnly: (p) => linked.has(p) });

  const agents = Object.fromEntries(report.tools.map((t) => [t.tool, t.perTurnO200k]));
  // A symlink and its target are one file. Agents that read both names (Cursor reads AGENTS.md and CLAUDE.md)
  // are counted twice by the engine, as the CLI does; this variant counts each real file once per agent.
  const real = (p) => links.get(p) ?? p;
  const agentsLinksOnce = {};
  for (const t of report.tools) {
    const once = new Map();
    for (const row of report.files)
      if (row.tool === t.tool && row.mode === 'always' && !row.scope) once.set(`${real(row.path)}\0${row.part}`, row.o200k);
    agentsLinksOnce[t.tool] = sum([...once.values()]);
  }

  const byKind = {};
  const linkPairs = { high: 0, low: 0 };
  for (const a of report.advice) {
    byKind[a.kind] ??= { high: 0, medium: 0, low: 0 };
    byKind[a.kind][a.severity]++;
    if (a.kind === 'duplicate' && a.paths.length === 2 && real(a.paths[0]) === real(a.paths[1])) linkPairs[a.severity]++;
  }
  const has = (kind) => kind in byKind;
  const duplicates = (severity) => (byKind.duplicate?.[severity] ?? 0) - linkPairs[severity];

  return {
    status: 'qualifying',
    record: {
      full_name: fullName,
      stars: item.stargazers_count,
      language: item.language ?? null,
      default_branch: item.default_branch,
      sha,
      files: files.map((f) => ({
        path: f.path,
        o200k: countO200k(f.text),
        ...(direct.has(f.path) ? {} : { imported: true }),
        ...(links.has(f.path) ? { linkTo: links.get(f.path) } : {}),
      })),
      ...(unreadable.length ? { unreadable } : {}),
      ...(tooLarge.length ? { tooLarge } : {}),
      agents,
      maxPerTurn: maxOf(agents),
      ...(links.size ? { maxPerTurnLinksOnce: maxOf(agentsLinksOnce) } : {}),
      agentsReading: report.tools.length,
      agentsEveryTurn: report.tools.filter((t) => t.perTurnO200k > 0).length,
      advice: {
        total: report.advice.length,
        byKind: Object.fromEntries(ADVICE_KINDS.filter(has).map((k) => [k, byKind[k]])),
        // Duplicate findings between a symlink and its target (already included in byKind.duplicate).
        ...(linkPairs.high + linkPairs.low ? { duplicateLinkPairs: linkPairs } : {}),
      },
      flags: {
        // Duplicates between two different files; a symlink and its target are not two files.
        duplicate: duplicates('high') + duplicates('low') > 0,
        duplicateEveryTurn: duplicates('high') > 0,
        duplicateAcrossAgents: duplicates('low') > 0,
        linkedFileReadTwice: linkPairs.high > 0,
        contradiction: has('contradiction'),
        misconfigured: has('misconfigured'),
        sizeLimit: has('size-limit'),
      },
      fixes: { count: plan.fixes.length, savingO200k: sum(plan.fixes.map((f) => f.savingTokens ?? 0)) },
      // Kept only for the summary below; removed before writing.
      _rootPair: rootPair(files, real),
    },
  };
}

/** The agent that loads the most every turn (the first in TOOLS order on a tie); null when none loads anything. */
function maxOf(perAgent) {
  let max = { o200k: 0, agent: null };
  for (const [agent, o200k] of Object.entries(perAgent)) if (o200k > max.o200k) max = { o200k, agent };
  return max;
}

/** Root AGENTS.md next to a root CLAUDE.md, and whether one points to the other (symlink or @import). */
function rootPair(files, real) {
  const agents = files.find((f) => f.path === 'AGENTS.md');
  const claude = files.find((f) => f.path === 'CLAUDE.md') ?? files.find((f) => f.path === '.claude/CLAUDE.md');
  if (!agents || !claude) return null;
  const imports = (from, to) => findImports(from.text).some((t) => real(resolvePath(from.path, t) ?? '') === real(to.path));
  return { linked: real(claude.path) === real(agents.path) || imports(claude, agents) || imports(agents, claude) };
}

/** Linear interpolation between closest ranks (as Excel PERCENTILE.INC and numpy's default), rounded. */
function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}

const share = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : 0);

function distribution(values) {
  return {
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

function summarize(repos) {
  const n = repos.length;
  const count = (pred) => repos.filter(pred).length;
  const flagged = (flag) => ({ repos: count((r) => r.flags[flag]), share: share(count((r) => r.flags[flag]), n) });

  const findings = {};
  for (const kind of ADVICE_KINDS) {
    const repoCount = count((r) => kind in r.advice.byKind);
    findings[kind] = { repos: repoCount, share: share(repoCount, n) };
    for (const sev of ['high', 'medium', 'low']) {
      const c = count((r) => (r.advice.byKind[kind]?.[sev] ?? 0) > 0);
      if (c) findings[kind][sev] = c;
    }
  }

  const names = new Map();
  for (const r of repos) for (const label of new Set(r.files.filter((f) => !f.imported).map((f) => labelOf(f.path)))) names.set(label, (names.get(label) ?? 0) + 1);
  const fileNames = [...names]
    .map(([name, c]) => ({ name, repos: c, share: share(c, n) }))
    .sort((a, b) => b.repos - a.repos || a.name.localeCompare(b.name));

  const pairs = repos.map((r) => r._rootPair).filter(Boolean);
  const savings = repos.map((r) => r.fixes.savingO200k);
  const withFix = repos.filter((r) => r.fixes.count > 0);
  const withSaving = repos.filter((r) => r.fixes.savingO200k > 0);

  return {
    repos: n,
    maxPerTurnO200k: distribution(repos.map((r) => r.maxPerTurn.o200k)),
    // Same, with a symlink and its target counted once per agent.
    maxPerTurnO200kLinksOnce: distribution(repos.map((r) => (r.maxPerTurnLinksOnce ?? r.maxPerTurn).o200k)),
    reposWithLinkedFiles: count((r) => r.files.some((f) => f.linkTo)),
    findings,
    // Duplicate findings between two different files, and those only between a symlink and its target.
    duplicates: {
      any: flagged('duplicate'),
      everyTurn: flagged('duplicateEveryTurn'),
      acrossAgents: flagged('duplicateAcrossAgents'),
      linkedFileReadTwice: flagged('linkedFileReadTwice'),
    },
    fileNames,
    agentsAndClaudeAtRoot: { repos: pairs.length, share: share(pairs.length, n), linked: pairs.filter((p) => p.linked).length },
    agentsReading: { median: percentile(repos.map((r) => r.agentsReading), 0.5) },
    fixes: {
      repos: withFix.length,
      share: share(withFix.length, n),
      reposWithSaving: withSaving.length,
      count: sum(repos.map((r) => r.fixes.count)),
      totalSavingO200k: sum(savings),
      medianSavingO200k: percentile(savings, 0.5),
      medianSavingAmongReposWithSavingO200k: percentile(withSaving.map((r) => r.fixes.savingO200k), 0.5),
    },
    // Ranked with a symlinked file counted once: whether agents read a linked file twice is not documented.
    heaviest: [...repos]
      .map((r) => ({ r, once: (r.maxPerTurnLinksOnce ?? r.maxPerTurn).o200k }))
      .sort((a, b) => b.once - a.once || a.r.full_name.localeCompare(b.r.full_name))
      .slice(0, 10)
      .map(({ r, once }) => ({ full_name: r.full_name, o200k: once, ...(once !== r.maxPerTurn.o200k ? { o200kBothNames: r.maxPerTurn.o200k } : {}) })),
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  // The recorded commit must be the code that counted: no uncommitted engine changes.
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) {
    console.error(`Uncommitted changes in the engine; commit them and run npm run build first:\n${dirty}`);
    process.exit(1);
  }

  log(`Searching: ${QUERY}`);
  const search = await searchRepos();
  log(`${search.items.length} of ${search.total} results fetched${search.incomplete ? ' (GitHub reported incomplete results)' : ''}`);

  // Scan in rank order with a few repositories in flight; stop once the first LIMIT ranks that qualify are known.
  const results = new Array(search.items.length);
  let next = 0;
  let done = false;
  const prefixQualifying = () => {
    let q = 0;
    for (let i = 0; i < results.length && results[i]; i++) if (results[i].status === 'qualifying') q++;
    return q;
  };
  await Promise.all(
    Array.from({ length: REPO_CONCURRENCY }, async () => {
      while (!done && next < search.items.length) {
        const i = next++;
        const item = search.items[i];
        results[i] = await scan(item);
        const r = results[i];
        log(`[${i + 1}] ${item.full_name}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.record ? ` · ${r.record.files.length} files · max ${r.record.maxPerTurn.o200k}` : ''}`);
        if (prefixQualifying() >= LIMIT) done = true;
      }
    }),
  );

  const repos = [];
  let scanned = 0;
  const skipped = { truncated: 0, errors: 0 };
  const errors = [];
  for (let i = 0; i < results.length && results[i] && repos.length < LIMIT; i++) {
    const r = results[i];
    scanned = i + 1;
    if (r.status === 'qualifying') repos.push({ rank: i + 1, ...r.record });
    else if (r.status === 'truncated') skipped.truncated++;
    else if (r.status === 'error') {
      skipped.errors++;
      errors.push({ full_name: search.items[i].full_name, reason: r.reason });
    }
  }
  if (repos.length < LIMIT) log(`Only ${repos.length} of ${search.items.length} search results qualify (target ${LIMIT}).`);

  const summary = summarize(repos);
  for (const r of repos) delete r._rootPair;

  const data = {
    generatedAt,
    turntaxVersion: version,
    engineCommit,
    selection: {
      query: QUERY,
      sort: 'stars desc',
      pushedSince: PUSHED_SINCE,
      minStars: MIN_STARS,
      searchTotal: search.total,
      searchFetched: search.items.length,
      searchIncomplete: search.incomplete,
      scanned,
      skippedTruncated: skipped.truncated,
      skippedErrors: skipped.errors,
      errors,
      qualifying: repos.length,
      target: LIMIT,
      excludedFolders: [...TEST_DIRS],
      maxDepth: MAX_DEPTH,
      maxFileBytes: MAX_BYTES,
    },
    agentNames: Object.fromEntries(TOOLS.map((t) => [t.id, t.name])),
    repos,
    summary,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  // Objects without nested objects or arrays go on one line, so the file stays small and diffable.
  const text = JSON.stringify(data, null, 1).replace(/\{\n\s+([^{}[\]]*?)\n\s*\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, ' ')} }`);
  writeFileSync(OUT, text + '\n');
  log(`Wrote ${OUT}: ${repos.length} repos, ${scanned} scanned, ${skipped.truncated} truncated, ${skipped.errors} errors.`);
}

main().catch((e) => fail(e.message));
