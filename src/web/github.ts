import { resolvePath } from '../core/markdown.js';

/**
 * Public GitHub repository loading for the web page. Unauthenticated, no cookies;
 * talks only to api.github.com and raw.githubusercontent.com.
 */

export interface RepoInput {
  owner: string;
  name: string;
  /** Branch, tag or commit; absent means the default branch. */
  ref?: string;
}

export interface RepoTree {
  owner: string;
  name: string;
  ref: string;
  /** Repo-relative paths of every blob. */
  paths: string[];
  /** Paths that are symlinks; raw.githubusercontent.com serves their target path, not the target's content. */
  links: string[];
  /** GitHub cut the listing short; very large repos may be incomplete. */
  truncated: boolean;
  /** The folder after the ref in a /tree/ URL (tree/main/packages/api); the whole repository is listed. */
  subdir?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const REPO_RE = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([^\s?#]+?))?\/?$/i;

export function parseRepoInput(input: string): RepoInput | null {
  const m = REPO_RE.exec(input.trim());
  if (!m) return null;
  const [, owner, name, ref] = m;
  if (!owner || !name || name === '.' || name === '..') return null;
  if (ref?.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return ref ? { owner, name, ref } : { owner, name };
}

/** Encodes each segment but keeps the slashes. */
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

const pad = (n: number) => String(n).padStart(2, '0');

async function api(url: string, fetchFn: typeof fetch, notFound: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit' });
  } catch {
    throw new GitHubError('Could not reach GitHub. Check your connection and try again.');
  }
  if (res.ok) return res.json();
  if (res.status === 404) throw new GitHubError(notFound, 404);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const at = reset ? new Date(reset * 1000) : null;
    throw new GitHubError(
      `GitHub's limit for unauthenticated requests (60 per hour) is reached${at ? `; try again after ${pad(at.getHours())}:${pad(at.getMinutes())}` : ''}.`,
    );
  }
  if (res.status === 409) throw new GitHubError('This repository is empty.');
  throw new GitHubError(`GitHub request failed: HTTP ${res.status}.`);
}

export async function fetchRepoTree(repo: RepoInput, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<RepoTree> {
  const { owner, name } = repo;
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const missingRepo = `Repository ${owner}/${name} not found, or it is private.`;
  let ref = repo.ref;
  if (!ref) {
    const info = (await api(base, fetchFn, missingRepo)) as { default_branch?: string };
    if (!info.default_branch) throw new GitHubError(`Could not find the default branch of ${owner}/${name}.`);
    ref = info.default_branch;
  }
  const notFound = repo.ref ? `Branch, tag or commit "${ref}" not found in ${owner}/${name}, or the repository is private.` : missingRepo;
  // A /tree/ URL may name a folder after the ref (tree/main/packages/api). On 404, try the first segment,
  // then the first two (branches like feature/x): at most three tree requests, as the unauthenticated
  // limit is 60 per hour.
  const segments = ref.split('/');
  const candidates = repo.ref ? [...new Set([ref, segments[0]!, segments.slice(0, 2).join('/')])] : [ref];
  for (let i = 0; ; i++) {
    const candidate = candidates[i]!;
    let tree: { tree?: Array<{ path: string; type: string; mode?: string }>; truncated?: boolean };
    try {
      tree = (await api(`${base}/git/trees/${encodePath(candidate)}?recursive=1`, fetchFn, notFound)) as typeof tree;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404 && i + 1 < candidates.length) continue;
      throw e;
    }
    const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob');
    const links = blobs.filter((e) => e.mode === '120000').map((e) => e.path);
    const subdir = ref.slice(candidate.length + 1);
    const paths = blobs.map((e) => e.path);
    return { owner, name, ref: candidate, paths, links, truncated: tree.truncated === true, ...(subdir ? { subdir } : {}) };
  }
}

export function rawUrl(repo: { owner: string; name: string; ref: string }, path: string): string {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodePath(repo.ref)}/${encodePath(path)}`;
}

export type RawReader = ((path: string) => Promise<string | null>) & {
  /** Paths that could not be downloaded, including those past the fetch limit. */
  failed: string[];
  /** The in-repo path each symlink read so far points to, by link path. */
  targets: Map<string, string>;
};

/** Reads files over raw.githubusercontent.com, following in-repo symlinks once; null on any failure or past `limit` fetches. */
export function rawReader(
  repo: { owner: string; name: string; ref: string; links?: string[] },
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  limit = 200,
): RawReader {
  let fetches = 0;
  const get = async (path: string): Promise<string | null> => {
    if (fetches >= limit) return null;
    fetches++;
    try {
      const res = await fetchFn(rawUrl(repo, path), { credentials: 'omit' });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const read = Object.assign(
    async (path: string): Promise<string | null> => {
      let text = await get(path);
      if (text !== null && repo.links?.includes(path)) {
        const target = /^[^\n]{1,512}$/.test(text.trim()) ? resolvePath(path, text.trim()) : null;
        if (target) read.targets.set(path, target);
        // Followed once: a link to another link would otherwise be counted as its path text.
        text = target && !repo.links.includes(target) ? await get(target) : null;
      }
      if (text === null) read.failed.push(path);
      return text;
    },
    { failed: [] as string[], targets: new Map<string, string>() },
  );
  return read;
}
