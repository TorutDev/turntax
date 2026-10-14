import { audit, type Report } from '../core/audit.js';
import { addImports, isInstructionFile, isSkippedDir } from '../core/files.js';
import { planWebFixes } from './fixes.js';
import { fetchRepoTree, GitHubError, parseRepoInput, rawReader } from './github.js';
import { DEFAULT_MODEL_IDS, MODELS } from '../core/prices.js';
import { SAMPLE_REPO } from './sample.js';
import { badgeMarkdown, fmtTokens, fmtUsd, groupFiles, groupTools, renderMarkdown } from '../core/render.js';
import { TOOLS } from '../core/tools.js';
import type { RepoFile, ToolId } from '../core/types.js';

/**
 * Browser front end. Everything runs locally with the offline o200k tokenizer.
 * Network requests happen only when the user loads a GitHub repository (or opens
 * a ?repo= link), and only to api.github.com and raw.githubusercontent.com.
 */

interface Source {
  /** Every repo-relative path seen (used for stale-reference checks). */
  paths: Set<string>;
  /** Lazily reads a repo-relative file. */
  read: (path: string) => Promise<string | null>;
}

interface LoadedRepo {
  owner: string;
  name: string;
  ref: string;
  /** The user named the ref; only then does the shareable link carry it. */
  explicitRef: boolean;
  truncated: boolean;
}

const state: {
  files: Map<string, RepoFile>;
  allPaths: Set<string> | null;
  /** Symlinks of loaded GitHub repositories and the paths they point to; fixes leave them alone. */
  linked: Set<string>;
  report: Report | null;
  repo: LoadedRepo | null;
  /** The patch shown in the Fixes panel. */
  fixDiff: string;
} = {
  files: new Map(),
  allPaths: null,
  linked: new Set(),
  report: null,
  repo: null,
  fixDiff: '',
};

/** Agents unchecked under "Agents you use"; kept while the page is open. */
const fixExcluded = new Set<ToolId>();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function stripRoot(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function keepPath(path: string): boolean {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) if (isSkippedDir(parts.slice(0, i).join('/'))) return false;
  return true;
}

/** Bumped whenever the user picks another source, so a GitHub load still in flight is discarded. */
let generation = 0;

async function loadSource(src: Source, isCurrent: () => boolean = () => true): Promise<void> {
  const found = new Map<string, RepoFile>();
  // Read in parallel; a GitHub source fetches each file over the network.
  const paths = [...src.paths].filter((p) => isInstructionFile(p));
  const texts = await Promise.all(paths.map((p) => src.read(p)));
  paths.forEach((path, i) => {
    const text = texts[i];
    if (text != null) found.set(path, { path, text });
  });
  await addImports(found, (p) => (src.paths.has(p) ? src.read(p) : null));
  if (!isCurrent()) return;
  for (const [p, f] of found) state.files.set(p, f);
  state.allPaths = new Set([...(state.allPaths ?? []), ...src.paths]);
}

function fromFileList(list: FileList | File[], stripFirstSegment: boolean): Source {
  const byPath = new Map<string, File>();
  for (const f of Array.from(list)) {
    const raw = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const path = stripFirstSegment && f.webkitRelativePath ? stripRoot(raw) : raw;
    if (keepPath(path)) byPath.set(path, f);
  }
  return { paths: new Set(byPath.keys()), read: async (p) => (byPath.has(p) ? byPath.get(p)!.text() : null) };
}

async function fromDrop(items: DataTransferItemList): Promise<Source> {
  const files = new Map<string, File>();
  const entries = Array.from(items)
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  // A single dropped folder is treated as the repository root.
  const singleDir = entries.length === 1 && entries[0]!.isDirectory;
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      files.set(path, await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
      return;
    }
    if (path && isSkippedDir(path)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, path ? `${path}/${child.name}` : child.name);
    }
  };
  if (singleDir) await walk(entries[0]!, '');
  else for (const e of entries) await walk(e, e.name);
  return { paths: new Set(files.keys()), read: async (p) => (files.has(p) ? files.get(p)!.text() : null) };
}

