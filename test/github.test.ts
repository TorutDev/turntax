import { describe, expect, it, vi } from 'vitest';
import { fetchRepoTree, GitHubError, parseRepoInput, rawReader, rawUrl } from '../src/web/github.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const asFetch = (fn: unknown) => fn as typeof fetch;

describe('parseRepoInput', () => {
  it('accepts owner/name and github.com URLs', () => {
    const repo = { owner: 'vercel', name: 'next.js' };
    for (const input of [
      'vercel/next.js',
      ' vercel/next.js ',
      'github.com/vercel/next.js',
      'https://github.com/vercel/next.js',
      'https://github.com/vercel/next.js/',
      'https://github.com/vercel/next.js.git',
      'http://www.github.com/vercel/next.js',
    ])
      expect(parseRepoInput(input), input).toEqual(repo);
  });

  it('takes everything after /tree/ as the ref', () => {
    expect(parseRepoInput('https://github.com/a/b/tree/main')).toEqual({ owner: 'a', name: 'b', ref: 'main' });
    expect(parseRepoInput('github.com/a/b/tree/feature/x/')).toEqual({ owner: 'a', name: 'b', ref: 'feature/x' });
    expect(parseRepoInput('a/b.git/tree/v1.2.0')).toEqual({ owner: 'a', name: 'b', ref: 'v1.2.0' });
  });

  it('rejects anything else', () => {
    for (const input of ['', 'foo', 'https://gitlab.com/a/b', 'gitlab.com/a/b', 'a/b/c', 'a/b/blob/main/x', 'a/', '/b', 'a/..', 'a b/c', 'https://github.com/a/b?tab=x', 'a/b/tree/../../evil/x', 'a/b/tree/main/./x'])
      expect(parseRepoInput(input), input).toBeNull();
  });
});

describe('fetchRepoTree', () => {
  it('looks up the default branch, then lists blobs without credentials', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/repos/o/r')
        ? jsonResponse({ default_branch: 'trunk' })
        : jsonResponse({
            truncated: false,
            tree: [
              { path: 'AGENTS.md', type: 'blob' },
              { path: 'docs', type: 'tree' },
              { path: 'docs/a.md', type: 'blob' },
              { path: 'CLAUDE.md', type: 'blob', mode: '120000' },
            ],
          }),
    );
    const tree = await fetchRepoTree({ owner: 'o', name: 'r' }, asFetch(fetchFn));
    expect(tree).toEqual({ owner: 'o', name: 'r', ref: 'trunk', paths: ['AGENTS.md', 'docs/a.md', 'CLAUDE.md'], links: ['CLAUDE.md'], truncated: false });
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'https://api.github.com/repos/o/r',
      'https://api.github.com/repos/o/r/git/trees/trunk?recursive=1',
    ]);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github+json');
  });

  it('uses an explicit ref directly and reports truncation', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ truncated: true, tree: [] }));
    const tree = await fetchRepoTree({ owner: 'o', name: 'r', ref: 'feature/a b' }, asFetch(fetchFn));
    expect(tree.truncated).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('https://api.github.com/repos/o/r/git/trees/feature/a%20b?recursive=1');
  });

  it('treats the part after the ref in a /tree/ URL as a folder when the full ref is missing', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('/git/trees/main?') ? jsonResponse({ truncated: false, tree: [{ path: 'AGENTS.md', type: 'blob' }] }) : jsonResponse({ message: 'Not Found' }, 404),
    );
    const tree = await fetchRepoTree(parseRepoInput('https://github.com/o/r/tree/main/packages/api/src')!, asFetch(fetchFn));
    expect(tree).toMatchObject({ ref: 'main', subdir: 'packages/api/src', paths: ['AGENTS.md'] });
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'https://api.github.com/repos/o/r/git/trees/main/packages/api/src?recursive=1',
      'https://api.github.com/repos/o/r/git/trees/main?recursive=1',
    ]);
  });

  it('keeps a branch name with a slash when it resolves', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ truncated: false, tree: [] }));
    const tree = await fetchRepoTree({ owner: 'o', name: 'r', ref: 'feature/x' }, asFetch(fetchFn));
    expect(tree.ref).toBe('feature/x');
    expect(tree).not.toHaveProperty('subdir');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after three tree requests and names the ref as given', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404));
    await expect(fetchRepoTree({ owner: 'o', name: 'r', ref: 'main/a/b/c' }, asFetch(fetchFn))).rejects.toThrow(
      'Branch, tag or commit "main/a/b/c" not found in o/r, or the repository is private.',
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors or the default branch', async () => {
    const limited = vi.fn(async () => jsonResponse({}, 403, { 'x-ratelimit-remaining': '0' }));
    await expect(fetchRepoTree({ owner: 'o', name: 'r', ref: 'main/docs' }, asFetch(limited))).rejects.toThrow(/60 per hour/);
    expect(limited).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async (url: string) => (url.endsWith('/repos/o/r') ? jsonResponse({ default_branch: 'release/1' }) : jsonResponse({}, 404)));
    await expect(fetchRepoTree({ owner: 'o', name: 'r' }, asFetch(missing))).rejects.toThrow(GitHubError);
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('explains a missing or private repository', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404));
    const err = await fetchRepoTree({ owner: 'o', name: 'r' }, asFetch(fetchFn)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).toBe('Repository o/r not found, or it is private.');
  });

  it('explains the unauthenticated rate limit with the reset time', async () => {
    const reset = new Date(2026, 9, 13, 7, 5);
    const fetchFn = vi.fn(async () =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset.getTime() / 1000),
      }),
    );
    await expect(fetchRepoTree({ owner: 'o', name: 'r' }, asFetch(fetchFn))).rejects.toThrow(/60 per hour.*after 07:05\./);
  });

  it('turns network failures into a generic message', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchRepoTree({ owner: 'o', name: 'r' }, asFetch(fetchFn))).rejects.toThrow(/Could not reach GitHub/);
  });
});

