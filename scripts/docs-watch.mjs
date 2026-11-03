#!/usr/bin/env node
/**
 * Compares the vendor pages behind the loading rules in src/core/tools.ts with the last run's text and writes a
 * report of what changed. A changed page does not mean a rule is wrong; it means a person should look. See
 * .github/workflows/docs-watch.yml; the snapshot stays in a workflow artifact, not in the repository.
 *
 *   node scripts/docs-watch.mjs --out <dir> [--previous <dir>] [--report <file>]
 *
 * Run `npm run build` first. Sets the `changed` step output when the report should reach an issue.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;
/** A page with fewer lines is an error page, a bot check or a script shell, not the document. */
const MIN_LINES = 15;
/** More unreadable pages than this share means the run says nothing about the docs. */
const MAX_UNREADABLE_SHARE = 0.5;
/** Changed lines quoted per page in the issue; the rest is in the run's artifact. */
const QUOTED_LINES = 10;
const QUOTED_CHARS = 160;
/** GitHub refuses an issue body over 65,536 characters; past this, the issue gives counts only. */
const MAX_ISSUE_CHARS = 60_000;

/** Lines that can bear on what an agent loads and when. Pages with other changes are listed only in the job summary. */
const RELEVANT = /\.mdc?\b|\.json\b|\.ya?ml\b|\brules?\b|\bskills?\b|\bimports?\b|\binstructions?\b|\bload|\bread|\balways\b|\bcontext\b|\bfrontmatter\b|\bmcp\b|\blimit|\bcharacters?\b|\bprecedence\b|\bfallback\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

/** The visible text of an HTML page, a line per block element. */
function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<(script|style|svg|noscript|template|head|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, '\n')
    .replace(/<\/?(?:address|article|blockquote|br|dd|details|div|dl|dt|figcaption|figure|h[1-6]|header|hr|li|main|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (all, name) => ENTITIES[name] ?? all);
}

