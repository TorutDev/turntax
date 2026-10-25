import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FixPlan } from '../../src/core/fix.js';
import type { TurntaxApi } from '../src/extension.js';

/** Runs in the extension host that run.ts starts on a copy of test/fixtures/mixed. Stops at the first failing step. */

const repo = process.env.TURNTAX_REPO!;
const fixtureStatus = () =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'test/fixtures'], { cwd: repo, encoding: 'utf8' });

let steps = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.log(`not ok ${++steps} - ${name}`);
    throw e;
  }
  console.log(`ok ${++steps} - ${name}`);
}

/** Open tabs whose input matches; the tab model reaches the extension host a moment after an editor opens. */
async function tabsWith(match: (input: unknown) => boolean, count: number): Promise<number> {
  const found = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => match(t.input)).length;
  for (let waited = 0; found() < count && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  return found();
}

/** Waits for `get` to return a value: the file watcher can start another audit after files change. */
async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  for (let waited = 0; waited < 10000; waited += 50) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Every file under `dir` and its text, by repository-relative path. */
function snapshot(dir: string): Record<string, string> {
  const paths = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => statSync(join(dir, p)).isFile());
  return Object.fromEntries(paths.map((p) => [p.split(sep).join('/'), readFileSync(join(dir, p), 'utf8')]));
}

