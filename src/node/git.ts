import { execFileSync } from 'node:child_process';
import { addImports, isInstructionFile, isSkippedDir } from '../core/files.js';
import { isMcpConfigFile } from '../core/mcp.js';
import type { RepoFile } from '../core/types.js';

/**
 * Reads the instruction files and project MCP configs of `root` as they were at a git ref,
 * without touching the working tree. Paths are relative to `root`, like discover().
 */
export async function filesAtRef(root: string, ref: string): Promise<{ files: RepoFile[]; mcpConfigs: RepoFile[]; paths: Set<string> }> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    throw new Error(`git ref "${ref}" was not found in ${root}`);
  }
  // ls-tree prints paths relative to the current directory, so a subfolder of a repository works too.
  const paths = git('ls-tree', '-r', '--name-only', '-z', ref, '--', '.').split('\0').filter(Boolean);
  const kept = paths.filter((p) => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) if (isSkippedDir(parts.slice(0, i).join('/'))) return false;
    return true;
  });
  const read = (p: string): string | null => {
    try {
      return git('show', `${ref}:./${p}`);
    } catch {
      return null;
    }
  };
  const found = new Map<string, RepoFile>();
  for (const p of kept.filter(isInstructionFile)) {
    const text = read(p);
    if (text !== null) found.set(p, { path: p, text });
  }
  const all = new Set(kept);
  await addImports(found, (p) => (all.has(p) ? read(p) : null), all);
  const mcpConfigs = kept.filter(isMcpConfigFile).flatMap((p) => {
    const text = read(p);
    return text === null ? [] : [{ path: p, text }];
  });
  return { files: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)), mcpConfigs, paths: all };
}