/** A page as unique, whitespace-normalized lines, so moved lines and layout changes do not count. */
export function pageLines(body, contentType = 'text/html') {
  const text = /html/i.test(contentType) ? htmlText(body) : body;
  return [...new Set(text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/** The pages to watch: every source and size-limit source of every agent, with the agents that cite it. */
export function watchedPages(tools) {
  const pages = new Map();
  for (const tool of tools)
    for (const url of [...tool.sources, ...tool.limits.map((l) => l.source)]) {
      const names = pages.get(url) ?? pages.set(url, new Set()).get(url);
      names.add(tool.name);
    }
  return [...pages].map(([url, names]) => ({ url, agents: [...names] }));
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'turntax-docs-watch (+https://github.com/TorutDev/turntax)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (res.status === 404 || res.status === 410) return { status: 'gone', detail: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'unreadable', detail: `HTTP ${res.status}` };
    const lines = pageLines(await res.text(), res.headers.get('content-type') ?? 'text/html');
    if (lines.length < MIN_LINES) return { status: 'unreadable', detail: `only ${lines.length} lines of text` };
    return { status: 'ok', finalUrl: res.url, lines };
  } catch (e) {
    return { status: 'unreadable', detail: e.cause?.code ?? e.name };
  }
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * What changed since `previous` (url -> { lines, finalUrl }). A page read for the first time is only recorded, and an
 * unreadable page keeps its last text, so a change made during an outage still shows up later.
 */
export function compare(pages, results, previous) {
  const snapshot = {};
  const changes = [];
  const unreadable = [];
  const firstSeen = [];
  pages.forEach((page, i) => {
    const result = results[i];
    const before = previous[page.url];
    if (result.status !== 'ok') {
      if (before) snapshot[page.url] = before;
      if (result.status === 'gone') changes.push({ ...page, gone: result.detail, added: [], removed: [], relevant: true });
      else unreadable.push({ ...page, detail: result.detail });
      return;
    }
    snapshot[page.url] = { finalUrl: result.finalUrl, lines: result.lines };
    if (!before) {
      firstSeen.push(page);
      return;
    }
    const was = new Set(before.lines);
    const now = new Set(result.lines);
    const added = result.lines.filter((l) => !was.has(l));
    const removed = before.lines.filter((l) => !now.has(l));
    const movedTo = before.finalUrl !== result.finalUrl ? result.finalUrl : undefined;
    if (!added.length && !removed.length && !movedTo) return;
    changes.push({ ...page, added, removed, movedTo, relevant: Boolean(movedTo) || [...added, ...removed].some((l) => RELEVANT.test(l)) });
  });
  return { snapshot, changes, unreadable, firstSeen };
}

const quote = (line, limit) => (limit !== Infinity && line.length > QUOTED_CHARS ? `${line.slice(0, QUOTED_CHARS)}...` : line);

/** A changed page, with at most `limit` changed lines quoted. */
function pageSection(change, limit) {
  const head = `### ${change.url}\n\nCited for ${change.agents.join(', ')}.`;
  if (change.gone) return `${head} The page is gone (${change.gone}); the link needs updating.`;
  const parts = [head];
  if (change.movedTo) parts.push(`It now redirects to ${change.movedTo}.`);
  const lines = [...change.removed.map((l) => `- ${l}`), ...change.added.map((l) => `+ ${l}`)];
  if (lines.length) {
    const counts = `${change.added.length} line(s) added, ${change.removed.length} removed`;
    // Lines about loading come first, so the cap does not hide them behind navigation or marketing changes.
    const ordered = [...lines.filter((l) => RELEVANT.test(l)), ...lines.filter((l) => !RELEVANT.test(l))];
    const fence = '```';
    parts.push(limit ? `${counts}:\n\n${fence}diff\n${ordered.slice(0, limit).map((l) => quote(l, limit)).join('\n')}\n${fence}` : `${counts}.`);
    if (limit && ordered.length > limit) parts.push(`...and ${ordered.length - limit} more; \`report.md\` in the run's artifact has them all.`);
  }
  return parts.join('\n\n');
}

/** The Markdown for the issue, or null when nothing in the docs bears on the loading rules. */
export function issueReport(changes, date) {
  const relevant = changes.filter((c) => c.relevant);
  if (!relevant.length) return null;
  const body = (limit) =>
    [
      `Pages behind the loading rules changed by ${date}. Check each against [\`src/core/tools.ts\`](https://github.com/TorutDev/turntax/blob/main/src/core/tools.ts): update the rule and its \`checkedAt\` if the behaviour changed, otherwise nothing is needed.`,
      ...relevant.map((c) => pageSection(c, limit)),
    ].join('\n\n');
  const quoted = body(QUOTED_LINES);
  return quoted.length > MAX_ISSUE_CHARS ? body(0) : quoted;
}

/** Everything the run found, for the job summary (capped) and the artifact (`limit` Infinity). */
export function fullReport({ changes, unreadable, firstSeen }, total, date, limit = QUOTED_LINES) {
  const out = [`# Docs watch, ${date}`, '', `${total} pages: ${changes.length} changed, ${unreadable.length} unreadable, ${firstSeen.length} recorded for the first time.`];
  const list = (title, rows) => rows.length && out.push('', `## ${title}`, '', ...rows);
  list('Changed, about loading', changes.filter((c) => c.relevant).map((c) => `${pageSection(c, limit)}\n`));
  list('Changed, other text', changes.filter((c) => !c.relevant).map((c) => `${pageSection(c, limit)}\n`));
  list('Unreadable (kept the last text)', unreadable.map((p) => `- ${p.url} (${p.detail}), cited for ${p.agents.join(', ')}`));
  list('Recorded for the first time', firstSeen.map((p) => `- ${p.url}`));
  return `${out.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, previous: { type: 'string' }, report: { type: 'string' } } });
  if (!values.out) throw new Error('--out <dir> is needed.');
  const { TOOLS } = await import('../dist/core/tools.js');
  const pages = watchedPages(TOOLS);
  const results = await mapLimited(pages, CONCURRENCY, (p) => fetchPage(p.url));
  const snapshotFile = values.previous && join(values.previous, 'snapshot.json');
  const previous = snapshotFile && existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : {};
  const found = compare(pages, results, previous);
  const date = new Date().toISOString().slice(0, 10);
  const summary = fullReport(found, pages.length, date);

  // Failing keeps this run's snapshot from replacing the last good one.
  if (found.unreadable.length > pages.length * MAX_UNREADABLE_SHARE) {
    process.stdout.write(summary);
    throw new Error(`${found.unreadable.length} of ${pages.length} pages could not be read.`);
  }
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'snapshot.json'), JSON.stringify(found.snapshot));
  writeFileSync(join(values.out, 'report.md'), fullReport(found, pages.length, date, Infinity));
  const issue = issueReport(found.changes, date);
  if (issue && values.report) writeFileSync(values.report, `${issue}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${issue ? 'true' : 'false'}\n`);
  process.stdout.write(`${summary.split('\n').slice(0, 3).join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`docs-watch: ${e.message}\n`);
    process.exit(1);
  });
}
