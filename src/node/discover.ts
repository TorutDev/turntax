import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DEPTH, addImports, isInstructionFile, isSkippedDir } from '../core/files.js';
import type { RepoFile } from '../core/types.js';

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
      } else if ((e.isFile() || e.isSymbolicLink()) && isInstructionFile(path)) {
        const text = readText(join(root, path));
        if (text !== null) found.set(path, { path, text });
      }
    }
  };
  walk('', 0);

  // Pull in @imported files (for example a CLAUDE.md that contains @docs/agents.md).
  await addImports(found, (rel) => {
    const abs = join(root, rel);
    return existsSync(abs) && !lstatSync(abs).isDirectory() ? readText(abs) : null;
  });
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
