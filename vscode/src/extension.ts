import { join, relative, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { FixPlan } from '../../src/core/fix.js';
import { applyChanges } from '../../src/node/apply.js';
import type { WorkspaceAudit } from '../../src/node/workspace.js';
import {
  affectsAudit,
  diagnosticsFrom,
  diffTitle,
  fixSummary,
  isFixable,
  nothingToFix,
  reportMarkdown,
  samePlan,
  statusView,
  type StatusView,
} from './view.js';

const FIX_SCHEME = 'turntax-fix';
const REPORT_URI = vscode.Uri.from({ scheme: 'turntax-report', path: '/turntax-report.md' });
const DEBOUNCE_MS = 500;

/** What the last audit found. activate() returns it for the integration test. */
export interface TurntaxState {
  root: string;
  audit?: WorkspaceAudit;
  /** Why the audit failed, such as an invalid turntax.config.json. */
  error?: string;
  status?: StatusView;
}

export interface TurntaxApi {
  readonly state: TurntaxState | undefined;
}

/** Read-only documents for the report and the planned file contents. */
class VirtualDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, text: string): void {
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  clear(scheme: string): void {
    for (const key of this.texts.keys()) if (vscode.Uri.parse(key).scheme === scheme) this.texts.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * Runs an audit or a fix plan in a worker thread (dist/worker.js). `started` receives the worker so a newer
 * job can stop it; a stopped worker rejects.
 */
function runJob<T>(kind: 'audit' | 'plan', root: string, started?: (w: Worker) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'worker.js'), { workerData: { kind, root } });
    started?.(worker);
    worker.once('message', (m: { result?: T; error?: string }) => {
      if (m.error === undefined) resolve(m.result as T);
      else reject(new Error(m.error));
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error('The turntax worker stopped.')));
  });
}

const sameFolder = (a: vscode.WorkspaceFolder | undefined, b: vscode.WorkspaceFolder | undefined) =>
  a !== undefined && b !== undefined && a.uri.toString() === b.uri.toString();

const relPath = (folder: vscode.WorkspaceFolder, uri: vscode.Uri) => relative(folder.uri.fsPath, uri.fsPath).split(sep).join('/');

class Turntax implements vscode.Disposable {
  state: TurntaxState | undefined;
  private folder: vscode.WorkspaceFolder | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runs = 0;
  private previews = 0;
  /** The audit in progress; a newer refresh stops it. */
  private auditing: Worker | undefined;

  constructor(
    private readonly status: vscode.StatusBarItem,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly report: VirtualDocuments,
    private readonly planned: VirtualDocuments,
  ) {}