export async function run(): Promise<void> {
  const before = fixtureStatus();
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a folder is open');
  const root = folder.uri.fsPath;
  const claude = vscode.Uri.joinPath(folder.uri, 'CLAUDE.md');
  let api: TurntaxApi | undefined;
  let diagnostics: vscode.Diagnostic[] = [];
  let plan: FixPlan | undefined;

  await step('the extension activates', async () => {
    const extension = vscode.extensions.getExtension<TurntaxApi>('torut.turntax');
    assert.ok(extension, 'torut.turntax is loaded');
    api = await extension.activate();
    assert.ok(extension.isActive);
  });

  await step('turntax.refresh shows the headline of the CLI', async () => {
    await vscode.commands.executeCommand('turntax.refresh');
    const state = api?.state;
    assert.ok(state?.audit, state?.error ?? 'no audit');
    const status = state.audit.status;
    const shown = /([\d,]+) tok\/turn$/.exec(status?.text ?? '')?.[1];
    assert.equal(Number(shown?.replace(/,/g, '')), Number(process.env.TURNTAX_EXPECTED_HEADLINE), status?.text);
    assert.match(status?.tooltip ?? '', /^Claude Code: \d+ tokens\/turn$/m);
    assert.match(status?.tooltip ?? '', /o200k_base estimates/);
  });

  await step('CLAUDE.md has turntax diagnostics on the advice lines', async () => {
    diagnostics = vscode.languages.getDiagnostics(claude).filter((d) => d.source === 'turntax');
    const scoped = diagnostics.find((d) => d.code === 'scopable-section');
    assert.ok(scoped, JSON.stringify(diagnostics.map((d) => d.message)));
    assert.equal(scoped.range.start.line, 11);
    assert.equal(scoped.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(scoped.message, /\(saves ~\d+ tokens\/turn\)$/);
  });

  await step('a turntax diagnostic offers "Preview safe fixes"', async () => {
    const scoped = diagnostics.find((d) => d.code === 'scopable-section')!;
    // Code actions are computed for open documents only.
    await vscode.workspace.openTextDocument(claude);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', claude, scoped.range);
    const action = actions.find((a) => a.title === 'turntax: Preview safe fixes');
    assert.equal(action?.command?.command, 'turntax.previewFixes');
  });

  await step('CLAUDE.md has a CodeLens that opens the report, and turntax.codeLens turns it off', async () => {
    const lenses = async () =>
      (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', claude)).filter((l) => l.command?.title.startsWith('turntax: '));
    const [lens, ...more] = await lenses();
    assert.match(lens?.command?.title ?? '', /^turntax: \d+ tokens every turn in \d+ agents/);
    assert.equal(more.length, 0, 'one lens');
    assert.equal(lens?.command?.command, 'turntax.showReport');
    assert.equal(lens?.range.start.line, 0);
    const settings = vscode.workspace.getConfiguration('turntax');
    await settings.update('codeLens', false, vscode.ConfigurationTarget.Global);
    try {
      assert.equal((await lenses()).length, 0, 'no lens with turntax.codeLens off');
    } finally {
      await settings.update('codeLens', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await step('turntax.showReport opens the Markdown report', async () => {
    await vscode.commands.executeCommand('turntax.showReport');
    const report = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'turntax-report');
    assert.match(report?.getText() ?? '', /^# Agent context tax report\n/);
    // The preview loads remote images, so the report must not have any.
    assert.doesNotMatch(report?.getText() ?? '', /!\[[^\]]*\]\(https?:/);
    const preview = (input: unknown) => input instanceof vscode.TabInputWebview && /markdown\.preview/.test(input.viewType);
    assert.equal(await tabsWith(preview, 1), 1, 'one Markdown preview is open');
  });

  await step('turntax.previewFixes opens a diff per change and writes nothing', async () => {
    const files = snapshot(root);
    plan = await vscode.commands.executeCommand<FixPlan | undefined>('turntax.previewFixes');
    assert.ok(plan && plan.changes.length > 0, 'the plan has changes');
    const diff = (input: unknown) => input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'turntax-fix';
    assert.equal(await tabsWith(diff, plan.changes.length), plan.changes.length, 'one diff per changed file');
    assert.deepEqual(snapshot(root), files);
  });

  await step('Apply writes exactly the previewed changes, and the next audit no longer reports those fixes', async () => {
    const previewed = plan!;
    const expected = snapshot(root);
    for (const c of previewed.changes) {
      if (c.renamedFrom) delete expected[c.renamedFrom];
      expected[c.path] = c.after;
    }
    assert.equal(await api!.apply(previewed), true, 'the plan was applied');
    assert.deepEqual(snapshot(root), expected);
    const audit = await until(() => {
      const audit = api?.state?.audit;
      return audit && previewed.changes.every((c) => audit.files.some((f) => f.path === c.path)) ? audit : undefined;
    }, 'an audit of the changed files');
    for (const fix of previewed.fixes) {
      const left = audit.diagnostics.filter((d) => d.kind === fix.kind && fix.paths.includes(d.path));
      assert.deepEqual(left, [], `${fix.kind} is still reported`);
    }
    const again = await vscode.commands.executeCommand<FixPlan | undefined>('turntax.previewFixes');
    assert.deepEqual(again?.changes, [], 'nothing is left to fix');
  });

  await step('Apply writes nothing when a file the plan depends on changed after the preview', async () => {
    // For Cursor alone, CLAUDE.md drops the lines that AGENTS.md also has: the plan depends on AGENTS.md without changing it.
    writeFileSync(join(root, 'turntax.config.json'), JSON.stringify({ tools: ['cursor'] }));
    const stale = await vscode.commands.executeCommand<FixPlan | undefined>('turntax.previewFixes');
    assert.ok(stale, 'a plan');
    assert.ok(stale.fixes.some((f) => f.kind === 'duplicate' && f.paths.includes('AGENTS.md')), JSON.stringify(stale.fixes));
    assert.ok(!stale.changes.some((c) => c.path === 'AGENTS.md' || c.renamedFrom === 'AGENTS.md'), 'the plan does not change AGENTS.md');
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nNothing in common with CLAUDE.md.\n');
    const files = snapshot(root);
    assert.equal(await api!.apply(stale), false, 'the stale plan was not applied');
    assert.deepEqual(snapshot(root), files);
  });

  await step('the repository test/fixtures is unchanged', async () => {
    assert.equal(fixtureStatus(), before, 'git status of test/fixtures is unchanged');
  });
}
