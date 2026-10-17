import { describe, expect, it } from 'vitest';
import { buildAdvice } from '../src/core/advice.js';
import { classify } from '../src/core/classify.js';
import { isInstructionFile } from '../src/core/files.js';
import type { RepoFile } from '../src/core/types.js';
import { classifyUser } from '../src/core/user.js';
import { find } from './helpers.js';

/** Windows checkouts may use CRLF; every rule must read the same either way. */
const crlf = (files: RepoFile[]): RepoFile[] => files.map((f) => ({ path: f.path, text: f.text.replace(/\n/g, '\r\n') }));

describe('Warp', () => {
  it('prefers WARP.md over AGENTS.md in one folder and loads nested files on a best-effort basis', () => {
    const u = classify(
      [
        { path: 'WARP.md', text: 'Warp rules.' },
        { path: 'AGENTS.md', text: 'Shared rules.' },
        { path: 'pkg/AGENTS.md', text: 'Package rules.' },
        { path: 'CLAUDE.md', text: 'Claude only.' },
        { path: 'agents.md', text: 'Lowercase.' },
      ],
      ['warp'],
    );
    expect(find(u, 'warp', 'WARP.md')!.mode).toBe('always');
    expect(find(u, 'warp', 'AGENTS.md')!.trigger).toBe('WARP.md takes precedence');
    expect(find(u, 'warp', 'pkg/AGENTS.md')!.trigger).toBe('best effort when Warp edits files in pkg/');
    expect(find(u, 'warp', 'CLAUDE.md')).toBeUndefined();
    expect(find(u, 'warp', 'agents.md')).toBeUndefined();
  });

  it("lists skills from every supported folder, and subfolder skills only when working there", () => {
    const u = classify(
      [
        { path: '.factory/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy the app\n---\nSteps.' },
        { path: 'pkg/.warp/skills/build/SKILL.md', text: '---\nname: build\ndescription: Build pkg\n---\nSteps.' },
      ],
      ['warp'],
    );
    expect(find(u, 'warp', '.factory/skills/deploy/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'warp', '.factory/skills/deploy/SKILL.md', 'body')!.mode).toBe('on-demand');
    expect(find(u, 'warp', 'pkg/.warp/skills/build/SKILL.md', 'description')!.mode).toBe('on-demand');
  });
});

describe('Factory Droid', () => {
  it('reads AGENTS.md, CLAUDE.md and .factory/AGENTS.md together at the same level', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
        { path: '.factory/AGENTS.md', text: 'Factory.' },
        { path: 'pkg/.agents/AGENTS.md', text: 'Nested.' },
        { path: 'DESIGN.md', text: 'Design system.' },
        { path: 'docs/DESIGN.md', text: 'Not read.' },
      ],
      ['factory-droid'],
    );
    for (const p of ['AGENTS.md', 'CLAUDE.md', '.factory/AGENTS.md', 'DESIGN.md']) expect(find(u, 'factory-droid', p)!.mode, p).toBe('always');
    expect(find(u, 'factory-droid', 'pkg/.agents/AGENTS.md')!.trigger).toBe('when Droid reads files in pkg/');
    expect(find(u, 'factory-droid', 'docs/DESIGN.md')).toBeUndefined();
  });

  it('finds skills recursively, hides model-disabled ones and does not read .claude skills in place', () => {
    const u = classify(
      [
        { path: '.factory/skills/ops/release/SKILL.md', text: '---\nname: release\ndescription: Cut a release\n---\nSteps.' },
        { path: '.factory/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Deploy\ndisable-model-invocation: true\n---\nSteps.' },
        { path: '.claude/skills/x/SKILL.md', text: '---\nname: x\ndescription: X\n---\nSteps.' },
        { path: '.factory/droids/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews diffs\n---\nYou review diffs.' },
        { path: '.factory/commands/ship.md', text: 'Ship it.' },
      ],
      ['factory-droid'],
    );
    expect(find(u, 'factory-droid', '.factory/skills/ops/release/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'factory-droid', '.factory/skills/deploy/SKILL.md', 'description')!.mode).toBe('manual');
    expect(find(u, 'factory-droid', '.claude/skills/x/SKILL.md', 'description')).toBeUndefined();
    expect(find(u, 'factory-droid', '.factory/droids/reviewer.md', 'description')!.text).toBe('reviewer: Reviews diffs');
    expect(find(u, 'factory-droid', '.factory/commands/ship.md')!.mode).toBe('manual');
  });

  it('flags AGENTS-style files over the 80,000-character startup cap', () => {
    const files = [{ path: 'AGENTS.md', text: 'Run the tests before every commit.\n'.repeat(2400) }];
    const advice = buildAdvice(classify(files, ['factory-droid']), files);
    const limit = advice.find((a) => a.kind === 'size-limit' && a.tools.includes('factory-droid'))!;
    expect(limit.message).toMatch(/limit 80000/);
    expect(limit.severity).toBe('high');
  });
});

describe('TRAE', () => {
  const rules: RepoFile[] = [
    { path: '.trae/rules/always.md', text: '---\nalwaysApply: true\n---\nAlways.' },
    { path: '.trae/rules/ts.md', text: '---\nalwaysApply: false\nglobs: src/**/*.ts\n---\nTS only.' },
    { path: '.trae/rules/db.md', text: '---\nalwaysApply: false\ndescription: Database work\n---\nDB rules.' },
    { path: '.trae/rules/manual.md', text: '---\nalwaysApply: false\n---\nOn #Rule only.' },
    { path: '.trae/rules/plain.md', text: 'No frontmatter.' },
    { path: '.trae/rules/a/b/c/deep.md', text: '---\nalwaysApply: true\n---\nThird level.' },
    { path: '.trae/rules/a/b/c/d/too-deep.md', text: '---\nalwaysApply: true\n---\nFourth level.' },
    { path: 'pkg/.trae/rules/pkg.md', text: '---\nalwaysApply: true\n---\nPackage.' },
  ];

  it.each([
    ['LF', rules],
    ['CRLF', crlf(rules)],
  ])('maps alwaysApply, globs and description (%s)', (_eol, files) => {
    const u = classify(files, ['trae']);
    expect(find(u, 'trae', '.trae/rules/always.md')!.mode).toBe('always');
    expect(find(u, 'trae', '.trae/rules/ts.md')!.trigger).toBe('globs: src/**/*.ts');
    expect(find(u, 'trae', '.trae/rules/db.md', 'description')!).toMatchObject({ mode: 'always', text: 'Database work' });
    expect(find(u, 'trae', '.trae/rules/db.md', 'body')!.mode).toBe('on-demand');
    expect(find(u, 'trae', '.trae/rules/manual.md')!.mode).toBe('manual');
    const plain = find(u, 'trae', '.trae/rules/plain.md')!;
    expect(plain.mode).toBe('manual');
    expect(plain.notes.join(' ')).toMatch(/not counted/);
    expect(plain.problem).toBeUndefined();
  });

  it('reads three folder levels deep, ignores deeper rules and scopes subfolder rules', () => {
    const u = classify(rules, ['trae']);
    expect(find(u, 'trae', '.trae/rules/a/b/c/deep.md')!.mode).toBe('always');
    const deep = find(u, 'trae', '.trae/rules/a/b/c/d/too-deep.md')!;
    expect(deep.mode).toBe('ignored');
    expect(deep.problem).toMatch(/three folder levels/);
    expect(find(u, 'trae', 'pkg/.trae/rules/pkg.md')!).toMatchObject({ mode: 'on-demand', trigger: 'when working in pkg/' });
  });

  it('leaves AGENTS.md and CLAUDE.md out, since their switches have no documented default', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'pkg/AGENTS.md', text: 'Nested.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
        { path: '.trae/skills/review/SKILL.md', text: '---\nname: review\ndescription: Review code\n---\nSteps.' },
        { path: '.agents/skills/other/SKILL.md', text: '---\nname: other\ndescription: Other\n---\nSteps.' },
      ],
      ['trae'],
    );
    expect(find(u, 'trae', 'AGENTS.md')).toBeUndefined();
    expect(find(u, 'trae', 'pkg/AGENTS.md')).toBeUndefined();
    expect(find(u, 'trae', 'CLAUDE.md')).toBeUndefined();
    expect(find(u, 'trae', '.trae/skills/review/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'trae', '.agents/skills/other/SKILL.md')!.mode).toBe('manual');
  });
});

