import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { classify } from '../src/core/classify.js';
import { planFixes, unifiedDiff } from '../src/core/fix.js';
import type { RepoFile } from '../src/core/types.js';
import { applyChanges } from '../src/node/apply.js';
import { discover, existsIn } from '../src/node/discover.js';
import { fixture, loadFixture, materialize } from './helpers.js';

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

const SHARED = [
  'Run the full test suite before every commit you make here.',
  'Keep functions small and name them after what they return.',
  'Never commit secrets, tokens or credentials to the repository.',
];

const API_SECTION = `## API package

The API lives in \`packages/api/\` and its handlers are in \`packages/api/handlers/\`.
Every handler in \`packages/api/handlers/\` must validate input with the shared schema module.
Database access goes through \`packages/api/db.ts\` only; do not import the driver elsewhere.
Write integration tests for handlers next to them in \`packages/api/handlers/\`.
Use structured logging in the API package and never log request bodies or headers at all.
Return problem+json errors from the API with a stable error code for each failure.
`;

const after = (plan: ReturnType<typeof planFixes>, path: string) => plan.changes.find((c) => c.path === path)?.after;

const files = await loadFixture('mixed');

describe('planFixes on the mixed fixture', () => {
  const plan = planFixes(files, { exists: existsIn(fixture('mixed')) });

  it('renames a .md rule in .cursor/rules to .mdc', () => {
    const rename = plan.changes.find((c) => c.renamedFrom === '.cursor/rules/wrong.md')!;
    expect(rename.path).toBe('.cursor/rules/wrong.mdc');
    expect(plan.fixes.find((f) => f.kind === 'misconfigured')!.message).toMatch(/only when @-mentioned/);
  });

  it('moves the API section into the nested CLAUDE.md that Claude Code and Cursor read there', () => {
    const fix = plan.fixes.find((f) => f.kind === 'scopable-section')!;
    expect(fix.paths).toEqual(['CLAUDE.md', 'packages/api/CLAUDE.md']);
    expect(fix.savingTokens).toBeGreaterThan(100);
    expect(after(plan, 'CLAUDE.md')).not.toContain('## API package');
    // A Windows checkout may have CRLF fixtures; the fix keeps each file's line endings.
    expect(after(plan, 'packages/api/CLAUDE.md')!.replace(/\r\n/g, '\n')).toMatch(/^# API package notes[\s\S]*\n\n## API package\n/);
  });

  it('keeps duplicates that an agent reads from only one of the files', () => {
    expect(plan.fixes.some((f) => f.kind === 'duplicate')).toBe(false);
    const claude = plan.skipped.find((s) => s.kind === 'duplicate' && s.paths[0] === 'CLAUDE.md')!;
    expect(claude.reason).toMatch(/Claude Code would lose them/);
  });

  it('prints a diff that git apply accepts and that matches the written files', () => {
    const viaGit = materialize('mixed', {});
    const viaWrite = materialize('mixed', {});
    execFileSync('git', ['init', '-q'], { cwd: viaGit });
    writeFileSync(join(viaGit, 'fix.patch'), unifiedDiff(plan.changes));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'fix.patch'], { cwd: viaGit });
    applyChanges(viaWrite, plan.changes);
    for (const path of ['CLAUDE.md', 'packages/api/CLAUDE.md', '.cursor/rules/wrong.mdc'])
      expect(readFileSync(join(viaGit, path), 'utf8')).toBe(readFileSync(join(viaWrite, path), 'utf8'));
    expect(existsSync(join(viaGit, '.cursor/rules/wrong.md'))).toBe(false);
  });

  it('does not rename Cursor rules when --tools leaves Cursor out', () => {
    const p = planFixes(files, { tools: ['codex'], exists: existsIn(fixture('mixed')) });
    expect(p.changes).toEqual([]);
  });
});

