import { describe, expect, it } from 'vitest';
import { globMatcher, globToRegExp } from '../src/core/glob.js';

const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

describe('globToRegExp', () => {
  it('matches * and ? within one folder name', () => {
    expect(matches('*.md', 'AGENTS.md')).toBe(true);
    expect(matches('*.md', 'docs/AGENTS.md')).toBe(false);
    expect(matches('.cursor/rules/*.mdc', '.cursor/rules/ts.mdc')).toBe(true);
    expect(matches('.cursor/rules/*.mdc', '.cursor/rules/sub/ts.mdc')).toBe(false);
    expect(matches('GEMINI.m?', 'GEMINI.md')).toBe(true);
    expect(matches('a?b', 'a/b')).toBe(false);
  });

  it('matches ** across folders, including none', () => {
    expect(matches('**/CLAUDE.md', 'CLAUDE.md')).toBe(true);
    expect(matches('**/CLAUDE.md', 'packages/api/CLAUDE.md')).toBe(true);
    expect(matches('packages/**/AGENTS.md', 'packages/AGENTS.md')).toBe(true);
    expect(matches('packages/**/AGENTS.md', 'packages/a/b/AGENTS.md')).toBe(true);
    expect(matches('packages/**', 'packages/a/b/AGENTS.md')).toBe(true);
    expect(matches('packages/**', 'other/AGENTS.md')).toBe(false);
    expect(matches('**', '.claude/rules/x.md')).toBe(true);
  });

  it('treats a trailing slash as a whole folder', () => {
    expect(matches('legacy/', 'legacy/AGENTS.md')).toBe(true);
    expect(matches('legacy/', 'legacy/a/CLAUDE.md')).toBe(true);
    expect(matches('legacy/', 'legacy')).toBe(false);
    expect(matches('legacy/', 'src/legacy/AGENTS.md')).toBe(false);
  });

  it('matches the whole path literally otherwise', () => {
    expect(matches('docs/a+b.md', 'docs/a+b.md')).toBe(true);
    expect(matches('docs/a.md', 'docs/aXmd')).toBe(false);
    expect(matches('./AGENTS.md', 'AGENTS.md')).toBe(true);
    expect(matches('AGENTS.md', 'sub/AGENTS.md')).toBe(false);
    expect(matches('docs\\*.md', 'docs/x.md')).toBe(true);
  });
});

describe('globMatcher', () => {
  it('matches any of the globs, and nothing without globs', () => {
    const ignored = globMatcher(['GEMINI.md', '.windsurf/']);
    expect(['GEMINI.md', '.windsurf/rules/a.md', 'AGENTS.md'].map(ignored)).toEqual([true, true, false]);
    expect(globMatcher([])('AGENTS.md')).toBe(false);
  });
});