describe('Augment Code', () => {
  it('maps the type frontmatter of .augment/rules', () => {
    const u = classify(
      crlf([
        { path: '.augment/rules/plain.md', text: 'No frontmatter.' },
        { path: '.augment/rules/always.md', text: '---\ntype: always_apply\n---\nAlways.' },
        { path: '.augment/rules/react/components.md', text: '---\ntype: agent_requested\ndescription: React components\n---\nReact.' },
        { path: '.augment/rules/nodesc.md', text: '---\ntype: agent_requested\n---\nNo description.' },
        { path: '.augment/rules/manual.md', text: '---\ntype: manual\n---\nIDE only.' },
        { path: '.augment/rules/odd.md', text: '---\ntype: sometimes\n---\nUnknown.' },
      ]),
      ['augment'],
    );
    expect(find(u, 'augment', '.augment/rules/plain.md')!.mode).toBe('always');
    expect(find(u, 'augment', '.augment/rules/always.md')!.mode).toBe('always');
    expect(find(u, 'augment', '.augment/rules/react/components.md', 'description')!).toMatchObject({ mode: 'always', text: 'React components' });
    expect(find(u, 'augment', '.augment/rules/react/components.md', 'body')!.mode).toBe('on-demand');
    expect(find(u, 'augment', '.augment/rules/nodesc.md')!.problem).toMatch(/no description/);
    expect(find(u, 'augment', '.augment/rules/manual.md')!.mode).toBe('manual');
    const odd = find(u, 'augment', '.augment/rules/odd.md')!;
    expect(odd.mode).toBe('always');
    expect(odd.problem).toMatch(/Unknown rule type "sometimes"/);
  });

  it('reads AGENTS.md and CLAUDE.md at every level but .augment/rules only at the root', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
        { path: 'src/AGENTS.md', text: 'Nested agents.' },
        { path: 'src/CLAUDE.md', text: 'Nested claude.' },
        { path: '.augment-guidelines', text: 'Guidelines.' },
        { path: 'src/.augment/rules/nested.md', text: 'Not read.' },
      ],
      ['augment'],
    );
    for (const p of ['AGENTS.md', 'CLAUDE.md', '.augment-guidelines']) expect(find(u, 'augment', p)!.mode, p).toBe('always');
    expect(find(u, 'augment', 'src/AGENTS.md')!.trigger).toBe('when Augment works on a file in src/');
    expect(find(u, 'augment', 'src/CLAUDE.md')!.mode).toBe('on-demand');
    const nested = find(u, 'augment', 'src/.augment/rules/nested.md')!;
    expect(nested.mode).toBe('ignored');
    expect(nested.problem).toMatch(/workspace root/);
  });

  it('flags workspace guidelines past 49,512 characters', () => {
    const files = [{ path: '.augment-guidelines', text: 'Prefer small modules with explicit types.\n'.repeat(1300) }];
    const advice = buildAdvice(classify(files, ['augment']), files);
    expect(advice.find((a) => a.kind === 'size-limit' && a.tools.includes('augment'))!.message).toMatch(/limit 49512/);
  });
});

