import { describe, expect, it } from 'vitest';
import { findImports, parseFrontmatter, resolvePath, splitSections, stripHtmlComments } from '../src/core/markdown.js';

describe('parseFrontmatter', () => {
  it('reads scalars, booleans, inline lists and block lists', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: deploy\nalwaysApply: true\nglobs: [src/**, "lib/*.ts"]\npaths:\n  - "a/**"\n  - b/*.md\n---\nBody\n',
    );
    expect(frontmatter).toEqual({
      name: 'deploy',
      alwaysApply: true,
      globs: ['src/**', 'lib/*.ts'],
      paths: ['a/**', 'b/*.md'],
    });
    expect(body).toBe('Body\n');
  });

  it('returns the whole text when there is no frontmatter', () => {
    expect(parseFrontmatter('# Title\n').body).toBe('# Title\n');
  });
});

describe('stripHtmlComments', () => {
  it('removes block comments but keeps comments inside code fences', () => {
    const text = 'a\n<!-- one line -->\nb\n<!--\nmulti\n-->\nc\n```html\n<!-- kept -->\n```\n';
    expect(stripHtmlComments(text)).toBe('a\nb\nc\n```html\n<!-- kept -->\n```\n');
  });
});

describe('findImports', () => {
  it('finds @path imports outside code and ignores emails and code spans', () => {
    const text = 'See @docs/a.md and @./b.md.\nMail me@example.com\n`@not/this.md`\n```\n@nor/this.md\n```\n@~/home.md';
    expect(findImports(text)).toEqual(['docs/a.md', './b.md', '~/home.md']);
  });

  it('keeps glob mentions whole', () => {
    expect(findImports('See @docs/*.md, @.agent/**/*.md and @**/RULES.md.')).toEqual(['docs/*.md', '.agent/**/*.md', '**/RULES.md']);
    expect(findImports('**See @AGENTS.md.** and @docs/rules.md** or @docs/**')).toEqual(['AGENTS.md', 'docs/rules.md', 'docs/**']);
  });
});

describe('resolvePath', () => {
  it('resolves relative to the importing file and refuses paths outside the repo', () => {
    expect(resolvePath('pkg/CLAUDE.md', '../docs/a.md')).toBe('docs/a.md');
    expect(resolvePath('CLAUDE.md', './b.md')).toBe('b.md');
    expect(resolvePath('CLAUDE.md', '../outside.md')).toBeNull();
    expect(resolvePath('CLAUDE.md', '~/x.md')).toBeNull();
    expect(resolvePath('CLAUDE.md', '/etc/x.md')).toBeNull();
  });
});

describe('splitSections', () => {
  it('splits at headings outside fences', () => {
    const sections = splitSections('intro\n# A\na\n```\n# not a heading\n```\n## B\nb\n');
    expect(sections.map((s) => [s.heading, s.line])).toEqual([
      ['(top)', 1],
      ['A', 2],
      ['B', 7],
    ]);
  });
});
