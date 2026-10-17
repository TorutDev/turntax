/** Which repository paths can hold agent instructions. Shared by the CLI and the web page. */
import { configList, findImports, resolvePath } from './markdown.js';
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
  'agents.md',
  'AGENTS.override.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.roorules',
  '.rules',
  'AGENT.md',
  'CONVENTIONS.md',
  '.goosehints',
  '.aider.conf.yml',
  'WARP.md',
  'AGENTS.local.md',
  'Agents.md',
  'Claude.md',
]);

const PATTERNS = [
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /(^|\/)\.claude\/(rules|commands|agents)\/.+\.md$/,
  // Skill folders of every agent; some agents also read skills in category subfolders.
  /(^|\/)\.(agents?|claude|cursor|codex|github|gemini|devin|windsurf|cline|clinerules|roo|kiro|junie|goose|opencode|warp|copilot|factory|trae|augment|kilo|kilocode)\/skills\/(?:[^/]+\/)+SKILL\.md$/,
  /(^|\/)\.(roo|agents)\/skills-[\w-]+\/[^/]+\/SKILL\.md$/,
  /(^|\/)\.cursor\/rules\/.+\.mdc?$/,
  /(^|\/)\.(devin|windsurf)\/rules\/.+\.md$/,
  /^\.(clinerules|cline\/rules)\/.+\.md$/,
  /^\.roo\/rules(-[\w-]+)?\/.+\.(md|txt)$/,
  /^\.roorules-[\w-]+$/,
  /^\.kiro\/steering\/[^/]+\.md$/,
  /^\.junie\/(AGENTS|playbook|guidelines)\.md$/,
  /^\.junie\/(rules|guidelines)\/[^/]+\.md$/,
  /^\.continue\/rules\/[^/]+\.md$/,
  /^(CONTEXT|DESIGN|Design|design)\.md$/,
  /^\.augment-guidelines$/,
  /^\.kilocoderules(-[\w-]+)?$/,
  /^\.(devin|windsurf)\/global_rules\.md$/,
  /^\.factory\/(droids\/[^/]+|commands\/.+)\.md$/,
  /(^|\/)\.factory\/output-styles\/[^/]+\.md$/,
  /(^|\/)\.trae\/rules\/.+\.md$/,
  /^\.trae\/(commands\/.+|agents\/[^/]+)\.md$/,
  /(^|\/)\.augment\/rules\/.+\.md$/,
  /^\.augment\/agents\/[^/]+\.md$/,
  /^\.(augment|agents|cursor)\/commands\/.+\.md$/,
  /^\.(kilo|kilocode)\/rules(-[\w-]+)?\/[^/]+\.md$/,
  /^\.(kilo\/agents?|kilocode\/agents)\/[^/]+\.md$/,
  /^\.kilo\/commands\/.+\.md$/,
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

/** Files a file pulls in: its @imports, or the read: list of .aider.conf.yml. */
function references(f: RepoFile): string[] {
  if (f.path === '.aider.conf.yml') return configList(f, 'read');
  return findImports(f.text)
    .map((t) => resolvePath(f.path, t))
    .filter((p): p is string => p !== null);
}

/** Adds in-repo files reached through @imports or config read lists (up to five levels) to `found`. */
export async function addImports(
  found: Map<string, RepoFile>,
  read: (path: string) => string | null | Promise<string | null>,
): Promise<void> {
  let queue = [...found.values()];
  for (let depth = 0; depth < 5 && queue.length; depth++) {
    const next: RepoFile[] = [];
    for (const f of queue) {
      for (const rel of references(f)) {
        if (found.has(rel)) continue;
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