  /** The folder of the active editor, else the folder audited last, else the first folder. */
  private pickFolder(): vscode.WorkspaceFolder | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const uri = vscode.window.activeTextEditor?.document.uri;
    const active = uri && vscode.workspace.getWorkspaceFolder(uri);
    return folders.find((f) => sameFolder(f, active)) ?? folders.find((f) => sameFolder(f, this.folder)) ?? folders[0];
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  /** Re-audits the current folder; a refresh started meanwhile wins. */
  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    const run = ++this.runs;
    const folder = this.pickFolder();
    this.folder = folder;
    void this.auditing?.terminate();
    if (!folder) return this.show(undefined);
    const root = folder.uri.fsPath;
    if (this.state?.root !== root) {
      this.status.text = '$(sync~spin) turntax';
      this.status.tooltip = `turntax: reading ${folder.name}`;
      // A click would start the read over.
      this.status.command = undefined;
      this.status.show();
    }
    let state: TurntaxState;
    try {
      state = { root, audit: await runJob<WorkspaceAudit>('audit', root, (w) => (this.auditing = w)) };
    } catch (e) {
      state = { root, error: (e as Error).message };
    }
    if (run === this.runs) this.show(state, folder);
  }

  private show(state: TurntaxState | undefined, folder?: vscode.WorkspaceFolder): void {
    this.state = state;
    this.status.command = 'turntax.showReport';
    this.diagnostics.clear();
    if (!state || !folder) return this.status.hide();
    if (!state.audit) {
      this.status.text = '$(warning) turntax';
      this.status.tooltip = `turntax: ${state.error}`;
      return this.status.show();
    }
    state.status = statusView(state.audit.report);
    if (state.status) {
      this.status.text = state.status.text;
      this.status.tooltip = state.status.tooltip;
      this.status.show();
    } else this.status.hide();
    const byPath = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnosticsFrom(state.audit)) {
      const range = new vscode.Range(d.line - 1, 0, d.line - 1, Number.MAX_SAFE_INTEGER);
      const severity = d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(range, d.message, severity);
      diagnostic.source = 'turntax';
      if (d.kind) diagnostic.code = d.kind;
      byPath.set(d.path, [...(byPath.get(d.path) ?? []), diagnostic]);
    }
    for (const [path, list] of byPath) this.diagnostics.set(vscode.Uri.joinPath(folder.uri, path), list);
    // An open report preview follows the latest audit.
    this.report.set(REPORT_URI, reportMarkdown(state.audit.report));
  }

  /** True when a created, changed or deleted file can change the report of the current folder. */
  affects(uri: vscode.Uri): boolean {
    const folder = this.folder;
    if (!folder || !sameFolder(vscode.workspace.getWorkspaceFolder(uri), folder)) return false;
    return affectsAudit(relPath(folder, uri), this.state?.audit?.report.files.map((f) => f.path) ?? []);
  }

  /** Called when the active editor changes: re-audits when it is in another folder. */
  followEditor(editor: vscode.TextEditor | undefined): void {
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder && folder.uri.scheme === 'file' && !sameFolder(folder, this.folder)) this.schedule();
  }

  async showReport(): Promise<void> {
    if (!this.state) await this.refresh();
    const state = this.state;
    if (!state) return void vscode.window.showInformationMessage('Open a folder to see its turntax report.');
    if (!state.audit) return void vscode.window.showErrorMessage(`turntax: ${state.error}`);
    if (!state.audit.report.tools.length) return void vscode.window.showInformationMessage('No agent instruction files found.');
    this.report.set(REPORT_URI, reportMarkdown(state.audit.report));
    // Opened first, so the Markdown extension finds it among the open documents instead of on disk.
    await vscode.workspace.openTextDocument(REPORT_URI);
    await vscode.commands.executeCommand('markdown.showPreview', REPORT_URI);
  }

  /** Opens a diff per planned file and offers to apply the plan. Returns the plan (for tests); never writes by itself. */
  async previewFixes(): Promise<FixPlan | undefined> {
    const folder = this.pickFolder();
    if (!folder) return void vscode.window.showInformationMessage('Open a folder to preview its fixes.');
    let plan: FixPlan;
    try {
      plan = await runJob<FixPlan>('plan', folder.uri.fsPath);
    } catch (e) {
      return void vscode.window.showErrorMessage(`turntax: ${(e as Error).message}`);
    }
    if (!plan.changes.length) {
      void vscode.window.showInformationMessage(nothingToFix(plan));
      return plan;
    }
    // The plan is made from the files on disk; unsaved edits would show as reverted in the diff.
    const unsaved = this.unsaved(folder, plan);
    if (unsaved) return void vscode.window.showWarningMessage(`Save or revert ${unsaved} before previewing fixes.`);
    const id = ++this.previews;
    this.planned.clear(FIX_SCHEME);
    for (const c of plan.changes) {
      const planned = vscode.Uri.from({ scheme: FIX_SCHEME, path: `/${c.path}`, query: String(id) });
      this.planned.set(planned, c.after);
      const current = c.before === null ? planned.with({ query: `${id}-empty` }) : vscode.Uri.joinPath(folder.uri, c.renamedFrom ?? c.path);
      if (c.before === null) this.planned.set(current, '');
      await vscode.commands.executeCommand('vscode.diff', current, planned, diffTitle(c), { preview: false });
    }
    void this.offerApply(folder, plan);
    return plan;
  }

  private async offerApply(folder: vscode.WorkspaceFolder, plan: FixPlan): Promise<void> {
    const files = plan.changes.length;
    const choice = await vscode.window.showInformationMessage(
      `turntax: ${fixSummary(plan)} in ${files} ${files === 1 ? 'file' : 'files'}. Apply?`,
      'Apply',
      'Cancel',
    );
    if (choice !== 'Apply') return;
    if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Applying fixes needs a trusted workspace; nothing was written.');
    const unsaved = this.unsaved(folder, plan);
    if (unsaved) return void vscode.window.showWarningMessage(`Save or revert ${unsaved} first; nothing was written.`);
    try {
      // A fix can depend on files it does not change (a duplicate is removed because another file keeps it),
      // so the plan is made again and applied only if nothing changed since the preview.
      const fresh = await runJob<FixPlan>('plan', folder.uri.fsPath);
      if (!samePlan(fresh, plan)) return void vscode.window.showWarningMessage('Files changed since the preview; preview the fixes again. Nothing was written.');
      applyChanges(folder.uri.fsPath, plan.changes);
    } catch (e) {
      return void vscode.window.showErrorMessage(`turntax: ${(e as Error).message}`);
    }
    void vscode.window.showInformationMessage(`Changed ${files} ${files === 1 ? 'file' : 'files'}: ${plan.changes.map((c) => c.path).join(', ')}`);
    await this.refresh();
  }

  /** The first file the plan touches that has unsaved edits, if any. */
  private unsaved(folder: vscode.WorkspaceFolder, plan: FixPlan): string | undefined {
    const touched = new Set(plan.changes.flatMap((c) => [c.path, ...(c.renamedFrom ? [c.renamedFrom] : [])]));
    const doc = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.scheme === 'file' && touched.has(relPath(folder, d.uri)));
    return doc && relPath(folder, doc.uri);
  }

  dispose(): void {
    clearTimeout(this.timer);
    // The stopped audit must not update the disposed status bar and diagnostics.
    this.runs++;
    void this.auditing?.terminate();
  }
}

