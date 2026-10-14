import { describe, expect, it } from 'vitest';
import { folderExists, linkedCheck, planWebFixes } from '../src/web/fixes.js';
import { SAMPLE_REPO } from '../src/web/sample.js';

const RENAME = '.cursor/rules/legacy.md';

describe('folderExists', () => {
  it('knows a folder when some path lies under it', () => {
    const exists = folderExists(['apps/web/package.json', 'README.md']);
    expect(['apps', 'apps/web'].map(exists)).toEqual([true, true]);
    expect(['apps/web/package.json', 'README.md', 'apps/we', 'docs'].map(exists)).toEqual([false, false, false, false]);
  });
});

describe('linkedCheck', () => {
  it('covers links, their targets and everything under them', () => {
    const linked = linkedCheck(['CLAUDE.md', 'AGENTS.md', '.clinerules']);
    expect(['CLAUDE.md', 'AGENTS.md', '.clinerules/a.md'].map(linked)).toEqual([true, true, true]);
    expect(['GEMINI.md', 'docs/CLAUDE.md', '.clinerules-old/a.md'].map(linked)).toEqual([false, false, false]);
  });
});

describe('planWebFixes', () => {
  it('plans the sample fixes with a git apply patch', () => {
    const plan = planWebFixes({ files: SAMPLE_REPO });
    expect(plan.fixes.map((f) => f.paths)).toEqual([[RENAME, '.cursor/rules/legacy.mdc']]);
    expect(plan.diff).toContain(`rename from ${RENAME}\nrename to .cursor/rules/legacy.mdc\n`);
    // Without a path list no folder is known to exist, so the section is not moved, even for one agent.
    expect(plan.skipped.map((s) => s.reason)).toContain('Section "Web app": folder apps/web/ is not known here; load the whole folder or repository to move sections.');
    expect(planWebFixes({ files: SAMPLE_REPO }, ['codex']).changes.some((c) => c.path === 'apps/web/AGENTS.md')).toBe(false);
  });

  it('moves a section once the folder is known and the agents are narrowed', () => {
    const plan = planWebFixes({ files: SAMPLE_REPO, paths: ['apps/web/package.json'] }, ['codex']);
    expect(plan.fixes.map((f) => f.paths)).toEqual([['AGENTS.md', 'apps/web/AGENTS.md']]);
    expect(plan.diff).toContain('--- /dev/null\n+++ b/apps/web/AGENTS.md\n');
    // Cursor is not among the agents, so its rule is not renamed.
    expect(plan.diff).not.toContain(RENAME);
  });

  it('keeps every agent by default, so the section stays put', () => {
    const plan = planWebFixes({ files: SAMPLE_REPO, paths: ['apps/web/package.json'] });
    expect(plan.changes.some((c) => c.path === 'apps/web/AGENTS.md')).toBe(false);
    expect(plan.skipped.find((s) => s.kind === 'scopable-section')!.reason).toMatch(/no target keeps every agent's context/);
  });

  it('leaves symlinks, files in linked folders and link targets alone', () => {
    for (const linked of [[RENAME], ['.cursor/rules'], ['.cursor']]) {
      const plan = planWebFixes({ files: SAMPLE_REPO, linked });
      expect(plan.changes, linked.join()).toEqual([]);
      expect(plan.diff).toBe('');
      expect(plan.skipped.find((s) => s.kind === 'misconfigured')!.reason).toBe(
        `${RENAME} is a symlink, in a symlinked folder or the target of a symlink; it is left alone.`,
      );
    }
    // A linked target folder is never written into.
    const plan = planWebFixes({ files: SAMPLE_REPO, paths: ['apps/web/package.json'], linked: ['apps/web'] }, ['codex']);
    expect(plan.changes).toEqual([]);
  });

  it('never writes over a repository file that is not loaded', () => {
    const plan = planWebFixes({ files: SAMPLE_REPO, paths: ['apps/web/AGENTS.md'] }, ['codex']);
    expect(plan.changes.some((c) => c.path === 'apps/web/AGENTS.md')).toBe(false);
  });

  it('returns an empty patch when nothing changes', () => {
    const plan = planWebFixes({ files: [{ path: 'AGENTS.md', text: '# Rules\r\n\r\nKeep commits small.\r\n' }] });
    expect(plan.changes).toEqual([]);
    expect(plan.diff).toBe('');
  });
});
