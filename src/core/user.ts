/**
 * User-level instruction files: the ones in the home directory that an agent adds to every project.
 * Each is classified by the same rules as its project counterpart, through a virtual path
 * (for example ~/.codex/AGENTS.md is read like a root AGENTS.md, but only by Codex).
 */
import { classify } from './classify.js';
import type { LoadedUnit, RepoFile, ToolId } from './types.js';

export interface UserFileRule {
  tool: ToolId;
  /** Matches the home-relative path. */
  pattern: RegExp;
  /** Project path the file is classified as. */
  as: (homePath: string) => string;
  source: string;
}

const same = (p: string) => p;

export const USER_FILES: UserFileRule[] = [
  { tool: 'claude-code', pattern: /^\.claude\/CLAUDE\.md$/, as: same, source: 'https://code.claude.com/docs/en/memory' },
  { tool: 'claude-code', pattern: /^\.claude\/rules\/.+\.md$/, as: same, source: 'https://code.claude.com/docs/en/memory' },
  { tool: 'claude-code', pattern: /^\.claude\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://code.claude.com/docs/en/skills' },
  { tool: 'claude-code', pattern: /^\.claude\/commands\/.+\.md$/, as: same, source: 'https://code.claude.com/docs/en/skills' },
  { tool: 'claude-code', pattern: /^\.claude\/agents\/[^/]+\.md$/, as: same, source: 'https://code.claude.com/docs/en/sub-agents' },
  { tool: 'codex', pattern: /^\.codex\/AGENTS(\.override)?\.md$/, as: (p) => p.slice('.codex/'.length), source: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md' },
  { tool: 'codex', pattern: /^\.agents\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://learn.chatgpt.com/docs/build-skills' },
  { tool: 'gemini-cli', pattern: /^\.gemini\/GEMINI\.md$/, as: () => 'GEMINI.md', source: 'https://geminicli.com/docs/cli/gemini-md/' },
  { tool: 'windsurf', pattern: /^\.codeium\/windsurf\/memories\/global_rules\.md$/, as: () => '.windsurfrules', source: 'https://docs.devin.ai/desktop/cascade/memories' },
  { tool: 'cline', pattern: /^(Documents\/Cline\/Rules|Cline\/Rules|\.cline\/rules)\/.+\.md$/, as: (p) => '.clinerules/' + p.replace(/^(Documents\/Cline\/Rules|Cline\/Rules|\.cline\/rules)\//, ''), source: 'https://docs.cline.bot/features/cline-rules' },
  { tool: 'roo-code', pattern: /^\.roo\/rules(-[\w-]+)?\/.+\.(md|txt)$/, as: same, source: 'https://roocodeinc.github.io/Roo-Code/features/custom-instructions' },
  { tool: 'kiro', pattern: /^\.kiro\/steering\/[^/]+\.md$/, as: same, source: 'https://kiro.dev/docs/steering/' },
  { tool: 'goose', pattern: /^\.config\/goose\/\.goosehints$/, as: () => '.goosehints', source: 'https://goose-docs.ai/docs/guides/context-engineering/using-goosehints' },
  { tool: 'amp', pattern: /^\.config\/(amp\/)?AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://ampcode.com/docs/customize/agents-md' },
  { tool: 'opencode', pattern: /^\.config\/opencode\/AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://opencode.ai/docs/rules/' },
  // OpenCode falls back to ~/.claude/CLAUDE.md when ~/.config/opencode/AGENTS.md is missing.
  { tool: 'opencode', pattern: /^\.claude\/CLAUDE\.md$/, as: () => 'CLAUDE.md', source: 'https://opencode.ai/docs/rules/' },
];

/** Home-relative folders to search, and how deep. Kept narrow so nothing else in the home directory is read. */
export const USER_ROOTS: Array<{ dir: string; depth: number }> = [
  { dir: '.claude', depth: 4 },
  { dir: '.codex', depth: 0 },
  { dir: '.agents/skills', depth: 1 },
  { dir: '.gemini', depth: 0 },
  { dir: '.codeium/windsurf/memories', depth: 0 },
  { dir: 'Documents/Cline/Rules', depth: 3 },
  { dir: 'Cline/Rules', depth: 3 },
  { dir: '.cline/rules', depth: 3 },
  { dir: '.roo', depth: 3 },
  { dir: '.kiro/steering', depth: 0 },
  { dir: '.config/goose', depth: 0 },
  { dir: '.config', depth: 0 },
  { dir: '.config/amp', depth: 0 },
  { dir: '.config/opencode', depth: 0 },
];

export function isUserInstructionFile(homePath: string): boolean {
  return USER_FILES.some((r) => r.pattern.test(homePath));
}

/**
 * Classifies user-level files (paths given as `~/...`). Each tool sees only its own files,
 * so ~/.codex/AGENTS.md never counts for Claude Code.
 */
export function classifyUser(files: RepoFile[], toolIds?: ToolId[]): LoadedUnit[] {
  const units: LoadedUnit[] = [];
  const tools = [...new Set(USER_FILES.map((r) => r.tool))].filter((t) => !toolIds || toolIds.includes(t));
  for (const tool of tools) {
    // Files that map to the same place are all read (Amp loads both ~/.config/amp/AGENTS.md and
    // ~/.config/AGENTS.md), so each collision is classified in a batch of its own.
    const batches: Array<{ virtual: Map<string, string>; files: RepoFile[] }> = [];
    for (const f of files) {
      const home = f.path.replace(/^~\//, '');
      const rule = USER_FILES.find((r) => r.tool === tool && r.pattern.test(home));
      if (!rule) continue;
      const as = rule.as(home);
      let batch = batches.find((b) => !b.virtual.has(as));
      if (!batch) batches.push((batch = { virtual: new Map(), files: [] }));
      batch.virtual.set(as, f.path);
      batch.files.push({ path: as, text: f.text });
    }
    for (const batch of batches) {
      for (const u of classify(batch.files, [tool])) {
        const real = batch.virtual.get(u.path);
        if (!real) continue; // an @import resolved inside the virtual tree; user-level imports are not followed
        units.push({ ...u, path: real, trigger: `user level, ${u.trigger}`, scope: 'user' });
      }
    }
  }
  return units;
}
