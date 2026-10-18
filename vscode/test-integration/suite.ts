import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { FixPlan } from '../../src/core/fix.js';
import type { TurntaxApi } from '../src/extension.js';

/** Runs in the extension host that run.ts starts on test/fixtures/mixed. Stops at the first failing step. */

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

export async function run(): Promise<void> {
  const before = fixtureStatus();
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a folder is open');
  const claude = vscode.Uri.joinPath(folder.uri, 'CLAUDE.md');
  let api: TurntaxApi | undefined;
  let diagnostics: vscode.Diagnostic[] = [];

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
    const shown = /([\d,]+) tok\/turn$/.exec(state.status?.text ?? '')?.[1];
    assert.equal(Number(shown?.replace(/,/g, '')), Number(process.env.TURNTAX_EXPECTED_HEADLINE), state.status?.text);
    assert.match(state.status?.tooltip ?? '', /^Claude Code: \d+ tokens\/turn$/m);
    assert.match(state.status?.tooltip ?? '', /o200k_base estimates/);
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
    const plan = await vscode.commands.executeCommand<FixPlan | undefined>('turntax.previewFixes');
    assert.ok(plan && plan.changes.length > 0, 'the plan has changes');
    const diff = (input: unknown) => input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'turntax-fix';
    assert.equal(await tabsWith(diff, plan.changes.length), plan.changes.length, 'one diff per changed file');
    assert.equal(fixtureStatus(), before, 'git status of test/fixtures is unchanged');
  });
}
