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
/** Moves a home folder onto the project folder the tool reads, e.g. ~/.copilot/skills/x -> .github/skills/x. */
const moved = (from: string, to: string) => (p: string) => to + p.slice(from.length);

/** `<dir>/skills/<name>/SKILL.md`, optionally with category folders (`folders`, as in tools.ts). */
const skills = (dirs: string, folders = '[^/]+/') => new RegExp(`^(?:${dirs.replace(/\./g, '\\.')})/skills/${folders}SKILL\\.md$`);
const RECURSIVE = '(?:[^/]+/)+';

const CLAUDE_MEMORY = 'https://code.claude.com/docs/en/memory';
const CLAUDE_SKILLS = 'https://code.claude.com/docs/en/skills';
const CODEX_SKILLS = 'https://learn.chatgpt.com/docs/build-skills';
const GEMINI_SKILLS = 'https://geminicli.com/docs/cli/skills/';
const CURSOR_SKILLS = 'https://cursor.com/docs/skills';
const VSCODE_INSTRUCTIONS = 'https://code.visualstudio.com/docs/agent-customization/custom-instructions';
const VSCODE_SKILLS = 'https://code.visualstudio.com/docs/agent-customization/agent-skills';
const WINDSURF_SKILLS = 'https://docs.devin.ai/desktop/cascade/skills';
const CLINE_RULES = 'https://docs.cline.bot/customization/cline-rules';
const ROO_SKILLS = 'https://roocodeinc.github.io/Roo-Code/features/skills';
const JUNIE_SKILLS = 'https://junie.jetbrains.com/docs/agent-skills.html';
const GOOSE_SKILLS = 'https://goose-docs.ai/docs/guides/context-engineering/using-skills';
const AMP_SKILLS = 'https://ampcode.com/docs/customize/skills';
const OPENCODE_SKILLS = 'https://opencode.ai/docs/skills/';
const AMP_FOLDERS = '(?:[^/]+/){1,5}';

