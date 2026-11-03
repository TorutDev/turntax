import { describe, expect, it } from 'vitest';
import { compare, fullReport, issueReport, pageLines, watchedPages } from '../scripts/docs-watch.mjs';
import { TOOLS } from '../src/core/tools.js';

const page = { url: 'https://docs.example/rules', agents: ['Example'] };
const before = (lines, finalUrl = page.url) => ({ [page.url]: { lines, finalUrl } });
const ok = (lines, finalUrl = page.url) => ({ status: 'ok', lines, finalUrl });

describe('pageLines', () => {
  it('keeps the visible text, a line per block, without scripts, navigation or markup', () => {
    const html = `<html><head><title>x</title></head><body>
      <nav><a href="/">Home</a></nav>
      <script>var a = "<p>no</p>";</script><style>p { color: red }</style>
      <!-- <p>hidden</p> -->
      <main><h1>Rules</h1><p>Read <code>AGENTS.md</code> &amp; <em>nested</em>   files&#x27; rules.</p>
      <ul><li>One</li><li>One</li><li>Two</li></ul></main>
      <footer>Copyright</footer></body></html>`;
    expect(pageLines(html)).toEqual(['Rules', "Read AGENTS.md & nested files' rules.", 'One', 'Two']);
  });

  it('reads plain text as lines', () => {
    expect(pageLines('# Title\n\n  a   b \n<not a tag>\n', 'text/plain')).toEqual(['# Title', 'a b', '<not a tag>']);
  });
});

describe('watchedPages', () => {
  it('lists every source and limit source once, with the agents that cite it', () => {
    const tools = [
      { name: 'A', sources: ['https://a'], limits: [{ source: 'https://shared' }] },
      { name: 'B', sources: ['https://shared'], limits: [] },
    ];
    expect(watchedPages(tools)).toEqual([
      { url: 'https://a', agents: ['A'] },
      { url: 'https://shared', agents: ['A', 'B'] },
    ]);
  });

  it('watches the pages of every agent', () => {
    const urls = watchedPages(TOOLS).map((p) => p.url);
    for (const tool of TOOLS) for (const source of tool.sources) expect(urls).toContain(source);
  });
});

describe('compare', () => {
  it('reports nothing when only the order changed', () => {
    const found = compare([page], [ok(['b', 'a'])], before(['a', 'b']));
    expect(found.changes).toEqual([]);
    expect(found.snapshot[page.url].lines).toEqual(['b', 'a']);
  });

  it('reports added and removed lines, and whether they bear on loading', () => {
    const relevant = compare([page], [ok(['a', 'AGENTS.md is now read in every folder'])], before(['a', 'b']));
    expect(relevant.changes[0]).toMatchObject({ added: ['AGENTS.md is now read in every folder'], removed: ['b'], relevant: true });
    const other = compare([page], [ok(['a', 'Join our community'])], before(['a', 'Pricing']));
    expect(other.changes[0]).toMatchObject({ relevant: false });
  });

  it('reports a page that now redirects elsewhere', () => {
    const found = compare([page], [ok(['a'], 'https://docs.example/moved')], before(['a']));
    expect(found.changes[0]).toMatchObject({ movedTo: 'https://docs.example/moved', relevant: true });
  });

  it('records a page seen for the first time without reporting it', () => {
    const found = compare([page], [ok(['a'])], {});
    expect(found.changes).toEqual([]);
    expect(found.firstSeen).toEqual([page]);
    expect(found.snapshot[page.url].lines).toEqual(['a']);
  });

  it('keeps the last text of an unreadable page, so a change made during an outage still shows up', () => {
    const outage = compare([page], [{ status: 'unreadable', detail: 'HTTP 503' }], before(['a']));
    expect(outage.changes).toEqual([]);
    expect(outage.unreadable).toEqual([{ ...page, detail: 'HTTP 503' }]);
    expect(outage.snapshot[page.url].lines).toEqual(['a']);
    const back = compare([page], [ok(['a', 'new rules'])], outage.snapshot);
    expect(back.changes[0]).toMatchObject({ added: ['new rules'] });
  });

  it('reports a page that is gone', () => {
    const found = compare([page], [{ status: 'gone', detail: 'HTTP 404' }], before(['a']));
    expect(found.changes[0]).toMatchObject({ gone: 'HTTP 404', relevant: true });
    expect(found.snapshot[page.url].lines).toEqual(['a']);
  });
});

describe('issueReport', () => {
  const change = (over) => ({ ...page, added: [], removed: [], relevant: true, ...over });

  it('is null when nothing bears on the loading rules', () => {
    expect(issueReport([], '2026-11-03')).toBeNull();
    expect(issueReport([change({ added: ['Join our community'], relevant: false })], '2026-11-03')).toBeNull();
  });

  it('quotes a few changed lines per page, those about loading first', () => {
    const noise = Array.from({ length: 12 }, (_, i) => `Marketing line ${i}`);
    const body = issueReport([change({ added: [...noise, 'AGENTS.md is read in every folder'], removed: ['x'.repeat(200) + ' rules'] })], '2026-11-03');
    expect(body).toContain('13 line(s) added, 1 removed');
    expect(body.indexOf('AGENTS.md is read')).toBeLessThan(body.indexOf('Marketing line 0'));
    expect(body).toContain('...and 4 more');
    expect(body).not.toContain('x'.repeat(170));
    expect(body).not.toContain('Other page');
  });

  it('says when a page is gone or moved, and leaves out pages with other changes', () => {
    const body = issueReport(
      [
        change({ gone: 'HTTP 404' }),
        change({ url: 'https://docs.example/m', movedTo: 'https://docs.example/n' }),
        change({ url: 'https://docs.example/other', added: ['Join our community'], relevant: false }),
      ],
      '2026-11-03',
    );
    expect(body).toContain('The page is gone (HTTP 404)');
    expect(body).toContain('It now redirects to https://docs.example/n');
    expect(body).not.toContain('docs.example/other');
  });

  it('gives counts only when the quotes would pass the size GitHub accepts', () => {
    const big = Array.from({ length: 76 }, (_, n) =>
      change({ url: `https://docs.example/${n}`, added: Array.from({ length: 12 }, (_, i) => `rules line ${i} ${'y'.repeat(150)}`) }),
    );
    const body = issueReport(big, '2026-11-03');
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('12 line(s) added, 0 removed.');
    expect(body).not.toContain('yyy');
  });
});

describe('fullReport', () => {
  const found = {
    changes: [{ ...page, added: Array.from({ length: 15 }, (_, i) => `rules ${i}`), removed: [], relevant: true }],
    unreadable: [{ url: 'https://shell', agents: ['TRAE'], detail: 'only 0 lines of text' }],
    firstSeen: [{ url: 'https://new', agents: ['New'] }],
  };

  it('lists changed, unreadable and new pages, capped for the job summary', () => {
    const text = fullReport(found, 3, '2026-11-03');
    expect(text).toContain('3 pages: 1 changed, 1 unreadable, 1 recorded for the first time.');
    expect(text).toContain('https://shell (only 0 lines of text), cited for TRAE');
    expect(text).toContain('...and 5 more');
    expect(text).not.toContain('rules 14');
  });

  it('has every line for the artifact', () => {
    const text = fullReport(found, 3, '2026-11-03', Infinity);
    expect(text).toContain('rules 14');
    expect(text).not.toContain('more;');
  });
});