describe('Kilo Code', () => {
  it('reads the first root instruction file and nested AGENTS.md on demand', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
        { path: 'CONTEXT.md', text: 'Context.' },
        { path: 'src/backend/AGENTS.md', text: 'Backend.' },
        { path: 'src/backend/CLAUDE.md', text: 'Not documented.' },
      ],
      ['kilo-code'],
    );
    expect(find(u, 'kilo-code', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'kilo-code', 'CLAUDE.md')!.trigger).toBe('AGENTS.md takes precedence');
    expect(find(u, 'kilo-code', 'CONTEXT.md')!.mode).toBe('ignored');
    expect(find(u, 'kilo-code', 'src/backend/AGENTS.md')!.trigger).toBe('when the Read tool opens a file in src/backend/');
    expect(find(u, 'kilo-code', 'src/backend/CLAUDE.md')).toBeUndefined();
    const context = classify([{ path: 'CONTEXT.md', text: 'Context.' }], ['kilo-code']);
    expect(find(context, 'kilo-code', 'CONTEXT.md')!.mode).toBe('always');
  });

  it('loads rule folders always and mode rules only in their mode', () => {
    const u = classify(
      [
        { path: '.kilo/rules/style.md', text: 'Style.' },
        { path: '.kilocode/rules/legacy.md', text: 'Legacy folder.' },
        { path: '.kilo/rules-code/code.md', text: 'Code mode.' },
        { path: '.kilocode/rules-architect/arch.md', text: 'Architect mode.' },
        { path: '.kilocoderules', text: 'Legacy file.' },
        { path: '.kilocoderules-debug', text: 'Debug mode.' },
        { path: '.kilo/skills/api/SKILL.md', text: '---\nname: api\ndescription: API design\n---\nSteps.' },
        { path: '.kilo/commands/submit-pr.md', text: 'Submit.' },
      ],
      ['kilo-code'],
    );
    for (const p of ['.kilo/rules/style.md', '.kilocode/rules/legacy.md', '.kilocoderules']) expect(find(u, 'kilo-code', p)!.mode, p).toBe('always');
    for (const p of ['.kilo/rules-code/code.md', '.kilocode/rules-architect/arch.md', '.kilocoderules-debug'])
      expect(find(u, 'kilo-code', p)!.mode, p).toBe('on-demand');
    expect(find(u, 'kilo-code', '.kilo/rules-code/code.md')!.trigger).toBe('only in that Kilo mode');
    expect(find(u, 'kilo-code', '.kilo/skills/api/SKILL.md', 'description')!.mode).toBe('always');
    expect(find(u, 'kilo-code', '.kilo/commands/submit-pr.md')!.mode).toBe('manual');
  });
});