describe('rawReader', () => {
  const repo = { owner: 'o', name: 'r', ref: 'release/1.0' };

  it('encodes each path segment but keeps slashes', () => {
    expect(rawUrl(repo, 'docs/my notes/#1.md')).toBe('https://raw.githubusercontent.com/o/r/release/1.0/docs/my%20notes/%231.md');
  });

  it('returns text, or null on a non-OK response', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('AGENTS.md') ? new Response('hello') : new Response('', { status: 404 })));
    const read = rawReader(repo, asFetch(fetchFn));
    expect(await read('AGENTS.md')).toBe('hello');
    expect(await read('missing.md')).toBeNull();
    expect(read.failed).toEqual(['missing.md']);
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('omit');
  });

  it('stops fetching after the cap and records what was not read', async () => {
    const fetchFn = vi.fn(async () => new Response('x'));
    const read = rawReader(repo, asFetch(fetchFn), 2);
    expect(await Promise.all([read('a'), read('b'), read('c')])).toEqual(['x', 'x', null]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(read.failed).toEqual(['c']);
  });

  it('reads the target of a symlink in the repository', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(url.endsWith('/docs/CLAUDE.md') ? '../AGENTS.md' : 'shared rules'));
    const read = rawReader({ ...repo, links: ['docs/CLAUDE.md'] }, asFetch(fetchFn));
    expect(await read('docs/CLAUDE.md')).toBe('shared rules');
    expect((fetchFn.mock.calls[1] as unknown as [string])[0]).toBe('https://raw.githubusercontent.com/o/r/release/1.0/AGENTS.md');
    expect(read.targets).toEqual(new Map([['docs/CLAUDE.md', 'AGENTS.md']]));
  });

  it('does not count a link to another link as text', async () => {
    const fetchFn = vi.fn(async () => new Response('AGENTS.md'));
    const read = rawReader({ ...repo, links: ['CLAUDE.md', 'AGENTS.md'] }, asFetch(fetchFn));
    expect(await read('CLAUDE.md')).toBeNull();
    expect(read.failed).toEqual(['CLAUDE.md']);
  });
});