/** "Preview safe fixes" on turntax diagnostics that --fix can handle. */
const codeActions: vscode.CodeActionProvider = {
  provideCodeActions(_document, _range, context) {
    const ours = context.diagnostics.filter((d) => d.source === 'turntax' && isFixable(typeof d.code === 'string' ? d.code : undefined));
    if (!ours.length) return [];
    const action = new vscode.CodeAction('turntax: Preview safe fixes', vscode.CodeActionKind.QuickFix);
    action.command = { command: 'turntax.previewFixes', title: 'turntax: Preview safe fixes' };
    action.diagnostics = ours;
    return [action];
  },
};

export function activate(context: vscode.ExtensionContext): TurntaxApi {
  const status = vscode.window.createStatusBarItem('turntax.status', vscode.StatusBarAlignment.Right, 100);
  status.name = 'turntax';
  status.command = 'turntax.showReport';
  const diagnostics = vscode.languages.createDiagnosticCollection('turntax');
  // One provider per scheme: a provider's change events must only name its own scheme.
  const report = new VirtualDocuments();
  const planned = new VirtualDocuments();
  const turntax = new Turntax(status, diagnostics, report, planned);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFile = (uri: vscode.Uri) => turntax.affects(uri) && turntax.schedule();
  context.subscriptions.push(
    status,
    diagnostics,
    report,
    planned,
    turntax,
    watcher,
    vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, planned),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_URI.scheme, report),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('turntax.showReport', () => turntax.showReport()),
    vscode.commands.registerCommand('turntax.previewFixes', () => turntax.previewFixes()),
    vscode.commands.registerCommand('turntax.refresh', () => turntax.refresh()),
    watcher.onDidCreate(onFile),
    watcher.onDidChange(onFile),
    watcher.onDidDelete(onFile),
    vscode.workspace.onDidChangeWorkspaceFolders(() => turntax.schedule()),
    vscode.window.onDidChangeActiveTextEditor((editor) => turntax.followEditor(editor)),
  );
  void turntax.refresh();
  return {
    get state() {
      return turntax.state;
    },
  };
}