describe('duplicate lines', () => {
  it('removes lines from a file when every agent reading it gets them every turn elsewhere', () => {
    const files: RepoFile[] = [
      { path: 'AGENTS.md', text: `# Rules\n\n${SHARED.map((l) => `- ${l}`).join('\n')}\n` },
      { path: '.cursor/rules/always.mdc', text: `---\nalwaysApply: true\n---\n\n${SHARED.join('\n')}\nPrefer named exports in TypeScript modules.\n` },
    ];
    const plan = planFixes(files);
    const fix = plan.fixes.find((f) => f.kind === 'duplicate')!;
    expect(fix.paths).toEqual(['.cursor/rules/always.mdc', 'AGENTS.md']);
    expect(fix.savingTokens).toBeGreaterThan(20);
    expect(after(plan, '.cursor/rules/always.mdc')).toBe('---\nalwaysApply: true\n---\n\nPrefer named exports in TypeScript modules.\n');
    expect(plan.changes.map((c) => c.path)).toEqual(['.cursor/rules/always.mdc']);
    const units = classify([files[0]!, { path: '.cursor/rules/always.mdc', text: after(plan, '.cursor/rules/always.mdc')! }]);
    expect(units.find((u) => u.tool === 'cursor' && u.path === 'AGENTS.md')!.mode).toBe('always');
  });

  it('keeps one copy when two files are read by exactly the same agents', () => {
    const text = SHARED.join('\n') + '\n';
    const files: RepoFile[] = [
      { path: '.cursor/rules/a.mdc', text: `---\nalwaysApply: true\n---\n${text}` },
      { path: '.cursor/rules/b.mdc', text: `---\nalwaysApply: true\n---\n${text}` },
    ];
    const plan = planFixes(files);
    expect(plan.changes).toHaveLength(1);
    expect(after(plan, plan.changes[0]!.path)).toBe('---\nalwaysApply: true\n---\n');
  });

  it('keeps a line that @imports a file the agent would otherwise lose', () => {
    // Rules files do not expand @imports, so only the CLAUDE.md copy loads docs/architecture.md.
    const line = 'Read @docs/architecture.md before you change the public API surface.';
    const files: RepoFile[] = [
      { path: 'CLAUDE.md', text: `# Guide\n\n${line}\n` },
      { path: '.claude/rules/general.md', text: `${line}\n` },
      { path: 'docs/architecture.md', text: 'The API is versioned by URL prefix and never breaks old clients.\n' },
    ];
    const plan = planFixes(files, { tools: ['claude-code'] });
    expect(plan.changes.find((c) => c.path === 'CLAUDE.md')).toBeUndefined();
    expect(plan.skipped.some((s) => s.reason.includes('Kept 1 line(s) in CLAUDE.md'))).toBe(true);
  });

  it('never changes files that are only @imported, such as a README', () => {
    const readme = `# Project\n\n${SHARED.join('\n')}\n\n${API_SECTION}`;
    const files: RepoFile[] = [
      { path: 'CLAUDE.md', text: `@README.md\n\n${SHARED.join('\n')}\n` },
      { path: 'README.md', text: readme },
    ];
    const plan = planFixes(files, { tools: ['claude-code'], exists: () => true });
    expect(plan.changes.find((c) => c.path === 'README.md')).toBeUndefined();
    expect(plan.skipped.some((s) => s.reason.startsWith('README.md is not an agent instruction file'))).toBe(true);
  });

  it('applies edits to a renamed Cursor rule', () => {
    const files: RepoFile[] = [
      { path: 'AGENTS.md', text: `${SHARED.join('\n')}\n` },
      { path: '.cursor/rules/style.md', text: `---\nalwaysApply: true\n---\n\n${SHARED.join('\n')}\nPrefer named exports.\n` },
    ];
    const plan = planFixes(files);
    expect(plan.changes).toEqual([
      { path: '.cursor/rules/style.mdc', renamedFrom: '.cursor/rules/style.md', before: files[1]!.text, after: '---\nalwaysApply: true\n---\n\nPrefer named exports.\n' },
    ]);
    const diff = unifiedDiff(plan.changes);
    expect(diff).toMatch(/^diff --git a\/\.cursor\/rules\/style\.md b\/\.cursor\/rules\/style\.mdc\nrename from .*\nrename to .*\n--- a\/\.cursor\/rules\/style\.md\n\+\+\+ b\/\.cursor\/rules\/style\.mdc\n@@/);
  });
});

