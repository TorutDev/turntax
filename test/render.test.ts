import { describe, expect, it } from 'vitest';
import { audit, type Report } from '../src/core/audit.js';
import { planFixes, unifiedDiff, type FixPlan } from '../src/core/fix.js';
import { noMentions, renderAnnotations, renderPrComment } from '../src/core/render.js';
import { existsIn } from '../src/node/discover.js';
import { fixture, loadFixture } from './helpers.js';

const mixed = await loadFixture('mixed');
const report = await audit(mixed, { models: [], advice: { exists: existsIn(fixture('mixed')) } });
const plan = planFixes(mixed, { exists: existsIn(fixture('mixed')) });

describe('renderPrComment with fixes', () => {
  it('adds the safe fixes and their diff before the full report', () => {
    const comment = renderPrComment(report, plan);
    expect(comment).toMatch(/\n\*\*2 safe fixes available\*\* \(saves ~\d+ o200k tokens\/turn\): run `npx turntax --fix` to preview\.\n/);
    expect(comment).toContain(`- ${plan.fixes[0]!.message}\n`);
    expect(comment).toContain('```diff\n' + unifiedDiff(plan.changes));
    expect(comment.indexOf('safe fixes')).toBeLessThan(comment.indexOf('<details><summary>Full report</summary>'));
    expect(renderPrComment(report, plan, 'npx turntax packages/web --fix')).toContain('run `npx turntax packages/web --fix` to preview');
  });

  it('breaks mentions in prose but not in code', () => {
    expect(noMentions('Ask @octo-team about `@docs/x.md`\n```\n@keep\n```\nthen @me.')).toBe(
      'Ask @&#8203;octo-team about `@docs/x.md`\n```\n@keep\n```\nthen @&#8203;me.',
    );
  });

  it('keeps @names in fix messages from mentioning people', () => {
    const named: FixPlan = { ...plan, fixes: [{ ...plan.fixes[0]!, message: 'Moved section "Ask @octo-team" from CLAUDE.md; @-mentioned rules stay.' }] };
    expect(renderPrComment(report, named)).toContain('- Moved section "Ask @&#8203;octo-team" from CLAUDE.md; @-mentioned rules stay.\n');
  });

  it('leaves the comment unchanged without changes to make', () => {
    expect(renderPrComment(report)).not.toContain('safe fix');
    expect(renderPrComment(report, { fixes: [], skipped: [], changes: [] })).toBe(renderPrComment(report));
  });

  it('cuts a long diff at a line and fences code blocks in it', () => {
    const after = '```bash\nnpm test\n```\n' + 'Keep every handler small and covered by an integration test.\n'.repeat(2000);
    const big: FixPlan = {
      fixes: [{ kind: 'duplicate', paths: ['AGENTS.md'], message: 'Removed lines.', savingTokens: 1 }],
      skipped: [],
      changes: [{ path: 'AGENTS.md', before: 'x\n', after }],
    };
    const comment = renderPrComment(report, big);
    expect(comment).toContain('**1 safe fix available** (saves ~1 o200k tokens/turn)');
    expect(comment).toContain('\n````diff\n');
    expect(comment).toMatch(/\+Keep every handler small and covered by an integration test\.\n````\n\n_Diff cut to fit in a comment; run `npx turntax --fix` for all of it\._/);
    expect(comment.length).toBeLessThan(65_536);
  });
});

describe('renderAnnotations', () => {
  it('prints one workflow command per advice item on a repository file', () => {
    const out = renderAnnotations(report);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(report.advice.length);
    expect(lines).toContain(
      `::warning file=CLAUDE.md,line=12,title=turntax scopable-section::${report.advice.find((a) => a.kind === 'scopable-section')!.message} (saves ~128 tokens/turn)`,
    );
    expect(lines).toContain('::warning file=.cursor/rules/wrong.md,title=turntax misconfigured::Cursor ignores plain .md files in .cursor/rules; rename to .mdc.');
    expect(renderAnnotations(report, 'packages/web/')).toContain('::warning file=packages/web/CLAUDE.md,line=12,');
  });

  it('escapes data and properties, uses notices for low severity and skips user-level files', () => {
    const custom: Report = {
      ...report,
      advice: [
        { kind: 'stale-reference', severity: 'low', tools: [], paths: ['docs/a,b:c.md'], line: 3, message: '100% gone\r\nnext', savingTokens: 1234 },
        { kind: 'duplicate', severity: 'high', tools: [], paths: ['~/.claude/CLAUDE.md', 'AGENTS.md'], line: 2, message: 'Twice.', savingTokens: 0 },
        { kind: 'non-english', severity: 'low', tools: [], paths: ['~/.codex/AGENTS.md'], message: 'User level.', savingTokens: null },
      ],
    };
    expect(renderAnnotations(custom)).toBe(
      '::notice file=docs/a%2Cb%3Ac.md,line=3,title=turntax stale-reference::100%25 gone%0D%0Anext (saves ~1,234 tokens/turn)\n' +
        '::warning file=AGENTS.md,title=turntax duplicate::Twice.\n',
    );
  });
});