const TRUNCATED_NOTE = 'GitHub truncated the file list; very large repos may be incomplete.';

/** Shows the loaded repo and puts it in the URL; null hides it and drops ?repo= unless `keepUrl`. */
function setRepo(repo: LoadedRepo | null, keepUrl = false): void {
  state.repo = repo;
  if (!repo) generation++;
  const info = $('repo-info');
  info.hidden = !repo;
  $('copy-link').hidden = !repo;
  if (!repo) {
    info.replaceChildren();
    if (!keepUrl && location.search) history.replaceState(null, '', location.pathname + location.hash);
    return;
  }
  const label = `github.com/${repo.owner}/${repo.name} @ ${repo.ref}`;
  info.replaceChildren(
    el('a', { href: `https://github.com/${repo.owner}/${repo.name}`, rel: 'noopener', target: '_blank' }, label),
    ...(repo.truncated ? [el('span', { class: 'muted' }, ` · ${TRUNCATED_NOTE}`)] : []),
  );
  const ref = repo.explicitRef ? `&ref=${repo.ref.split('/').map(encodeURIComponent).join('/')}` : '';
  history.replaceState(null, '', `${location.pathname}?repo=${repo.owner}/${repo.name}${ref}${location.hash}`);
}

function repoStatus(message: string, error = false): void {
  const status = $('repo-status');
  status.textContent = message;
  status.classList.toggle('error', error);
  status.classList.toggle('muted', !error);
  status.hidden = !message;
}