describe('scopable sections', () => {
  const exists = (p: string) => ['packages', 'packages/api'].includes(p);

  it('moves a section of the root AGENTS.md into a nested AGENTS.md for the chosen agents, keeping CRLF', () => {
    const files: RepoFile[] = [{ path: 'AGENTS.md', text: `# Rules\n\nUse npm.\n\n${API_SECTION}`.replace(/\n/g, '\r\n') }];
    const plan = planFixes(files, { exists, tools: ['codex', 'cursor', 'claude-code'] });
    expect(plan.fixes[0]!.paths).toEqual(['AGENTS.md', 'packages/api/AGENTS.md']);
    expect(plan.changes.find((c) => c.path === 'packages/api/AGENTS.md')!.before).toBeNull();
    expect(after(plan, 'AGENTS.md')).toBe('# Rules\r\n\r\nUse npm.\r\n');
    expect(after(plan, 'packages/api/AGENTS.md')).toBe(API_SECTION.replace(/\n/g, '\r\n'));
  });

  it('keeps a section where it is when an agent would stop reading it', () => {
    // Zed and others read only the root AGENTS.md; a nested copy never reaches them.
    const plan = planFixes([{ path: 'AGENTS.md', text: `# Rules\n\n${API_SECTION}` }], { exists });
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/Zed[^;]* would lose context[\s\S]*--tools/);
  });

  it('does not create a file that hides another file from an agent', () => {
    // Amp reads one file per folder (AGENTS.md before CLAUDE.md), so a new packages/api/AGENTS.md hides packages/api/CLAUDE.md.
    const files: RepoFile[] = [
      { path: 'AGENTS.md', text: `# Rules\n\n${API_SECTION}` },
      { path: 'packages/api/CLAUDE.md', text: 'Handlers must stay thin and delegate business rules to services.\n' },
    ];
    const plan = planFixes(files, { exists, tools: ['codex', 'amp'] });
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/packages\/api\/AGENTS\.md \(Amp would lose context\)/);
  });

  it('keeps a general rule every turn when its other copy moves into a folder', () => {
    const rule = 'Never commit secrets, tokens or credentials to the repository.';
    const files: RepoFile[] = [
      { path: 'CLAUDE.md', text: `# Rules\n\n${API_SECTION}${rule}\n` },
      { path: '.claude/rules/general.md', text: `${rule}\n` },
    ];
    const plan = planFixes(files, { exists, tools: ['claude-code', 'cursor'] });
    expect(plan.fixes.map((f) => f.kind)).toEqual(['scopable-section']);
    expect(plan.changes.find((c) => c.path === '.claude/rules/general.md')).toBeUndefined();
  });

  it('treats lines that differ in case, underscores or asterisks as different', () => {
    const a = 'Call `create_user` from the handlers, never the repository directly.';
    const b = 'Call `createuser` from the handlers, never the repository directly.';
    const files: RepoFile[] = [
      { path: 'AGENTS.md', text: `${a}\nMatch files with src/**/*.ts when you add new modules.\n` },
      { path: '.cursor/rules/always.mdc', text: `---\nalwaysApply: true\n---\n${b}\nMatch files with src/*/.ts when you add new modules.\n` },
    ];
    expect(planFixes(files).changes).toEqual([]);
  });

  it('does not count a line quoted in a code block as a copy', () => {
    const line = 'Run the full test suite before every commit you make here.';
    const files: RepoFile[] = [
      { path: 'AGENTS.md', text: `Example:\n\n\`\`\`\n${line}\n\`\`\`\n` },
      { path: '.cursor/rules/always.mdc', text: `---\nalwaysApply: true\n---\n${line}\n` },
    ];
    expect(planFixes(files).changes).toEqual([]);
  });

  it('moves a section together with its subsections', () => {
    const text = `# Rules\n\n${API_SECTION}\n### Error codes\n\nKeep codes stable.\n\n## Frontend\n\nUse server components.\n`;
    const plan = planFixes([{ path: 'CLAUDE.md', text }], { exists, tools: ['claude-code', 'cursor'] });
    expect(after(plan, 'packages/api/CLAUDE.md')).toBe(`${API_SECTION}\n### Error codes\n\nKeep codes stable.\n`);
    expect(after(plan, 'CLAUDE.md')).toBe('# Rules\n\n## Frontend\n\nUse server components.\n');
  });

  it('does not create folders that do not exist', () => {
    const plan = planFixes([{ path: 'CLAUDE.md', text: `# Rules\n\n${API_SECTION}` }], { exists: () => false });
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/packages\/api\/ does not exist/);
  });

  it('skips sections with @imports, which would resolve from the new folder', () => {
    const plan = planFixes([{ path: 'CLAUDE.md', text: `# Rules\n\n${API_SECTION}See @docs/api.md for details.\n` }], { exists });
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/@imports/);
  });
});

describe('unifiedDiff', () => {
  it('marks a missing newline at the end of a file', () => {
    expect(unifiedDiff([{ path: 'a.md', before: 'one\ntwo', after: 'one\nthree' }])).toBe(
      'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n',
    );
  });
});