describe('Google Jules', () => {
  it('reads only the root AGENTS.md', () => {
    const u = classify(
      [
        { path: 'AGENTS.md', text: 'Agents.' },
        { path: 'pkg/AGENTS.md', text: 'Nested.' },
        { path: 'CLAUDE.md', text: 'Claude.' },
      ],
      ['jules'],
    );
    expect(find(u, 'jules', 'AGENTS.md')!.mode).toBe('always');
    expect(find(u, 'jules', 'pkg/AGENTS.md')).toBeUndefined();
    expect(find(u, 'jules', 'CLAUDE.md')).toBeUndefined();
  });
});

describe('Devin Local / Devin CLI', () => {
  it('loads every root rule file together and the same files in subfolders on demand', () => {
    const names = ['AGENTS.md', 'AGENTS.local.md', 'AGENT.md', '.windsurfrules', 'CLAUDE.md'];
    const u = classify([...names.map((path) => ({ path, text: path })), { path: 'pkg/CLAUDE.md', text: 'Nested.' }], ['devin']);
    for (const p of names) expect(find(u, 'devin', p)!.mode, p).toBe('always');
    expect(find(u, 'devin', 'pkg/CLAUDE.md')!.trigger).toBe('when Devin accesses files in pkg/');
  });

  it('reads .cursor/rules with the same activation logic as Cursor, including plain .md files', () => {
    const files: RepoFile[] = [
      { path: '.cursor/rules/always.mdc', text: '---\nalwaysApply: true\n---\nAlways.' },
      { path: '.cursor/rules/ts.mdc', text: '---\nglobs: src/**/*.ts\n---\nTS.' },
      { path: '.cursor/rules/desc.mdc', text: '---\ndescription: Migrations\n---\nBody.' },
      { path: '.cursor/rules/none.mdc', text: 'No frontmatter.' },
    ];
    const u = classify(files, ['cursor', 'devin']);
    for (const f of files)
      for (const part of ['full', 'description', 'body'] as const) {
        const cursor = find(u, 'cursor', f.path, part);
        const devin = find(u, 'devin', f.path, part);
        expect(devin && { mode: devin.mode, trigger: devin.trigger }, `${f.path} ${part}`).toEqual(cursor && { mode: cursor.mode, trigger: cursor.trigger });
      }
    const md = classify([{ path: '.cursor/rules/plain.md', text: '---\nalwaysApply: true\n---\nRead by Devin.' }], ['cursor', 'devin']);
    expect(find(md, 'cursor', '.cursor/rules/plain.md')!.mode).toBe('ignored');
    expect(find(md, 'devin', '.cursor/rules/plain.md')!.mode).toBe('always');
  });

  it('reads .devin and .windsurf rules, preferring .devin/global_rules.md', () => {
    const u = classify(
      crlf([
        { path: '.devin/rules/a.md', text: '---\ntrigger: always_on\n---\nA.' },
        { path: '.windsurf/rules/b.md', text: '---\ntrigger: model_decision\ndescription: Bee\n---\nB.' },
        { path: '.devin/rules/c.md', text: 'No trigger.' },
        { path: '.devin/global_rules.md', text: 'Devin global.' },
        { path: '.windsurf/global_rules.md', text: 'Windsurf global.' },
      ]),
      ['devin'],
    );
    expect(find(u, 'devin', '.devin/rules/a.md')!.mode).toBe('always');
    expect(find(u, 'devin', '.windsurf/rules/b.md', 'description')!.text).toBe('Bee');
    const c = find(u, 'devin', '.devin/rules/c.md')!;
    expect(c.mode).toBe('manual');
    expect(c.problem).toBeUndefined();
    expect(find(u, 'devin', '.devin/global_rules.md')!.mode).toBe('always');
    expect(find(u, 'devin', '.windsurf/global_rules.md')!.trigger).toBe('.devin/global_rules.md takes precedence');
  });

  it('lists Devin, Windsurf, Claude Code and Copilot skills', () => {
    const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nSteps.`;
    const u = classify(
      [
        { path: '.devin/skills/review/SKILL.md', text: skill('review') },
        { path: '.claude/skills/group/deploy/SKILL.md', text: skill('deploy') },
        { path: '.github/skills/triage/SKILL.md', text: skill('triage') },
        { path: '.claude/commands/ship.md', text: '---\ndescription: Ship it\n---\nShip.' },
      ],
      ['devin'],
    );
    for (const p of ['.devin/skills/review/SKILL.md', '.claude/skills/group/deploy/SKILL.md', '.github/skills/triage/SKILL.md', '.claude/commands/ship.md'])
      expect(find(u, 'devin', p, 'description')!.mode, p).toBe('always');
  });
});

describe('discovery and user files for the new agents', () => {
  it('recognises their instruction files without picking up unrelated docs', () => {
    for (const p of [
      'WARP.md',
      'pkg/WARP.md',
      'AGENTS.local.md',
      'Claude.md',
      'CONTEXT.md',
      'DESIGN.md',
      '.augment-guidelines',
      '.kilocoderules',
      '.kilocoderules-code',
      '.factory/skills/ops/release/SKILL.md',
      '.factory/droids/reviewer.md',
      '.factory/commands/ship.md',
      '.factory/output-styles/terse.md',
      '.trae/rules/a/b/c/d/deep.md',
      '.trae/skills/review/SKILL.md',
      '.augment/rules/style.md',
      'pkg/.augment/rules/style.md',
      '.augment/agents/reviewer.md',
      '.agents/commands/ship.md',
      '.kilo/rules/style.md',
      '.kilocode/rules-code/a.md',
      '.kilo/agent/docs.md',
      '.kilo/commands/submit.md',
      '.devin/global_rules.md',
      '.devin/skills/review/SKILL.md',
      '.github/skills/triage/SKILL.md',
      'pkg/.warp/skills/build/SKILL.md',
    ])
      expect(isInstructionFile(p), p).toBe(true);
    for (const p of ['docs/DESIGN.md', 'docs/CONTEXT.md', 'pkg/.augment-guidelines', 'docs/guide.md']) expect(isInstructionFile(p), p).toBe(false);
  });

  it('classifies documented user-level files for their own agent', () => {
    const units = classifyUser([
      { path: '~/.agents/AGENTS.md', text: 'Warp CLI global rule.' },
      { path: '~/.factory/AGENTS.md', text: 'Factory personal.' },
      { path: '~/.augment/rules/style.md', text: '---\ntype: manual\n---\nUser rules ignore frontmatter.' },
      { path: '~/.config/kilo/AGENTS.md', text: 'Kilo global.' },
      { path: '~/.config/devin/AGENTS.md', text: 'Devin global.' },
      { path: '~/.devin/rules/r.md', text: '---\ntrigger: always_on\n---\nDevin rule.' },
    ]);
    const who = (path: string) => units.filter((u) => u.path === path && u.mode === 'always').map((u) => u.tool);
    // ~/.agents/ is a personal instruction folder for Factory as well.
    expect(who('~/.agents/AGENTS.md')).toEqual(['warp', 'factory-droid']);
    expect(who('~/.factory/AGENTS.md')).toEqual(['factory-droid']);
    expect(who('~/.augment/rules/style.md')).toEqual(['augment']);
    expect(who('~/.config/kilo/AGENTS.md')).toEqual(['kilo-code']);
    expect(who('~/.config/devin/AGENTS.md')).toEqual(['devin']);
    expect(who('~/.devin/rules/r.md')).toEqual(['devin']);
  });
});