export const USER_FILES: UserFileRule[] = [
  { tool: 'claude-code', pattern: /^\.claude\/CLAUDE\.md$/, as: same, source: CLAUDE_MEMORY },
  { tool: 'claude-code', pattern: /^\.claude\/rules\/.+\.md$/, as: same, source: CLAUDE_MEMORY },
  { tool: 'claude-code', pattern: skills('.claude'), as: same, source: CLAUDE_SKILLS },
  { tool: 'claude-code', pattern: /^\.claude\/commands\/.+\.md$/, as: same, source: CLAUDE_SKILLS },
  { tool: 'claude-code', pattern: /^\.claude\/agents\/.+\.md$/, as: same, source: 'https://code.claude.com/docs/en/sub-agents' },
  { tool: 'codex', pattern: /^\.codex\/AGENTS(\.override)?\.md$/, as: (p) => p.slice('.codex/'.length), source: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md' },
  { tool: 'codex', pattern: skills('.agents'), as: same, source: CODEX_SKILLS },
  { tool: 'gemini-cli', pattern: /^\.gemini\/GEMINI\.md$/, as: () => 'GEMINI.md', source: 'https://geminicli.com/docs/cli/gemini-md/' },
  { tool: 'gemini-cli', pattern: skills('.agents|.gemini'), as: same, source: GEMINI_SKILLS },
  { tool: 'cursor', pattern: skills('.agents|.cursor|.claude|.codex', RECURSIVE), as: same, source: CURSOR_SKILLS },
  // VS Code: personal Copilot instructions and skills, plus the Claude files it reads by default.
  { tool: 'copilot', pattern: /^\.copilot\/copilot-instructions\.md$/, as: () => '.github/copilot-instructions.md', source: VSCODE_INSTRUCTIONS },
  { tool: 'copilot', pattern: /^\.copilot\/instructions\/.+\.instructions\.md$/, as: moved('.copilot/instructions/', '.github/instructions/'), source: VSCODE_INSTRUCTIONS },
  { tool: 'copilot', pattern: skills('.copilot'), as: moved('.copilot/skills/', '.github/skills/'), source: VSCODE_SKILLS },
  { tool: 'copilot', pattern: skills('.agents|.claude'), as: same, source: VSCODE_SKILLS },
  { tool: 'copilot', pattern: /^\.claude\/CLAUDE\.md$/, as: same, source: VSCODE_INSTRUCTIONS },
  { tool: 'copilot', pattern: /^\.claude\/rules\/.+\.md$/, as: same, source: 'https://code.visualstudio.com/docs/agents/reference/ai-settings' },
  // Read through its own rule (6,000-character limit), not as .windsurfrules.
  { tool: 'windsurf', pattern: /^\.codeium\/windsurf\/memories\/global_rules\.md$/, as: same, source: 'https://docs.devin.ai/desktop/cascade/memories' },
  { tool: 'windsurf', pattern: skills('.codeium/windsurf'), as: moved('.codeium/windsurf/skills/', '.windsurf/skills/'), source: WINDSURF_SKILLS },
  { tool: 'windsurf', pattern: skills('.config/devin'), as: moved('.config/devin/skills/', '.devin/skills/'), source: WINDSURF_SKILLS },
  { tool: 'windsurf', pattern: skills('.agents'), as: same, source: WINDSURF_SKILLS },
  { tool: 'cline', pattern: /^(Documents\/Cline\/Rules|Cline\/Rules|\.cline\/rules)\/.+\.md$/, as: (p) => '.clinerules/' + p.replace(/^(Documents\/Cline\/Rules|Cline\/Rules|\.cline\/rules)\//, ''), source: CLINE_RULES },
  { tool: 'cline', pattern: skills('.cline'), as: same, source: 'https://docs.cline.bot/customization/skills' },
  { tool: 'roo-code', pattern: /^\.roo\/rules(-[\w-]+)?\/.+\.(md|txt)$/, as: same, source: 'https://roocodeinc.github.io/Roo-Code/features/custom-instructions' },
  { tool: 'roo-code', pattern: /^\.(roo|agents)\/skills(-[\w-]+)?\/[^/]+\/SKILL\.md$/, as: same, source: ROO_SKILLS },
  { tool: 'kiro', pattern: /^\.kiro\/steering\/[^/]+\.md$/, as: same, source: 'https://kiro.dev/docs/steering/' },
  { tool: 'kiro', pattern: skills('.kiro'), as: same, source: 'https://kiro.dev/docs/skills/' },
  { tool: 'junie', pattern: /^\.junie\/AGENTS\.md$/, as: same, source: 'https://junie.jetbrains.com/docs/guidelines-and-memory.html' },
  { tool: 'junie', pattern: skills('.junie|.agents'), as: same, source: JUNIE_SKILLS },
  // Personal instructions, loaded in addition to the project file.
  { tool: 'zed', pattern: /^(\.config\/zed|AppData\/Roaming\/Zed)\/AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://zed.dev/docs/ai/instructions' },
  { tool: 'zed', pattern: skills('.agents'), as: same, source: 'https://zed.dev/docs/ai/skills' },
  { tool: 'goose', pattern: /^\.config\/goose\/(\.goosehints|AGENTS\.md)$/, as: (p) => p.slice('.config/goose/'.length), source: 'https://goose-docs.ai/docs/guides/context-engineering/using-goosehints' },
  { tool: 'goose', pattern: skills('.agents|.claude'), as: same, source: GOOSE_SKILLS },
  { tool: 'amp', pattern: /^\.config\/(amp\/)?AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://ampcode.com/docs/customize/agents-md' },
  { tool: 'amp', pattern: skills('.config/agents', AMP_FOLDERS), as: moved('.config/agents/skills/', '.agents/skills/'), source: AMP_SKILLS },
  { tool: 'amp', pattern: skills('.config/amp', AMP_FOLDERS), as: moved('.config/amp/skills/', '.agents/skills/'), source: AMP_SKILLS },
  { tool: 'amp', pattern: skills('.agents|.claude', AMP_FOLDERS), as: same, source: AMP_SKILLS },
  { tool: 'opencode', pattern: /^\.config\/opencode\/AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://opencode.ai/docs/rules/' },
  // OpenCode falls back to ~/.claude/CLAUDE.md when ~/.config/opencode/AGENTS.md is missing.
  { tool: 'opencode', pattern: /^\.claude\/CLAUDE\.md$/, as: () => 'CLAUDE.md', source: 'https://opencode.ai/docs/rules/' },
  { tool: 'opencode', pattern: skills('.config/opencode'), as: moved('.config/opencode/skills/', '.opencode/skills/'), source: OPENCODE_SKILLS },
  { tool: 'opencode', pattern: skills('.claude|.agents'), as: same, source: OPENCODE_SKILLS },
  // The Warp Agent CLI's global rule; Global Rules in the Warp app live in Warp Drive.
  { tool: 'warp', pattern: /^\.agents\/AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://docs.warp.dev/agents/cli/configuration/' },
  { tool: 'warp', pattern: /^\.(agents|warp|claude|codex|cursor|gemini|copilot|factory|github|opencode)\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://docs.warp.dev/agents/capabilities/skills/' },
  // Factory documents the personal folders, not the file names in them; the project names are assumed.
  { tool: 'factory-droid', pattern: /^\.(factory|agents|agent)\/(AGENTS|agents|Agents|CLAUDE|Claude)\.md$/, as: (p) => p.slice(p.indexOf('/') + 1), source: 'https://docs.factory.com/harness/agents-md' },
  { tool: 'factory-droid', pattern: /^\.(factory|agents|agent)\/skills\/(?:[^/]+\/)+SKILL\.md$/, as: same, source: 'https://docs.factory.com/harness/skills' },
  { tool: 'factory-droid', pattern: /^\.factory\/droids\/[^/]+\.md$/, as: same, source: 'https://docs.factory.com/harness/subagents' },
  { tool: 'trae', pattern: /^\.trae\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://docs.trae.ai/ide/skills?_lang=en' },
  // User rules and user guidelines are always loaded, whatever their frontmatter says.
  { tool: 'augment', pattern: /^\.augment\/(rules\/.+|user-guidelines)\.md$/, as: () => '.augment-guidelines', source: 'https://docs.augmentcode.com/setup-augment/guidelines' },
  { tool: 'augment', pattern: /^\.(augment|claude|agents)\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://docs.augmentcode.com/cli/skills' },
  { tool: 'augment', pattern: /^\.augment\/agents\/[^/]+\.md$/, as: same, source: 'https://docs.augmentcode.com/cli/subagents' },
  { tool: 'kilo-code', pattern: /^\.config\/kilo\/AGENTS\.md$/, as: () => 'AGENTS.md', source: 'https://kilo.ai/docs/customize/custom-instructions' },
  { tool: 'kilo-code', pattern: /^\.(kilo|kilocode)\/rules\/[^/]+\.md$/, as: same, source: 'https://kilo.ai/docs/getting-started/migrating' },
  { tool: 'kilo-code', pattern: /^\.(kilo|claude|agents)\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://kilo.ai/docs/customize/skills' },
  { tool: 'kilo-code', pattern: /^\.config\/kilo\/agents\/[^/]+\.md$/, as: (p) => '.kilo/agents/' + p.slice(p.lastIndexOf('/') + 1), source: 'https://kilo.ai/docs/customize/custom-subagents' },
  { tool: 'devin', pattern: /^(\.config\/devin|AppData\/Roaming\/devin)\/(AGENTS\.md|AGENTS\.local\.md|AGENT\.md|\.windsurfrules)$/, as: (p) => p.slice(p.lastIndexOf('/') + 1), source: 'https://docs.devin.ai/cli/extensibility/rules' },
  { tool: 'devin', pattern: /^\.devin\/(rules\/[^/]+|global_rules)\.md$/, as: same, source: 'https://docs.devin.ai/cli/extensibility/rules' },
  { tool: 'devin', pattern: /^\.agents\/skills\/[^/]+\/SKILL\.md$/, as: same, source: 'https://docs.devin.ai/cli/extensibility/skills/overview' },
  { tool: 'devin', pattern: /^(\.config\/devin|AppData\/Roaming\/devin)\/skills\/[^/]+\/SKILL\.md$/, as: (p) => '.devin/skills/' + p.replace(/^.*?\/skills\//, ''), source: 'https://docs.devin.ai/cli/extensibility/skills/overview' },
  // Devin CLI's stable channel reads Windsurf's stable folder; the next and insiders channels are not modelled.
  { tool: 'devin', pattern: /^\.codeium\/windsurf\/skills\/[^/]+\/SKILL\.md$/, as: (p) => '.windsurf/skills/' + p.replace(/^.*?\/skills\//, ''), source: 'https://docs.devin.ai/cli/reference/configuration/read-config-from' },
  { tool: 'devin', pattern: /^\.copilot\/skills\/(?:[^/]+\/)+SKILL\.md$/, as: (p) => '.github/skills/' + p.replace(/^\.copilot\/skills\//, ''), source: 'https://docs.devin.ai/cli/reference/configuration/read-config-from' },
];

/** Home-relative folders to search, and how deep. Kept narrow so nothing else in the home directory is read. */
export const USER_ROOTS: Array<{ dir: string; depth: number }> = [
  { dir: '.claude', depth: 4 },
  { dir: '.claude/skills', depth: 5 },
  { dir: '.codex', depth: 0 },
  { dir: '.codex/skills', depth: 5 },
  { dir: '.agents', depth: 6 },
  { dir: '.gemini', depth: 0 },
  { dir: '.gemini/skills', depth: 1 },
  { dir: '.cursor/skills', depth: 5 },
  { dir: '.copilot', depth: 0 },
  { dir: '.copilot/instructions', depth: 5 },
  { dir: '.codeium/windsurf/memories', depth: 0 },
  { dir: '.codeium/windsurf/skills', depth: 1 },
  { dir: '.config/devin/skills', depth: 1 },
  { dir: 'Documents/Cline/Rules', depth: 3 },
  { dir: 'Cline/Rules', depth: 3 },
  { dir: '.cline/rules', depth: 3 },
  { dir: '.cline/skills', depth: 1 },
  { dir: '.roo', depth: 3 },
  { dir: '.kiro/steering', depth: 0 },
  { dir: '.kiro/skills', depth: 1 },
  { dir: '.junie', depth: 0 },
  { dir: '.junie/skills', depth: 1 },
  { dir: '.config/zed', depth: 0 },
  { dir: 'AppData/Roaming/Zed', depth: 0 },
  { dir: '.config/goose', depth: 0 },
  { dir: '.config', depth: 0 },
  { dir: '.config/agents/skills', depth: 5 },
  { dir: '.config/amp', depth: 0 },
  { dir: '.config/amp/skills', depth: 5 },
  { dir: '.config/opencode', depth: 0 },
  { dir: '.config/opencode/skills', depth: 1 },
  { dir: '.agent', depth: 0 },
  { dir: '.agent/skills', depth: 3 },
  { dir: '.factory', depth: 0 },
  { dir: '.factory/skills', depth: 3 },
  { dir: '.factory/droids', depth: 0 },
  { dir: '.warp/skills', depth: 1 },
  { dir: '.copilot/skills', depth: 3 },
  { dir: '.github/skills', depth: 1 },
  { dir: '.opencode/skills', depth: 1 },
  { dir: '.trae/skills', depth: 1 },
  { dir: '.augment', depth: 0 },
  { dir: '.augment/rules', depth: 3 },
  { dir: '.augment/skills', depth: 1 },
  { dir: '.augment/agents', depth: 0 },
  { dir: '.config/kilo', depth: 0 },
  { dir: '.config/kilo/agents', depth: 0 },
  { dir: '.kilo/rules', depth: 0 },
  { dir: '.kilocode/rules', depth: 0 },
  { dir: '.kilo/skills', depth: 1 },
  { dir: '.config/devin', depth: 0 },
  { dir: 'AppData/Roaming/devin', depth: 0 },
  { dir: 'AppData/Roaming/devin/skills', depth: 1 },
  { dir: '.devin', depth: 0 },
  { dir: '.devin/rules', depth: 0 },
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