describe('cli --fix', () => {
  it('prints the diff on stdout and the summary on stderr without changing files', async () => {
    const dir = materialize('mixed', {});
    const io = capture();
    expect(await main([dir, '--fix'], {})).toBe(0);
    expect(io.out()).toMatch(/^diff --git a\/\.cursor\/rules\/wrong\.md b\/\.cursor\/rules\/wrong\.mdc/);
    expect(io.err()).toMatch(/Preview only/);
    expect(existsSync(join(dir, '.cursor/rules/wrong.md'))).toBe(true);
  });

  it('applies the changes with --write, after which nothing is left to fix', async () => {
    const dir = materialize('mixed', {});
    const io = capture();
    expect(await main([dir, '--fix', '--write'], {})).toBe(0);
    expect(io.out()).toMatch(/Changed 3 file\(s\)/);
    expect(readFileSync(join(dir, 'packages/api/CLAUDE.md'), 'utf8')).toContain('## API package');
    const again = planFixes(await discover(dir), { exists: existsIn(dir) });
    expect(again.changes).toEqual([]);
  });

  it('applies a renamed and edited rule the same way as git apply', () => {
    const dir = materialize('mixed', {});
    const rule = `---\nalwaysApply: true\n---\n\nRun the full test suite with \`pnpm run test\` before every commit you make.\nPrefer named exports.\n`;
    writeFileSync(join(dir, '.cursor/rules/wrong.md'), rule);
    const viaGit = materialize('mixed', {});
    writeFileSync(join(viaGit, '.cursor/rules/wrong.md'), rule);
    const plan = planFixes(files.map((f) => (f.path === '.cursor/rules/wrong.md' ? { ...f, text: rule } : f)), { exists: existsIn(dir) });
    expect(plan.changes.find((c) => c.renamedFrom)!.after).not.toBe(rule);
    applyChanges(dir, plan.changes);
    execFileSync('git', ['init', '-q'], { cwd: viaGit });
    writeFileSync(join(viaGit, 'fix.patch'), unifiedDiff(plan.changes));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'fix.patch'], { cwd: viaGit });
    expect(readFileSync(join(dir, '.cursor/rules/wrong.mdc'), 'utf8')).toBe(readFileSync(join(viaGit, '.cursor/rules/wrong.mdc'), 'utf8'));
    expect(existsSync(join(dir, '.cursor/rules/wrong.md'))).toBe(false);
  });

  it('never writes through a symlink or outside the repository', async () => {
    const dir = materialize('agents-only', {});
    try {
      mkdirSync(join(dir, '.github'), { recursive: true });
      symlinkSync('../AGENTS.md', join(dir, '.github/copilot-instructions.md'), 'file');
    } catch {
      return; // Creating symlinks needs extra rights on some Windows setups.
    }
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    capture();
    expect(await main([dir, '--fix', '--write', '--tools', 'codex,copilot,claude-code'], {})).toBe(0);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(() => applyChanges(dir, [{ path: '.github/copilot-instructions.md', before: agents, after: '' }])).toThrow(/symlink/);
  });

  it('never writes outside the repository, also through a linked folder', async () => {
    const dir = materialize('mixed', {});
    const elsewhere = mkdtempSync(join(tmpdir(), 'turntax-elsewhere-'));
    const nested = readFileSync(join(dir, 'packages/api/CLAUDE.md'), 'utf8');
    writeFileSync(join(elsewhere, 'CLAUDE.md'), nested);
    rmSync(join(dir, 'packages/api'), { recursive: true });
    symlinkSync(elsewhere, join(dir, 'packages/api'), 'junction');
    capture();
    expect(await main([dir, '--fix', '--write'], {})).toBe(0);
    expect(readFileSync(join(elsewhere, 'CLAUDE.md'), 'utf8')).toBe(nested);
    expect(() => applyChanges(dir, [{ path: 'packages/api/AGENTS.md', before: null, after: 'x' }])).toThrow(/outside/);
    expect(() => applyChanges(dir, [{ path: '../outside.md', before: null, after: 'x' }])).toThrow(/outside/);
  });

  it('never writes through a dangling link', () => {
    const dir = materialize('mixed', {});
    const missing = join(tmpdir(), `turntax-missing-${Date.now()}`);
    symlinkSync(missing, join(dir, 'gone'), 'junction');
    expect(() => applyChanges(dir, [{ path: 'gone/AGENTS.md', before: null, after: 'x' }])).toThrow(/outside/);
    try {
      symlinkSync(join(missing, 'file.md'), join(dir, 'LINKED.md'), 'file');
    } catch {
      return; // Creating file symlinks needs extra rights on some Windows setups.
    }
    expect(() => applyChanges(dir, [{ path: 'LINKED.md', before: null, after: 'x' }])).toThrow(/symlink/);
    expect(existsSync(missing)).toBe(false);
  });

  it('writes nothing when a file changed after it was read', async () => {
    const dir = materialize('mixed', {});
    const plan = planFixes(await discover(dir), { exists: existsIn(dir) });
    writeFileSync(join(dir, 'CLAUDE.md'), 'edited\n');
    expect(() => applyChanges(dir, plan.changes)).toThrow(/CLAUDE\.md changed/);
    expect(existsSync(join(dir, '.cursor/rules/wrong.md'))).toBe(true);
  });

  it('empties the --out file when nothing is left to fix', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'turntax-out-')), 'fix.patch');
    writeFileSync(out, 'stale patch\n');
    capture();
    expect(await main([fixture('agents-only'), '--fix', '--out', out], {})).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('');
  });

  it('rejects --write without --fix and --fix with report formats', async () => {
    capture();
    expect(await main([fixture('mixed'), '--write'], {})).toBe(2);
    expect(await main([fixture('mixed'), '--fix', '--json'], {})).toBe(2);
  });
});