/** `fromLink` keeps a failing ?repo= link in the address bar so a reload retries it. */
async function loadRepo(input: string, fromLink = false): Promise<void> {
  const repo = parseRepoInput(input);
  if (!repo) {
    repoStatus('Enter a repository as owner/name or a github.com URL.', true);
    return;
  }
  const button = $('repo-load') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Loading…';
  repoStatus('');
  state.files.clear();
  state.allPaths = null;
  state.linked.clear();
  setRepo(null, fromLink);
  const gen = generation;
  const current = () => gen === generation;
  try {
    const tree = await fetchRepoTree(repo);
    if (!current()) return;
    const read = rawReader(tree);
    await loadSource({ paths: new Set(tree.paths.filter(keepPath)), read }, current);
    if (!current()) return;
    for (const p of [...tree.links, ...read.targets.values()]) state.linked.add(p);
    const where = `${tree.owner}/${tree.name}@${tree.ref}`;
    const notes: string[] = [];
    if (tree.subdir) notes.push(`Showing the whole repository at ${tree.ref}; folder ${tree.subdir} is not analysed on its own.`);
    if (!state.files.size) notes.push(`No agent instruction files found in ${where}.${tree.truncated ? ` ${TRUNCATED_NOTE}` : ''}`);
    else setRepo({ owner: tree.owner, name: tree.name, ref: tree.ref, explicitRef: !!repo.ref, truncated: tree.truncated });
    if (read.failed.length)
      notes.push(`${read.failed.length} file(s) could not be downloaded and are not counted: ${read.failed.slice(0, 5).join(', ')}${read.failed.length > 5 ? ', …' : ''}`);
    repoStatus(notes.join(' '), read.failed.length > 0);
  } catch (e) {
    if (!current()) return;
    repoStatus(e instanceof GitHubError ? e.message : 'Could not load the repository.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Analyse';
  }
  if (!current()) return;
  await run();
  if (state.files.size) $('results').scrollIntoView({ behavior: 'smooth' });
}

function selectedModels() {
  return MODELS.filter((m) => ($(`model-${m.id}`) as HTMLInputElement).checked);
}

async function run(): Promise<void> {
  const files = [...state.files.values()];
  renderFileList();
  if (!files.length) {
    $('results').hidden = true;
    return;
  }
  const allPaths = state.allPaths;
  const exists = allPaths?.size
    ? (p: string) => allPaths.has(p) || [...allPaths].some((x) => x.startsWith(p + '/'))
    : undefined;
  const turns = Math.max(1, Number(($('turns') as HTMLInputElement).value) || 100);
  state.report = await audit(files, { models: selectedModels(), turns, advice: { exists } });
  renderReport(state.report);
}

function renderFileList(): void {
  const list = $('file-list');
  list.replaceChildren(
    ...[...state.files.keys()].sort().map((p) => {
      const remove = el('button', { type: 'button', class: 'link', 'aria-label': `Remove ${p}` }, 'remove');
      remove.addEventListener('click', () => {
        state.files.delete(p);
        void run();
      });
      return el('li', {}, el('code', {}, p), ' ', remove);
    }),
  );
  $('loaded').hidden = state.files.size === 0;
}

type ModelCost = Report['tools'][number]['models'][number];

function costLine(m: ModelCost, turns: number): string {
  if (m.perTurn === null)
    return m.model.startsWith('claude') || m.model.startsWith('gemini') ? 'exact count: CLI + API key' : (m.reason ?? 'not counted');
  if (m.method === 'none-loaded') return 'nothing every turn';
  return `${fmtUsd(m.uncached)} / ${turns} turns · ${fmtUsd(m.cached)} cached`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderCards(report: Report): void {
  $('cards').replaceChildren(
    // Agents that load exactly the same files share one card.
    ...groupTools(report).map(({ names, tool: t }) =>
      el(
        'article',
        { class: 'card' },
        el('h3', {}, names.join(' · ')),
        el('div', { class: 'big' }, fmtTokens(t.perTurnO200k), el('span', {}, ' o200k tokens / turn')),
        el('p', { class: 'muted small' }, `${plural(t.alwaysFiles, 'file')} every turn · ${fmtTokens(t.onDemandO200k)} o200k tokens on demand`),
        el(
          'ul',
          {},
          ...(t.models.length
            ? t.models.map((m) => el('li', {}, el('span', {}, m.label), el('span', {}, costLine(m, report.turns))))
            : [el('li', {}, el('span', {}, 'No model selected for this agent'), el('span', {}, ''))]),
        ),
      ),
    ),
  );
}

function renderChart(report: Report): void {
  const chart = $('chart');
  const tip = $('tip');
  const rows = [...report.tools].sort((a, b) => b.perTurnO200k - a.perTurnO200k);
  const max = Math.max(1, ...rows.map((t) => t.perTurnO200k));
  chart.replaceChildren(
    tip,
    ...rows.map((t) => {
      const bar = el('div', { class: 'bar', style: `width:${Math.max(0.5, (t.perTurnO200k / max) * 100)}%` });
      const row = el(
        'div',
        { class: 'bar-row', tabindex: '0', 'aria-label': `${t.name}: ${fmtTokens(t.perTurnO200k)} o200k tokens every turn` },
        el('span', { class: 'name' }, t.name),
        el('span', { class: 'bar-track' }, bar, el('span', { class: 'bar-value' }, fmtTokens(t.perTurnO200k))),
      );
      const show = () => {
        tip.textContent = `${t.name}: ${fmtTokens(t.perTurnO200k)} o200k tokens every turn from ${plural(t.alwaysFiles, 'file')}`;
        const box = chart.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        tip.style.left = `${Math.min(box.width - 145, Math.max(145, b.right - box.left))}px`;
        tip.style.top = `${b.top - box.top}px`;
        tip.hidden = false;
      };
      row.addEventListener('mouseenter', show);
      row.addEventListener('focus', show);
      row.addEventListener('mouseleave', () => (tip.hidden = true));
      row.addEventListener('blur', () => (tip.hidden = true));
      return row;
    }),
  );
}

function renderAdvice(report: Report): void {
  $('advice').replaceChildren(
    ...(report.advice.length
      ? report.advice.map((a) =>
          el(
            'li',
            { class: `sev-${a.severity}` },
            el(
              'div',
              { class: 'row' },
              el('span', { class: 'tag' }, `${a.severity} · ${a.kind.replace(/-/g, ' ')}`),
              el('code', {}, a.paths.join(', ') + (a.line ? `:${a.line}` : '')),
            ),
            el('p', {}, a.message),
            el(
              'p',
              { class: 'muted small' },
              ...(a.savingTokens ? [el('span', { class: 'saving' }, `Saves about ${fmtTokens(a.savingTokens)} o200k tokens per turn. `)] : []),
              a.savingNote ?? '',
            ),
          ),
        )
      : [el('li', {}, 'Nothing to trim.')]),
  );
}

function renderFiles(report: Report): void {
  const name = (id: string) => TOOLS.find((t) => t.id === id)?.name ?? id;
  $('files').replaceChildren(
    el('thead', {}, el('tr', {}, ...['File', 'Loads', 'o200k', 'When', 'Agents'].map((h) => el('th', {}, h)))),
    el(
      'tbody',
      {},
      ...groupFiles(report).map(({ file: f, tools }) =>
        el(
          'tr',
          {},
          el('td', {}, el('code', {}, f.part === 'full' ? f.path : `${f.path} (${f.part})`)),
          el('td', {}, el('span', { class: 'mode' }, f.mode)),
          el('td', { class: 'num' }, fmtTokens(f.o200k)),
          el('td', { class: 'small' }, f.trigger),
          el('td', { class: 'small' }, tools.map(name).join(', ')),
        ),
      ),
    ),
  );
}

function renderFixAgents(report: Report): void {
  $('fix-agents').replaceChildren(
    ...report.tools.map((t) => {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = !fixExcluded.has(t.tool);
      input.addEventListener('change', () => {
        if (input.checked) fixExcluded.delete(t.tool);
        else fixExcluded.add(t.tool);
        renderFixes(report);
      });
      return el('label', {}, input, ` ${t.name}`);
    }),
  );
}

function renderFixes(report: Report): void {
  const agents = report.tools.map((t) => t.tool);
  const kept = agents.filter((id) => !fixExcluded.has(id));
  // All checked is the CLI default: keep the context of every supported agent.
  const plan = planWebFixes(
    { files: [...state.files.values()], paths: state.allPaths ?? [], linked: state.linked },
    kept.length === agents.length ? undefined : kept,
  );
  state.fixDiff = plan.diff;
  $('fix-list').replaceChildren(
    ...(plan.changes.length
      ? plan.fixes.map((f) =>
          el(
            'li',
            {},
            el('p', {}, f.message),
            ...(f.savingTokens ? [el('p', { class: 'muted small saving' }, `Saves about ${fmtTokens(f.savingTokens)} o200k tokens per turn.`)] : []),
          ),
        )
      : [el('li', {}, 'Nothing to fix automatically.')]),
  );
  $('fix-skipped').hidden = !plan.skipped.length;
  $('fix-skipped-count').textContent = String(plan.skipped.length);
  $('fix-skipped-list').replaceChildren(
    ...plan.skipped.map((s) => el('li', {}, el('span', { class: 'muted' }, `${s.kind.replace(/-/g, ' ')}: `), s.reason)),
  );
  $('fix-actions').hidden = !plan.changes.length;
  $('fix-diff').textContent = plan.diff;
}

function renderReport(report: Report): void {
  $('results').hidden = false;
  renderCards(report);
  renderChart(report);
  renderAdvice(report);
  renderFixAgents(report);
  renderFixes(report);
  renderFiles(report);
  ($('badge') as HTMLTextAreaElement).value = badgeMarkdown(report);
}

function setupAgents(): void {
  const names = TOOLS.map((t) => t.name).sort((a, b) => a.localeCompare(b));
  $('agents').replaceChildren(...names.map((n) => el('li', { class: 'chip' }, n)));
  const examples = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/main.mdc', '.windsurf/rules/main.md'];
  $('paste-names').replaceChildren(...examples.map((v) => el('option', { value: v })));
}

function setupModels(): void {
  const families: Array<[string, string]> = [
    ['openai', 'OpenAI'],
    ['claude', 'Anthropic'],
    ['gemini', 'Google'],
    ['open', 'Open weights'],
  ];
  const box = $('models');
  for (const [family, title] of families) {
    box.append(el('div', { class: 'muted small', style: 'margin-top:6px' }, title));
    for (const m of MODELS.filter((x) => x.family === family)) {
      const input = el('input', { type: 'checkbox', id: `model-${m.id}` }) as HTMLInputElement;
      input.checked = DEFAULT_MODEL_IDS.includes(m.id);
      input.addEventListener('change', () => void run());
      const note = m.offline === 'none' ? ' · exact count via CLI + API key' : m.offline === 'o200k-proxy' ? ' · estimate' : ' · exact';
      box.append(el('label', {}, input, ` ${m.label}`, el('span', { class: 'muted small' }, note)));
    }
  }
}

function setupInputs(): void {
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!e.dataTransfer) return;
    setRepo(null);
    await loadSource(await fromDrop(e.dataTransfer.items));
    await run();
  });
  $('pick-folder').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    setRepo(null);
    if (input.files) await loadSource(fromFileList(input.files, true));
    input.value = '';
    await run();
  });
  $('pick-files').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    setRepo(null);
    if (input.files) {
      // Single files have no folder context; keep their names as root-level paths.
      for (const f of Array.from(input.files)) state.files.set(f.name, { path: f.name, text: await f.text() });
    }
    input.value = '';
    await run();
  });
  $('sample').addEventListener('click', async () => {
    state.files.clear();
    state.allPaths = null;
    state.linked.clear();
    setRepo(null);
    for (const f of SAMPLE_REPO) state.files.set(f.path, f);
    await run();
    $('results').scrollIntoView({ behavior: 'smooth' });
  });
  $('paste-add').addEventListener('click', async () => {
    const path = ($('paste-name') as HTMLInputElement).value.trim().replace(/^\.?\//, '');
    const text = ($('paste-text') as HTMLTextAreaElement).value;
    if (!path || !text.trim()) return;
    setRepo(null);
    state.files.set(path, { path, text });
    ($('paste-text') as HTMLTextAreaElement).value = '';
    await run();
  });
  $('clear').addEventListener('click', () => {
    state.files.clear();
    state.allPaths = null;
    state.linked.clear();
    setRepo(null);
    void run();
  });
  $('repo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void loadRepo(($('repo-input') as HTMLInputElement).value);
  });
  $('copy-link').addEventListener('click', () => void navigator.clipboard.writeText(location.href));
  $('turns').addEventListener('change', () => void run());
  $('copy-install').addEventListener('click', () => void navigator.clipboard.writeText('npx turntax'));
  $('copy-badge').addEventListener('click', () => void navigator.clipboard.writeText(($('badge') as HTMLTextAreaElement).value));
  $('download-md').addEventListener('click', () => {
    if (state.report) download('turntax-report.md', renderMarkdown(state.report), 'text/markdown');
  });
  $('download-patch').addEventListener('click', () => {
    if (state.fixDiff) download('fix.patch', state.fixDiff, 'text/x-diff');
  });
  $('copy-diff').addEventListener('click', () => void navigator.clipboard.writeText(state.fixDiff));
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  el('a', { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

setupAgents();
setupModels();
setupInputs();

const params = new URLSearchParams(location.search);
const sharedRepo = params.get('repo');
if (sharedRepo) {
  const ref = params.get('ref');
  ($('repo-input') as HTMLInputElement).value = ref ? `https://github.com/${sharedRepo}/tree/${ref}` : sharedRepo;
  void loadRepo(($('repo-input') as HTMLInputElement).value, true);
}

