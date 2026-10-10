import { audit, type Report } from '../core/audit.js';
import { addImports, isInstructionFile, isSkippedDir } from '../core/files.js';
import { DEFAULT_MODEL_IDS, MODELS } from '../core/prices.js';
import { badgeMarkdown, fmtTokens, fmtUsd, renderMarkdown } from '../core/render.js';
import { TOOLS } from '../core/tools.js';
import type { RepoFile } from '../core/types.js';

/**
 * Browser front end. Everything runs locally with the offline o200k tokenizer;
 * this file makes no network requests.
 */

interface Source {
  /** Every repo-relative path seen (used for stale-reference checks). */
  paths: Set<string>;
  /** Lazily reads a repo-relative file. */
  read: (path: string) => Promise<string | null>;
}

const state: { files: Map<string, RepoFile>; allPaths: Set<string> | null; report: Report | null } = {
  files: new Map(),
  allPaths: null,
  report: null,
};

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

async function loadSource(src: Source): Promise<void> {
  const found = new Map<string, RepoFile>();
  for (const path of src.paths) {
    if (!isInstructionFile(path)) continue;
    const text = await src.read(path);
    if (text !== null) found.set(path, { path, text });
  }
  await addImports(found, (p) => (src.paths.has(p) ? src.read(p) : null));
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

function renderReport(report: Report): void {
  $('results').hidden = false;
  const summary = $('summary');
  const head = el('tr', {}, ...['Tool', 'Always-loaded files', 'o200k / turn', 'Model', 'Tokens / turn', 'Counted by', `${report.turns} turns`, 'Cached'].map((h) => el('th', {}, h)));
  const rows: HTMLElement[] = [];
  for (const t of report.tools) {
    const models = t.models.length ? t.models : [null];
    models.forEach((m, i) => {
      const lead = i === 0 ? [t.name, String(t.alwaysFiles), fmtTokens(t.perTurnO200k)] : ['', '', ''];
      const rest = !m
        ? ['(no selected model)', '', '', '', '']
        : m.perTurn === null
          ? [m.label, '-', m.model.startsWith('claude') || m.model.startsWith('gemini') ? 'CLI with API key only' : m.reason ?? '', '-', '-']
          : [m.label, fmtTokens(m.perTurn), m.method === 'offline-proxy' ? 'estimate (o200k proxy)' : 'exact (offline)', fmtUsd(m.uncached), fmtUsd(m.cached)];
      rows.push(el('tr', {}, ...[...lead, ...rest].map((c) => el('td', {}, c))));
    });
  }
  summary.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));

  const advice = $('advice');
  advice.replaceChildren(
    ...(report.advice.length
      ? report.advice.map((a) =>
          el(
            'li',
            { class: `sev-${a.severity}` },
            el('span', { class: 'tag' }, `${a.severity} · ${a.kind}`),
            ' ',
            el('code', {}, a.paths.join(', ') + (a.line ? `:${a.line}` : '')),
            el('p', {}, a.message),
            el('p', { class: 'muted' }, (a.savingTokens === null ? '' : `Saves about ${fmtTokens(a.savingTokens)} o200k tokens per turn. `) + (a.savingNote ?? '')),
          ),
        )
      : [el('li', {}, 'No issues found.')]),
  );

  const files = $('files');
  files.replaceChildren(
    el('thead', {}, el('tr', {}, ...['Tool', 'Mode', 'File', 'o200k', 'Loads'].map((h) => el('th', {}, h)))),
    el(
      'tbody',
      {},
      ...report.files.map((f) =>
        el(
          'tr',
          {},
          el('td', {}, f.tool),
          el('td', {}, el('span', { class: `mode mode-${f.mode}` }, f.mode)),
          el('td', {}, el('code', {}, f.part === 'full' ? f.path : `${f.path} (${f.part})`)),
          el('td', { class: 'num' }, fmtTokens(f.o200k)),
          el('td', {}, f.trigger),
        ),
      ),
    ),
  );
  ($('badge') as HTMLTextAreaElement).value = badgeMarkdown(report);
}

function setupModels(): void {
  const box = $('models');
  for (const m of MODELS) {
    const input = el('input', { type: 'checkbox', id: `model-${m.id}` }) as HTMLInputElement;
    input.checked = DEFAULT_MODEL_IDS.includes(m.id);
    input.addEventListener('change', () => void run());
    const note = m.offline === 'none' ? ' (count needs the CLI + API key)' : m.offline === 'o200k-proxy' ? ' (o200k estimate)' : '';
    box.append(el('label', {}, input, ` ${m.label}`, el('span', { class: 'muted' }, note)));
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
    await loadSource(await fromDrop(e.dataTransfer.items));
    await run();
  });
  $('pick-folder').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) await loadSource(fromFileList(input.files, true));
    input.value = '';
    await run();
  });
  $('pick-files').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      // Single files have no folder context; keep their names as root-level paths.
      for (const f of Array.from(input.files)) state.files.set(f.name, { path: f.name, text: await f.text() });
    }
    input.value = '';
    await run();
  });
  $('paste-add').addEventListener('click', async () => {
    const path = ($('paste-name') as HTMLInputElement).value.trim().replace(/^\.?\//, '');
    const text = ($('paste-text') as HTMLTextAreaElement).value;
    if (!path || !text.trim()) return;
    state.files.set(path, { path, text });
    ($('paste-text') as HTMLTextAreaElement).value = '';
    await run();
  });
  $('clear').addEventListener('click', () => {
    state.files.clear();
    state.allPaths = null;
    void run();
  });
  $('turns').addEventListener('change', () => void run());
  $('copy-badge').addEventListener('click', () => void navigator.clipboard.writeText(($('badge') as HTMLTextAreaElement).value));
  $('download-md').addEventListener('click', () => {
    if (!state.report) return;
    const url = URL.createObjectURL(new Blob([renderMarkdown(state.report)], { type: 'text/markdown' }));
    const a = el('a', { href: url, download: 'context-tax-report.md' });
    a.click();
    URL.revokeObjectURL(url);
  });
  $('tool-count').textContent = String(TOOLS.length);
}

setupModels();
setupInputs();
