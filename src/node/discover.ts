import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_DEPTH, addImports, isInstructionFile, isSkippedDir } from '../core/files.js';
import { MCP_CONFIGS, USER_MCP_PATHS } from '../core/mcp.js';
import type { RepoFile } from '../core/types.js';
import { USER_ROOTS, isUserInstructionFile } from '../core/user.js';

const MAX_BYTES = 2 * 1024 * 1024;

function readText(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_BYTES) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Finds agent instruction files under `root`, plus any in-repo files they @import. Read-only. */
export async function discover(root: string): Promise<RepoFile[]> {
  const found = new Map<string, RepoFile>();
  // Every file walked, for glob mentions such as @docs/*.md.
  const all: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isSkippedDir(path)) continue;
        walk(path, depth + 1);
      } else if (e.isFile() || e.isSymbolicLink()) {
        all.push(path);
        if (!isInstructionFile(path)) continue;
        const text = readText(join(root, path));
        if (text !== null) found.set(path, { path, text });
      }
    }
  };
  walk('', 0);

  // Pull in @imported files (for example a CLAUDE.md that contains @docs/agents.md).
  await addImports(
    found,
    (rel) => {
      const abs = join(root, rel);
      return existsSync(abs) && !lstatSync(abs).isDirectory() ? readText(abs) : null;
    },
    all,
  );
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function existsIn(root: string): (path: string) => boolean {
  return (path) => existsSync(join(root, path));
}

export function packageScripts(root: string): Set<string> | undefined {
  const text = readText(join(root, 'package.json'));
  if (text === null) return undefined;
  try {
    return new Set(Object.keys(JSON.parse(text).scripts ?? {}));
  } catch {
    return undefined;
  }
}

/** Project MCP config files (for example .mcp.json, .cursor/mcp.json). Read-only. */
export function discoverMcpConfigs(root: string): RepoFile[] {
  const paths = [...new Set(MCP_CONFIGS.filter((c) => c.scope === 'project').map((c) => c.path))];
  return paths.flatMap((path) => {
    const text = readText(join(root, path));
    return text === null ? [] : [{ path, text }];
  });
}

/**
 * User-level instruction files and MCP configs in the home directory, with `~/` paths.
 * Only the folders listed in USER_ROOTS are searched. Read-only.
 */
export function discoverUser(home: string): { files: RepoFile[]; mcpConfigs: RepoFile[] } {
  const files = new Map<string, RepoFile>();
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(join(home, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth > 0 && !isSkippedDir(path)) walk(path, depth - 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && isUserInstructionFile(path)) {
        const text = readText(join(home, path));
        if (text !== null) files.set(path, { path: `~/${path}`, text });
      }
    }
  };
  for (const r of USER_ROOTS) walk(r.dir, r.depth);
  const mcpConfigs = USER_MCP_PATHS.flatMap((path) => {
    const text = readText(join(home, path));
    return text === null ? [] : [{ path: `~/${path}`, text }];
  });
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), mcpConfigs };
}

/** The real location of `p`, following symlinks in the part of the path that exists; null behind a dangling symlink. */
export function realLocation(p: string): string | null {
  if (lstatSync(p, { throwIfNoEntry: false })) {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }
  const parent = dirname(p);
  if (parent === p) return p;
  const real = realLocation(parent);
  return real === null ? null : resolve(real, relative(parent, p));
}

/**
 * A check for paths that must not be changed: paths that are symlinks or lie under a symlinked folder
 * (existing or not), and repository files that such a link points to.
 */
export function linkedPaths(root: string, files: RepoFile[]): (path: string) => boolean {
  const realRoot = realpathSync(root);
  const linked = (path: string) => realLocation(join(root, path)) !== join(realRoot, path);
  const targets = new Set<string>();
  for (const f of files) {
    if (!linked(f.path)) continue;
    const rel = relative(realRoot, realLocation(join(root, f.path)) ?? realRoot);
    if (!rel.startsWith('..') && !isAbsolute(rel)) targets.add(rel.split(sep).join('/'));
  }
  return (path) => targets.has(path) || linked(path);
}
