/** Which repository paths can hold agent instructions. Shared by the CLI and the web page. */
import { findImports, resolvePath } from './markdown.js';
import type { RepoFile } from './types.js';

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'vendor',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.worktrees',
  '.turbo',
  '.cache',
]);

const NAMES = new Set([
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
]);

const PATTERNS = [
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /(^|\/)\.claude\/(rules|commands)\/.+\.md$/,
  /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/,
  /(^|\/)\.claude\/agents\/[^/]+\.md$/,
  /(^|\/)\.agents\/skills\/[^/]+\/SKILL\.md$/,
  /(^|\/)\.cursor\/rules\/.+\.mdc?$/,
  /(^|\/)\.(devin|windsurf)\/rules\/.+\.md$/,
];

export const MAX_DEPTH = 12;

export function isInstructionFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return NAMES.has(name) || PATTERNS.some((p) => p.test(path));
}

/** Directories never searched: dependencies, build output, VCS data and agent worktrees. */
export function isSkippedDir(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return SKIP_DIRS.has(name) || path === '.claude/worktrees' || path.endsWith('/.claude/worktrees');
}

/** Adds in-repo files reached through @imports (up to five levels) to `found`. */
export async function addImports(
  found: Map<string, RepoFile>,
  read: (path: string) => string | null | Promise<string | null>,
): Promise<void> {
  let queue = [...found.values()];
  for (let depth = 0; depth < 5 && queue.length; depth++) {
    const next: RepoFile[] = [];
    for (const f of queue) {
      for (const target of findImports(f.text)) {
        const rel = resolvePath(f.path, target);
        if (rel === null || found.has(rel)) continue;
        const text = await read(rel);
        if (text === null) continue;
        const file = { path: rel, text };
        found.set(rel, file);
        next.push(file);
      }
    }
    queue = next;
  }
}
