import type { LoadMode, ToolId } from './types.js';

/**
 * Loading rules for each agent, as documented by its vendor.
 * Every rule cites the page it came from and the date it was checked.
 * To update: edit the matching entry, update `checkedAt`, and run the tests.
 *
 * The audit assumes the agent is launched at the repository root.
 */

export type Frontmatter = Record<string, string | string[] | boolean>;

/** Decides how a frontmatter-driven rule file loads. */
export interface FrontmatterDecision {
  mode: LoadMode;
  trigger: string;
  /** When true, the description is always in context and the body loads on demand. */
  descriptionOnly?: boolean;
  note?: string;
  /** Set when the frontmatter looks like a mistake worth flagging. */
  problem?: string;
}

export type FileRule =
  | {
      /** Instruction file found by name. Root copy is always loaded; copies in subdirectories load on demand. */
      kind: 'hierarchical';
      names: string[];
      /** Directories (relative to any level) that count as the same level, e.g. `.claude` for `.claude/CLAUDE.md`. */
      sameLevelDirs?: string[];
      /** When several names exist in one directory, only the first present one is read. */
      onePerDirectory?: boolean;
      /**
       * How subdirectory copies load: 'always' when they are loaded with the root one (Kiro), 'ignored' when
       * they are not read, 'skip' when the docs do not say when they load (they are then left out).
       */
      nested: 'on-demand' | 'always' | 'ignored' | 'skip';
      /** Trigger for subdirectory copies, followed by their directory; for 'ignored', the reason on its own. */
      nestedTrigger: string;
      stripHtmlComments?: boolean;
      /** Maximum @import depth, when the tool expands @path imports. */
      importDepth?: number;
      /** Imported files with `globs` frontmatter load only when a matching file is read (Amp). */
      importGlobs?: boolean;
      /** Bytes read before the tool stops (content beyond is dropped). */
      maxBytes?: number;
      /** Only read when the condition holds for the repository. */
      condition?: 'claude-reads-agents-md';
      note?: string;
    }
  | {
      /** Rule files in a directory whose frontmatter decides when they load. */
      kind: 'frontmatter';
      /** Matches repo-relative paths. */
      pattern: RegExp;
      /** Rule folders at the root; copies in subdirectories only apply when the agent works there. */
      rootPrefixes: string[];
      decide: (fm: Frontmatter) => FrontmatterDecision;
    }
  | {
      /** Skill-like folders: a short description is always listed, the body loads when used. */
      kind: 'skill';
      pattern: RegExp;
      /** Directory prefix that counts as "root"; matches elsewhere are nested copies. */
      rootPrefix: string;
      /** Characters of the description kept in the listing. */
      descriptionCap?: number;
      /** Frontmatter flag that removes the description from context. */
      hideFlag?: string;
      bodyTrigger: string;
      /**
       * Nested copies (e.g. `pkg/.claude/agents/`): 'on-demand' (default) when they are listed once the agent works
       * in that directory, 'ignored' when the tool finds them only walking up from the launch directory.
       */
      nested?: 'on-demand' | 'ignored';
      /** Trigger (or, for 'ignored', reason) for nested copies, followed by their directory. */
      nestedTrigger?: string;
      /** Frontmatter keys that limit a skill to matching files; with one set, the description is listed only then. */
      pathsKeys?: string[];
      /**
       * Same-name resolution: when a skill's name (frontmatter `name`, else its folder or file name) was already
       * taken at the same level by an earlier `dedupeByName` rule of the tool, this copy is ignored.
       * Rule order is the tool's precedence. Leave unset when the tool lists both.
       */
      dedupeByName?: boolean;
      /** The listing also shows the skill file's path (Codex). */
      listsPath?: boolean;
    }
  | {
      /** A single legacy file at the root that is always loaded. */
      kind: 'root-file';
      path: string;
      note?: string;
    }
  | {
      /** Files the tool does not read, reported so users can fix them. */
      kind: 'ignored';
      pattern: RegExp;
      reason: string;
    }
  | {
      /** Files that always load in the same mode, e.g. mode-specific rule folders. */
      kind: 'pattern';
      pattern: RegExp;
      mode: LoadMode;
      trigger: string;
      note?: string;
    }
  | {
      /**
       * Ordered groups: the first group with any file present is loaded every turn,
       * files of later groups are ignored (e.g. Zed's first-match list, Junie's precedence).
       */
      kind: 'precedence';
      groups: Array<{ label: string; patterns: RegExp[] }>;
      note?: string;
    }
  | {
      /** Files listed in a config file key (e.g. `read:` in .aider.conf.yml) load every turn. */
      kind: 'config-list';
      configPath: string;
      key: string;
      trigger: string;
    };

export interface SizeLimit {
  /** Applies to files matching this pattern. */
  pattern: RegExp;
  unit: 'lines' | 'chars' | 'bytes';
  max: number;
  /**
   * truncate - the tool documents that content past the limit is dropped
   * limit    - the tool enforces the limit but does not document what happens past it
   * advice   - a vendor recommendation
   */
  severity: 'truncate' | 'limit' | 'advice';
  text: string;
  source: string;
}

export interface ToolSpec {
  id: ToolId;
  name: string;
  /** Model families this tool normally runs. Empty means any. */
  families: Array<'claude' | 'openai' | 'gemini' | 'open'>;
  sources: string[];
  checkedAt: string;
  rules: FileRule[];
  limits: SizeLimit[];
  notes: string[];
}

const str = (v: Frontmatter[string] | undefined): string =>
  v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
const has = (fm: Frontmatter, key: string): boolean => str(fm[key]).trim() !== '';

type SkillRule = Extract<FileRule, { kind: 'skill' }>;

/**
 * Skill folders `<dir>/skills/<name>/SKILL.md`, one rule per folder, in the tool's precedence order.
 * `anyLevel` also matches copies in subdirectories; `folders` is the pattern for the folder levels below `skills/`.
 */
function skillFolders(
  dirs: string[],
  opts: Omit<SkillRule, 'kind' | 'pattern' | 'rootPrefix'> & { anyLevel?: boolean; folders?: string },
): SkillRule[] {
  const { anyLevel, folders = '[^/]+/', ...rest } = opts;
  return dirs.map((dir) => ({
    kind: 'skill',
    pattern: new RegExp(`^${anyLevel ? '(?:.*/)?' : ''}${dir.replace(/\./g, '\\.')}/skills/${folders}SKILL\\.md$`),
    rootPrefix: `${dir}/skills/`,
    ...rest,
  }));
}

/** Any number of folder levels below `skills/`, for tools that also find skills in category folders. */
const RECURSIVE = '(?:[^/]+/)+';

/** Cursor's `.cursor/rules` frontmatter; Devin CLI reads those rules with the same activation logic. */
const cursorRule = (fm: Frontmatter): FrontmatterDecision => {
  if (fm.alwaysApply === true || str(fm.alwaysApply) === 'true')
    return { mode: 'always', trigger: 'alwaysApply: true' };
  if (has(fm, 'globs')) return { mode: 'on-demand', trigger: `globs: ${str(fm.globs)}` };
  if (has(fm, 'description'))
    return {
      mode: 'on-demand',
      trigger: 'agent decides from description',
      descriptionOnly: true,
    };
  return { mode: 'manual', trigger: '@-mention only' };
};

export const TOOLS: ToolSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    families: ['claude'],
    sources: [
      'https://code.claude.com/docs/en/memory',
      'https://code.claude.com/docs/en/skills',
      'https://code.claude.com/docs/en/sub-agents',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['CLAUDE.md', 'CLAUDE.local.md'],
        sameLevelDirs: ['.claude'],
        nested: 'on-demand',
        nestedTrigger: 'when Claude reads or edits a file in',
        stripHtmlComments: true,
        importDepth: 4,
      },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        sameLevelDirs: ['.claude'],
        nested: 'on-demand',
        nestedTrigger: 'when Claude reads a file in',
        importDepth: 4,
        condition: 'claude-reads-agents-md',
        note: 'Read only because no CLAUDE.md or CLAUDE.local.md exists at the root (default setting).',
      },
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.claude\/rules\/.+\.md$/,
        rootPrefixes: ['.claude/rules/'],
        decide: (fm) =>
          has(fm, 'paths')
            ? { mode: 'on-demand', trigger: `paths: ${str(fm.paths)}` }
            : { mode: 'always', trigger: 'rule without paths' },
      },
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.claude\/skills\/[^/]+\/SKILL\.md$/,
        rootPrefix: '.claude/skills/',
        descriptionCap: 1536,
        hideFlag: 'disable-model-invocation',
        bodyTrigger: 'when the skill is invoked',
        // A skill wins over a command file of the same name; a root and a nested skill both load.
        dedupeByName: true,
      },
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.claude\/commands\/.+\.md$/,
        rootPrefix: '.claude/commands/',
        descriptionCap: 1536,
        hideFlag: 'disable-model-invocation',
        bodyTrigger: 'when the command is invoked',
        dedupeByName: true,
      },
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.claude\/agents\/.+\.md$/,
        rootPrefix: '.claude/agents/',
        bodyTrigger: "as the subagent's own system prompt when it runs",
        nested: 'ignored',
        nestedTrigger: 'Claude Code finds subagents only from the launch directory up; read only when launched in',
      },
    ],
    limits: [
      {
        pattern: /(^|\/)CLAUDE(\.local)?\.md$/,
        unit: 'lines',
        max: 200,
        severity: 'advice',
        text: 'Claude Code docs recommend keeping each CLAUDE.md under 200 lines.',
        source: 'https://code.claude.com/docs/en/memory',
      },
    ],
    notes: [
      'User files (~/.claude/CLAUDE.md, rules, skills, commands, agents) are counted only with --include-user; managed policy and auto-memory files are not counted.',
      'With the "claude-md-and-agents-md" setting Claude Code reads AGENTS.md as well; the default reads it only when no CLAUDE.md exists.',
      'The skill listing is capped at 1% of the context window (skillListingBudgetFraction); past it, descriptions of the least-used skills are dropped. The cap is not applied here.',
      'Skills with paths frontmatter load automatically only for matching files; how they are listed is not documented, so they are counted like other skills.',
      'Claude Code warns at startup when the combined subagent descriptions pass 15,000 tokens.',
    ],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    families: ['openai'],
    sources: [
      'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
      'https://learn.chatgpt.com/docs/build-skills',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.override.md', 'AGENTS.md'],
        onePerDirectory: true,
        nested: 'on-demand',
        nestedTrigger: 'only when Codex is launched in',
        maxBytes: 32 * 1024,
      },
      {
        // Read in every directory from the launch directory up to the repository root; same-name skills are both listed.
        kind: 'skill',
        pattern: /^(?:.*\/)?\.agents\/skills\/[^/]+\/SKILL\.md$/,
        rootPrefix: '.agents/skills/',
        bodyTrigger: 'when the skill is selected',
        nested: 'ignored',
        nestedTrigger: 'Codex reads skills from the launch directory up; read only when launched in',
        listsPath: true,
      },
    ],
    limits: [
      {
        pattern: /(^|\/)AGENTS(\.override)?\.md$/,
        unit: 'bytes',
        max: 32 * 1024,
        severity: 'truncate',
        text: 'Codex stops reading project docs at project_doc_max_bytes (default 32 KiB); the rest is dropped.',
        source: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
      },
    ],
    notes: [
      'Global ~/.codex/AGENTS.md and ~/.agents/skills are counted only with --include-user; /etc/codex/skills is not counted.',
      "The skill list (name, description and path of each skill) uses at most 2% of the context window, or 8,000 characters when it is unknown (skills.max_context_tokens); Codex shortens descriptions first. The cap is not applied here.",
      '.codex/skills is not a documented Codex location.',
    ],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    families: ['gemini'],
    sources: [
      'https://geminicli.com/docs/cli/gemini-md/',
      'https://geminicli.com/docs/reference/memport/',
      'https://geminicli.com/docs/cli/skills/',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['GEMINI.md'],
        nested: 'on-demand',
        nestedTrigger: 'when a tool accesses',
        importDepth: 5,
      },
      // Workspace skills; on a name clash the .agents/skills alias wins over .gemini/skills.
      ...skillFolders(['.agents', '.gemini'], { bodyTrigger: 'when Gemini activates the skill', dedupeByName: true }),
    ],
    limits: [],
    notes: [
      'Only GEMINI.md is read by default; context.fileName can add AGENTS.md (not modelled).',
      'Skills are on by default (skills.enabled). Skill folders in subdirectories are not documented and not counted.',
      'Global ~/.gemini/GEMINI.md and user skills are counted only with --include-user.',
      'Antigravity CLI replaced Gemini CLI for unpaid and Google One users on 2026-06-18.',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    families: [],
    sources: ['https://cursor.com/docs/rules', 'https://cursor.com/help/customization/rules', 'https://cursor.com/docs/skills'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.cursor\/rules\/.+\.mdc$/,
        rootPrefixes: ['.cursor/rules/'],
        decide: cursorRule,
      },
      {
        kind: 'ignored',
        pattern: /^(?:.*\/)?\.cursor\/rules\/.+\.md$/,
        reason: 'Cursor ignores plain .md files in .cursor/rules; rename to .mdc.',
      },
      { kind: 'root-file', path: '.cursorrules', note: 'Legacy file; Cursor plans to deprecate it.' },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'on-demand',
        nestedTrigger: 'when working in',
      },
      {
        kind: 'hierarchical',
        names: ['CLAUDE.md'],
        nested: 'on-demand',
        nestedTrigger: 'when working in',
      },
      // Skills in category subfolders count too; nested project folders apply only to files under them.
      ...skillFolders(['.agents', '.cursor', '.claude', '.codex'], {
        anyLevel: true,
        folders: RECURSIVE,
        hideFlag: 'disable-model-invocation',
        pathsKeys: ['paths', 'globs'],
        bodyTrigger: 'when the agent applies the skill',
        dedupeByName: true,
      }),
    ],
    limits: [
      {
        pattern: /\.mdc$/,
        unit: 'lines',
        max: 500,
        severity: 'advice',
        text: 'Cursor docs recommend keeping each rule under 500 lines.',
        source: 'https://cursor.com/docs/rules',
      },
    ],
    notes: [
      'User and Team rules are configured in Cursor settings, not in the repository, and are not counted.',
      'Which skill folder wins when two hold a skill with the same name is not documented; .agents, .cursor, .claude, .codex is assumed.',
    ],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    families: [],
    sources: [
      'https://code.visualstudio.com/docs/agent-customization/custom-instructions',
      'https://code.visualstudio.com/docs/agents/reference/ai-settings',
      'https://code.visualstudio.com/docs/agent-customization/agent-skills',
      'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions',
      'https://docs.github.com/en/copilot/reference/custom-instructions-support',
      'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills',
    ],
    checkedAt: '2026-10-17',
    // Modelled on VS Code with default settings; Copilot CLI and cloud agent differ (see notes).
    rules: [
      { kind: 'root-file', path: '.github/copilot-instructions.md' },
      {
        kind: 'frontmatter',
        pattern: /^\.github\/instructions\/.+\.instructions\.md$/,
        rootPrefixes: ['.github/instructions/'],
        decide: (fm) => {
          if (has(fm, 'applyTo')) return { mode: 'on-demand', trigger: `applyTo: ${str(fm.applyTo)}` };
          if (has(fm, 'description'))
            return {
              mode: 'on-demand',
              trigger: 'agent decides from description (VS Code)',
              descriptionOnly: true,
              note: 'Description assumed to be in context so the agent can decide (inferred, not documented).',
            };
          return { mode: 'manual', trigger: 'attached manually' };
        },
      },
      {
        // Claude rules: `paths` replaces applyTo and defaults to **.
        kind: 'frontmatter',
        pattern: /^\.claude\/rules\/.+\.md$/,
        rootPrefixes: ['.claude/rules/'],
        decide: (fm) => ({ mode: 'on-demand', trigger: has(fm, 'paths') ? `paths: ${str(fm.paths)}` : 'paths: ** (default)' }),
      },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'ignored',
        nestedTrigger: 'VS Code reads nested AGENTS.md only with chat.useNestedAgentsMdFiles, which is off by default.',
      },
      {
        // chat.useClaudeMdFile (on by default): CLAUDE.md as always-on instructions, together with AGENTS.md.
        kind: 'hierarchical',
        names: ['CLAUDE.md', 'CLAUDE.local.md'],
        sameLevelDirs: ['.claude'],
        nested: 'ignored',
        nestedTrigger: 'VS Code reads CLAUDE.md only at the workspace root.',
      },
      { kind: 'pattern', pattern: /^GEMINI\.md$/, mode: 'ignored', trigger: 'VS Code does not read GEMINI.md (Copilot CLI and cloud agent do).' },
      ...skillFolders(['.github', '.claude', '.agents'], { hideFlag: 'disable-model-invocation', bodyTrigger: 'when Copilot loads the skill' }),
    ],
    limits: [],
    notes: [
      'Modelled on VS Code with default settings (chat.useAgentsMdFile and chat.useClaudeMdFile on, chat.useNestedAgentsMdFiles off); VS Code does not expand @imports.',
      'Copilot CLI instead reads AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and GEMINI.md from the repository root, the working directory, the folders between and the folders of files it works on, combines them all, and expands @path references in copilot-instructions.md, AGENTS.md and CLAUDE.md.',
      'Copilot cloud agent uses the nearest AGENTS.md, or a single root CLAUDE.md or GEMINI.md instead.',
      'Copilot code review also reads REVIEW.md and uses only skills in .github/skills.',
      'Same-name skills in different folders are not merged (VS Code shows both); both are counted.',
    ],
  },
  {
    id: 'windsurf',
    name: 'Windsurf Cascade',
    families: [],
    sources: [
      'https://docs.devin.ai/desktop/cascade/memories',
      'https://docs.devin.ai/desktop/cascade/agents-md',
      'https://docs.devin.ai/desktop/cascade/skills',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.(?:devin|windsurf)\/rules\/.+\.md$/,
        rootPrefixes: ['.devin/rules/', '.windsurf/rules/'],
        decide: (fm) => {
          switch (str(fm.trigger).trim()) {
            case 'always_on':
              return { mode: 'always', trigger: 'trigger: always_on' };
            case 'model_decision':
              return { mode: 'on-demand', trigger: 'trigger: model_decision', descriptionOnly: true };
            case 'glob':
              return { mode: 'on-demand', trigger: `trigger: glob ${str(fm.globs)}`.trim() };
            case 'manual':
              return { mode: 'manual', trigger: 'trigger: manual (@rule-name)' };
            default:
              return {
                mode: 'manual',
                trigger: 'no trigger set',
                note: 'Docs do not state the default when trigger is missing; not counted.',
                problem: 'Rule has no trigger frontmatter; set always_on, model_decision, glob or manual.',
              };
          }
        },
      },
      { kind: 'root-file', path: '.windsurfrules', note: 'Legacy single-file rules, still read.' },
      // The global rules file, always on; only found with --include-user (see user.ts).
      { kind: 'root-file', path: '.codeium/windsurf/memories/global_rules.md' },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'agents.md'],
        nested: 'on-demand',
        nestedTrigger: 'auto-glob for files in',
      },
      ...skillFolders(['.devin', '.windsurf', '.agents'], {
        bodyTrigger: 'when Cascade invokes the skill or it is @-mentioned',
        dedupeByName: true,
      }),
    ],
    limits: [
      {
        pattern: /(^|\/)(\.(devin|windsurf)\/rules\/.+\.md|\.windsurfrules)$/,
        unit: 'chars',
        max: 12000,
        severity: 'limit',
        text: 'Windsurf limits workspace rule files to 12,000 characters each.',
        source: 'https://docs.devin.ai/desktop/cascade/memories',
      },
      {
        pattern: /(^|\/)\.codeium\/windsurf\/memories\/global_rules\.md$/,
        unit: 'chars',
        max: 6000,
        severity: 'limit',
        text: 'Windsurf limits the global rules file to 6,000 characters.',
        source: 'https://docs.devin.ai/desktop/cascade/memories',
      },
    ],
    notes: [
      'Cascade is the legacy agent: new Devin Desktop conversations start on Devin Local, which follows the Devin CLI rules.',
      'Global rules (~/.codeium/windsurf/memories/global_rules.md) and global skills are counted only with --include-user.',
      'Which skill folder wins on a name clash is not documented; .devin, .windsurf, .agents is assumed. .claude/skills is read only with an opt-in setting whose default is not documented, so it is not counted.',
    ],
  },
  {
    id: 'cline',
    name: 'Cline',
    families: [],
    sources: ['https://docs.cline.bot/customization/cline-rules', 'https://docs.cline.bot/customization/skills'],
    checkedAt: '2026-10-17',
    rules: [
      {
        // .clinerules/skills/ holds skills, not rules.
        kind: 'frontmatter',
        pattern: /^(?:\.clinerules\/(?!skills\/)|\.cline\/rules\/).+\.md$/,
        rootPrefixes: ['.clinerules/', '.cline/rules/'],
        decide: (fm) => {
          if (Array.isArray(fm.paths) && fm.paths.length === 0) return { mode: 'ignored', trigger: 'paths: [] (never applies)' };
          if (has(fm, 'paths')) return { mode: 'on-demand', trigger: `paths: ${str(fm.paths)}` };
          return { mode: 'always', trigger: 'rule without paths' };
        },
      },
      ...skillFolders(['.cline', '.clinerules', '.claude'], { bodyTrigger: 'when Cline activates the skill', dedupeByName: true }),
    ],
    limits: [],
    notes: [
      'Each rule and skill can be toggled off in Cline; the audit assumes they are on (skills are on when discovered).',
      'Cline also detects AGENTS.md, .cursorrules and .windsurfrules; whether they are on by default is not documented, so they are not counted.',
      'A single .clinerules file (instead of a folder) is not documented and is not counted.',
      'Which project skill folder wins on a name clash is not documented; .cline/skills, .clinerules/skills, .claude/skills is assumed. A global skill wins over a project skill of the same name.',
    ],
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    families: [],
    sources: ['https://roocodeinc.github.io/Roo-Code/features/custom-instructions', 'https://roocodeinc.github.io/Roo-Code/features/skills'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'precedence',
        groups: [
          { label: '.roo/rules/', patterns: [/^\.roo\/rules\/.+/] },
          { label: '.roorules', patterns: [/^\.roorules$/] },
          { label: '.clinerules', patterns: [/^\.clinerules$/] },
        ],
        note: 'Legacy .roorules and .clinerules are read only when .roo/rules/ has no content; their order between each other is assumed.',
      },
      { kind: 'pattern', pattern: /^\.roo\/rules-[\w-]+\/.+/, mode: 'on-demand', trigger: 'only in that Roo mode' },
      { kind: 'pattern', pattern: /^\.roorules-[\w-]+$/, mode: 'on-demand', trigger: 'only in that Roo mode (legacy)' },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'AGENT.md'],
        onePerDirectory: true,
        nested: 'skip',
        nestedTrigger: '',
        note: 'Read by default; the roo-cline.useAgentRules setting turns it off.',
      },
      // .roo wins over .agents on a name clash; mode folders (skills-{mode}) apply only in that mode.
      ...skillFolders(['.roo', '.agents'], { bodyTrigger: 'when Roo loads the skill', dedupeByName: true }),
      { kind: 'pattern', pattern: /^\.(?:roo|agents)\/skills-[\w-]+\/[^/]+\/SKILL\.md$/, mode: 'on-demand', trigger: 'only in that Roo mode (skill)' },
    ],
    limits: [],
    notes: [
      'Global ~/.roo/rules/ and ~/.roo/skills/ are counted only with --include-user.',
      'Legacy .roorules and .clinerules are also skipped when the global ~/.roo/rules/ has content; that case is not modelled.',
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    families: [],
    sources: ['https://kiro.dev/docs/steering/', 'https://kiro.dev/docs/skills/'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^\.kiro\/steering\/[^/]+\.md$/,
        rootPrefixes: ['.kiro/steering/'],
        decide: (fm) => {
          switch (str(fm.inclusion).trim()) {
            case '':
            case 'always':
              return { mode: 'always', trigger: 'inclusion: always' };
            case 'fileMatch':
              return { mode: 'on-demand', trigger: `fileMatch: ${str(fm.fileMatchPattern)}` };
            case 'manual':
              return { mode: 'manual', trigger: 'inclusion: manual (#name)' };
            case 'auto':
              return {
                mode: 'on-demand',
                trigger: 'inclusion: auto (matched on description)',
                descriptionOnly: true,
                note: 'Description assumed to be in context so Kiro can match it (inferred, not documented).',
              };
            default:
              return { mode: 'always', trigger: `inclusion: ${str(fm.inclusion)} (unknown, treated as always)` };
          }
        },
      },
      // AGENTS.md is always included, and subdirectory copies are loaded as steering alongside it.
      { kind: 'hierarchical', names: ['AGENTS.md'], nested: 'always', nestedTrigger: 'always included, found in' },
      ...skillFolders(['.kiro'], { bodyTrigger: 'when Kiro activates the skill' }),
    ],
    limits: [],
    notes: [
      'fileMatch and manual modes need Kiro CLI V3; older versions skip those files.',
      'Global ~/.kiro/steering/ (including AGENTS.md there) and ~/.kiro/skills/ are counted only with --include-user.',
      '#[[file:...]] and #[[folder:...]] references in steering files are not followed.',
    ],
  },
  {
    id: 'junie',
    name: 'JetBrains Junie',
    families: [],
    sources: ['https://junie.jetbrains.com/docs/guidelines-and-memory.html', 'https://junie.jetbrains.com/docs/agent-skills.html'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'precedence',
        groups: [
          { label: '.junie/AGENTS.md', patterns: [/^\.junie\/AGENTS\.md$/] },
          { label: 'AGENTS.md', patterns: [/^AGENTS\.md$/, /^\.junie\/playbook\.md$/, /^\.junie\/rules\/[^/]+\.md$/] },
          { label: '.junie/guidelines', patterns: [/^\.junie\/guidelines\.md$/, /^\.junie\/guidelines\/[^/]+\.md$/] },
        ],
        note: 'Follows the order documented for Junie CLI.',
      },
      ...skillFolders(['.junie', '.agents'], { bodyTrigger: 'when Junie uses the skill', dedupeByName: true }),
    ],
    limits: [],
    notes: [
      'Global ~/.junie/AGENTS.md is combined with the project guidelines; it and user skills are counted only with --include-user.',
      '.agents/skills is read only in trusted projects. Which skill folder wins on a name clash is not documented; .junie/skills is assumed.',
    ],
  },
  {
    id: 'zed',
    name: 'Zed',
    families: [],
    sources: ['https://zed.dev/docs/ai/instructions', 'https://zed.dev/docs/ai/skills'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'precedence',
        groups: [
          '.rules',
          '.cursorrules',
          '.windsurfrules',
          '.clinerules',
          '.github/copilot-instructions.md',
          'AGENT.md',
          'AGENTS.md',
          'CLAUDE.md',
          'GEMINI.md',
        ].map((path) => ({ label: path, patterns: [new RegExp(`^${path.replace(/\./g, '\\.')}$`)] })),
        note: 'Zed uses only the first of these files it finds at the project root.',
      },
      // Flat layout only: skill folders must be direct children of .agents/skills.
      ...skillFolders(['.agents'], { hideFlag: 'disable-model-invocation', bodyTrigger: 'when the agent loads the skill' }),
    ],
    limits: [],
    notes: [
      'Personal ~/.config/zed/AGENTS.md (%APPDATA%\\Zed\\AGENTS.md on Windows) loads in addition to the project file; it and ~/.agents/skills are counted only with --include-user.',
      'The skill catalog (names and descriptions) is capped at 50 KB; project skills load only in trusted worktrees.',
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    families: [],
    sources: ['https://docs.continue.dev/customize/deep-dives/rules'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^\.continue\/rules\/[^/]+\.md$/,
        rootPrefixes: ['.continue/rules/'],
        decide: (fm) => {
          const always = fm.alwaysApply === true || str(fm.alwaysApply) === 'true';
          const never = fm.alwaysApply === false || str(fm.alwaysApply) === 'false';
          if (always) return { mode: 'always', trigger: 'alwaysApply: true' };
          if (has(fm, 'globs')) return { mode: 'on-demand', trigger: `globs: ${str(fm.globs)}` };
          if (!never) return { mode: 'always', trigger: 'no globs' };
          if (has(fm, 'description'))
            return {
              mode: 'on-demand',
              trigger: 'agent decides from description',
              descriptionOnly: true,
              note: 'Description assumed to be in context so the agent can decide (inferred, not documented).',
            };
          return { mode: 'on-demand', trigger: 'alwaysApply: false (agent decides)' };
        },
      },
    ],
    limits: [],
    notes: [
      'Rules in config.yaml or from the Continue hub are not counted.',
      'regex frontmatter (a rule included when a file in context matches it) is not modelled.',
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    families: [],
    sources: ['https://aider.chat/docs/usage/conventions.html'],
    checkedAt: '2026-10-17',
    rules: [
      { kind: 'config-list', configPath: '.aider.conf.yml', key: 'read', trigger: 'read: in .aider.conf.yml' },
      { kind: 'pattern', pattern: /^CONVENTIONS\.md$/, mode: 'manual', trigger: 'only with --read, /read or read: in .aider.conf.yml' },
    ],
    limits: [],
    notes: ['Aider loads no instruction file by itself; files given with --read are sent with every request.'],
  },
  {
    id: 'goose',
    name: 'Goose',
    families: [],
    sources: [
      'https://goose-docs.ai/docs/guides/context-engineering/using-goosehints',
      'https://goose-docs.ai/docs/guides/context-engineering/using-skills',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', '.goosehints'],
        nested: 'on-demand',
        nestedTrigger: 'when goose accesses files in',
        // `@file` includes the file's content; how deep nested @-references go is not documented.
        importDepth: 1,
      },
      ...skillFolders(['.agents', '.goose', '.claude'], { bodyTrigger: 'when goose loads the skill', dedupeByName: true }),
    ],
    limits: [],
    notes: [
      'Needs the Developer extension; CONTEXT_FILE_NAMES can change which files are read.',
      'Files referenced with @ in hint files are included; following them one level deep is an assumption.',
      'Global ~/.config/goose/.goosehints and AGENTS.md and user skills are counted only with --include-user.',
      'Which skill folder wins on a name clash is not documented; .agents, .goose, .claude is assumed.',
    ],
  },
  {
    id: 'amp',
    name: 'Amp',
    families: [],
    sources: ['https://ampcode.com/docs/customize/agents-md', 'https://ampcode.com/docs/customize/skills'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'],
        onePerDirectory: true,
        nested: 'on-demand',
        nestedTrigger: 'when Amp reads a file in',
        importDepth: 1,
        importGlobs: true,
        note: 'AGENT.md and CLAUDE.md are fallbacks for directories without AGENTS.md; their order between each other, and following @-mentions one level deep, are assumptions.',
      },
      // Amp uses the first skill with a given name; skills may sit up to five folders below each skills root.
      ...skillFolders(['.agents', '.claude'], { folders: '(?:[^/]+/){1,5}', bodyTrigger: 'when Amp loads the skill', dedupeByName: true }),
    ],
    limits: [],
    notes: [
      'User AGENTS.md files (~/.config/amp, ~/.config) and user skills are counted only with --include-user; system files (/etc/ampcode) are not counted.',
      'Glob @-mentions such as @doc/*.md are not expanded.',
      'amp.skills.disableClaudeCodeSkills turns off the .claude/skills folders (read by default). Skill folders in subdirectories below the launch directory are not documented and not counted.',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    families: [],
    sources: ['https://opencode.ai/docs/rules/', 'https://opencode.ai/docs/skills/'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'CLAUDE.md'],
        onePerDirectory: true,
        nested: 'skip',
        nestedTrigger: '',
        note: 'CLAUDE.md is read only when there is no AGENTS.md.',
      },
      // Found walking up from the launch directory to the worktree root.
      ...skillFolders(['.opencode', '.claude', '.agents'], {
        anyLevel: true,
        nested: 'ignored',
        nestedTrigger: 'OpenCode reads skills from the launch directory up; read only when launched in',
        bodyTrigger: 'when the agent loads the skill',
        dedupeByName: true,
      }),
    ],
    limits: [],
    notes: [
      'Extra files listed under instructions in opencode.json are not counted.',
      'Which skill folder wins on a name clash is not documented; .opencode, .claude, .agents is assumed. Skills hidden with metadata opencode/autoinvoke are counted like others.',
    ],
  },
  {
    id: 'warp',
    name: 'Warp',
    families: [],
    sources: [
      'https://docs.warp.dev/agents/capabilities/rules/',
      'https://docs.warp.dev/agents/capabilities/skills/',
      'https://docs.warp.dev/agents/cli/configuration/',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['WARP.md', 'AGENTS.md'],
        onePerDirectory: true,
        nested: 'on-demand',
        nestedTrigger: 'best effort when Warp edits files in',
      },
      ...['agents', 'warp', 'claude', 'codex', 'cursor', 'gemini', 'copilot', 'factory', 'github', 'opencode'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^(?:.*\\/)?\\.${dir}\\/skills\\/[^/]+\\/SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          bodyTrigger: 'when the skill is used',
        }),
      ),
    ],
    limits: [],
    notes: [
      'Only all-caps AGENTS.md and WARP.md are read; /init can link CLAUDE.md, .cursorrules and similar files to AGENTS.md, but Warp does not read them by name.',
      'Global Rules live in Warp Drive and are not counted; the Warp Agent CLI also reads ~/.agents/AGENTS.md, which --include-user counts.',
      'Project MCP configs (.warp/.mcp.json, .mcp.json and others) never start on their own, so their servers are not counted; ~/.warp/.mcp.json is.',
    ],
  },
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    families: [],
    sources: [
      'https://docs.factory.com/harness/agents-md',
      'https://docs.factory.com/harness/skills',
      'https://docs.factory.com/harness/subagents',
      'https://docs.factory.com/harness/custom-slash-commands',
      'https://docs.factory.com/droid-cli/output-styles',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'agents.md', 'Agents.md', 'CLAUDE.md', 'Claude.md'],
        sameLevelDirs: ['.factory', '.agents', '.agent'],
        nested: 'on-demand',
        nestedTrigger: 'when Droid reads files in',
        note: 'Every compatible file Droid finds is assumed to be read; the docs list the names but do not say that one wins.',
      },
      ...['DESIGN.md', 'Design.md', 'design.md'].map(
        (path): FileRule => ({
          kind: 'root-file',
          path,
          note: 'Design guidelines; where Droid looks for this file is not documented, so only the root copy is counted.',
        }),
      ),
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.factory\/skills\/(?:[^/]+\/)+SKILL\.md$/,
        rootPrefix: '.factory/skills/',
        hideFlag: 'disable-model-invocation',
        bodyTrigger: 'when the skill is invoked',
      },
      ...['agents', 'agent'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir}\\/skills\\/(?:[^/]+\\/)+SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          hideFlag: 'disable-model-invocation',
          bodyTrigger: 'when the skill is invoked',
        }),
      ),
      {
        kind: 'skill',
        pattern: /^\.factory\/droids\/[^/]+\.md$/,
        rootPrefix: '.factory/droids/',
        bodyTrigger: "as the droid's own system prompt when it runs",
      },
      { kind: 'pattern', pattern: /^\.factory\/commands\/.+\.md$/, mode: 'manual', trigger: 'only as a /command' },
      {
        kind: 'pattern',
        pattern: /^(?:.*\/)?\.factory\/output-styles\/[^/]+\.md$/,
        mode: 'manual',
        trigger: 'only when picked as the output style',
      },
    ],
    limits: [
      {
        pattern: /(^|\/)(AGENTS|agents|Agents|CLAUDE|Claude)\.md$/,
        unit: 'chars',
        max: 80000,
        severity: 'limit',
        text: 'Factory caps the initial AGENTS-style guideline load at 80,000 characters (40,000 for files Droid finds later while reading).',
        source: 'https://docs.factory.com/harness/agents-md',
      },
    ],
    notes: [
      'The 80,000-character cap covers all guideline files loaded at startup together, and what happens past it is not documented; turntax checks each file on its own.',
      'A skill with disable-model-invocation: true is assumed to keep its description out of context (not documented); skills turned off with enabled: false or disabledSkills are still counted.',
      'Droid descriptions are assumed to be listed for the Task tool (inferred).',
      '.claude/skills, .claude/agents and .claude/commands are only imported (copied) on request, not read in place.',
      'Personal files in ~/.factory/, ~/.agents/ and ~/.agent/ are outside the repository; --include-user counts them, assuming the same file names.',
    ],
  },
  {
    id: 'trae',
    name: 'TRAE',
    families: [],
    sources: [
      'https://docs.trae.ai/ide/rules?_lang=en',
      'https://docs.trae.ai/ide/skills?_lang=en',
      'https://docs.trae.ai/ide/slash-commands?_lang=en',
      'https://docs.trae.ai/ide/subagents?_lang=en',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.trae\/rules\/(?:[^/]+\/){0,3}[^/]+\.md$/,
        rootPrefixes: ['.trae/rules/'],
        decide: (fm) => {
          if (fm.alwaysApply === true || str(fm.alwaysApply) === 'true')
            return { mode: 'always', trigger: 'alwaysApply: true' };
          if (fm.alwaysApply === false || str(fm.alwaysApply) === 'false') {
            if (has(fm, 'globs')) return { mode: 'on-demand', trigger: `globs: ${str(fm.globs)}` };
            if (has(fm, 'description'))
              return {
                mode: 'on-demand',
                trigger: 'agent decides from description',
                descriptionOnly: true,
                note: 'Description assumed to be in context so the agent can decide (inferred, not documented).',
              };
            return { mode: 'manual', trigger: 'alwaysApply: false (#Rule only)' };
          }
          return {
            mode: 'manual',
            trigger: 'no alwaysApply set',
            note: 'TRAE docs do not say how a rule without alwaysApply loads; not counted.',
          };
        },
      },
      {
        kind: 'ignored',
        pattern: /^(?:.*\/)?\.trae\/rules\/(?:[^/]+\/){4,}[^/]+\.md$/,
        reason: 'TRAE reads .trae/rules only three folder levels deep; move this rule up a level.',
      },
      {
        kind: 'skill',
        pattern: /^\.trae\/skills\/[^/]+\/SKILL\.md$/,
        rootPrefix: '.trae/skills/',
        bodyTrigger: 'when the agent loads the skill',
      },
      {
        kind: 'pattern',
        pattern: /^\.agents\/skills\/[^/]+\/SKILL\.md$/,
        mode: 'manual',
        trigger: 'only with "Enable .agents Skills Directory" switched on',
      },
      {
        kind: 'pattern',
        pattern: /^\.trae\/commands\/(?:[^/]+\/){0,3}[^/]+\.md$/,
        mode: 'manual',
        trigger: 'only as a /command',
      },
      {
        kind: 'pattern',
        pattern: /^\.trae\/agents\/[^/]+\.md$/,
        mode: 'manual',
        trigger: 'only with "Enable Subagents Directory" (Settings > Beta) switched on',
      },
    ],
    limits: [],
    notes: [
      '.agents/skills and .trae/agents are read only when their switches in Settings are on; the defaults are not documented, so they are listed as manual and not counted.',
      'AGENTS.md (root, and nested when files there are read or mentioned) and root CLAUDE.md / CLAUDE.local.md are read only with the "Include AGENTS.md in the context" and "Include CLAUDE.md in context" switches on; the defaults are not documented, so they are not counted.',
      'Global rules (~/.trae/user_rules) have no documented file format and are not counted.',
      '.trae/mcp.json is read only with the Project MCP switch on; the default is not documented, so its servers are not counted.',
    ],
  },
  {
    id: 'augment',
    name: 'Augment Code',
    families: [],
    sources: [
      'https://docs.augmentcode.com/setup-augment/guidelines',
      'https://docs.augmentcode.com/cli/rules',
      'https://docs.augmentcode.com/cli/skills',
      'https://docs.augmentcode.com/using-augment/skills',
      'https://docs.augmentcode.com/cli/custom-commands',
      'https://docs.augmentcode.com/cli/subagents',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'CLAUDE.md'],
        nested: 'on-demand',
        nestedTrigger: 'when Augment works on a file in',
      },
      { kind: 'root-file', path: '.augment-guidelines' },
      {
        kind: 'frontmatter',
        pattern: /^\.augment\/rules\/.+\.md$/,
        rootPrefixes: ['.augment/rules/'],
        decide: (fm) => {
          const type = str(fm.type).trim();
          switch (type) {
            case '':
            case 'always_apply':
              return { mode: 'always', trigger: 'type: always_apply' };
            case 'agent_requested':
              if (!has(fm, 'description'))
                return {
                  mode: 'on-demand',
                  trigger: 'type: agent_requested without a description',
                  problem: 'agent_requested rule has no description; Augment needs one to decide when to attach it.',
                };
              return {
                mode: 'on-demand',
                trigger: 'type: agent_requested',
                descriptionOnly: true,
                note: 'Description assumed to be in context so the agent can decide (inferred, not documented).',
              };
            case 'manual':
              return { mode: 'manual', trigger: 'type: manual (@-mention in the IDE; the CLI skips it)' };
            default:
              return {
                mode: 'always',
                trigger: `type: ${type} (unknown, treated as always_apply)`,
                note: 'An unknown type is assumed to load like always_apply (not documented).',
                problem: `Unknown rule type "${type}"; use always_apply, agent_requested or manual.`,
              };
          }
        },
      },
      {
        kind: 'ignored',
        pattern: /^.+\/\.augment\/rules\/.+\.md$/,
        reason: 'Augment reads .augment/rules only at the workspace root; move the rule there or use an AGENTS.md in this folder.',
      },
      ...['augment', 'claude', 'agents'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir}\\/skills\\/[^/]+\\/SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          bodyTrigger: 'when the skill is activated',
        }),
      ),
      {
        kind: 'skill',
        pattern: /^\.augment\/agents\/[^/]+\.md$/,
        rootPrefix: '.augment/agents/',
        bodyTrigger: "as the subagent's own prompt when it runs",
      },
      {
        kind: 'pattern',
        pattern: /^\.(?:augment|claude|agents|cursor)\/commands\/.+\.md$/,
        mode: 'manual',
        trigger: 'only as a /command',
      },
    ],
    limits: [
      {
        pattern: /^(\.augment-guidelines|\.augment\/rules\/.+\.md)$/,
        unit: 'chars',
        max: 49512,
        severity: 'limit',
        text: 'Augment limits workspace guidelines and rules to 49,512 characters combined.',
        source: 'https://docs.augmentcode.com/setup-augment/guidelines',
      },
      {
        pattern: /(^|\/)\.augment\/user-guidelines\.md$/,
        unit: 'chars',
        max: 24576,
        severity: 'limit',
        text: 'Augment limits User Guidelines to 24,576 characters.',
        source: 'https://docs.augmentcode.com/setup-augment/guidelines',
      },
    ],
    notes: [
      'The 49,512-character limit covers .augment-guidelines and all workspace rules together; turntax checks each file on its own, so it can miss a combined overflow.',
      'Subagent descriptions are assumed to be listed for the agent (inferred).',
      'In VS Code, skills are a beta with Auto, Manual and Disabled modes whose default is not documented; the CLI behaviour (description listed, body on activation) is counted.',
      'User rules (~/.augment/rules/) and ~/.augment/user-guidelines.md are always loaded; --include-user counts them.',
    ],
  },
  {
    id: 'kilo-code',
    name: 'Kilo Code',
    families: [],
    sources: [
      'https://kilo.ai/docs/customize/custom-instructions',
      'https://kilo.ai/docs/customize/agents-md',
      'https://kilo.ai/docs/customize/custom-rules',
      'https://kilo.ai/docs/customize/skills',
      'https://kilo.ai/docs/customize/workflows',
      'https://kilo.ai/docs/customize/custom-subagents',
      'https://kilo.ai/docs/getting-started/migrating',
      'https://kilo.ai/docs/code-with-ai/platforms/cloud-agent',
      'https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/docs/rules-migration.md',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'precedence',
        groups: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CONTEXT.md'].map((path) => ({
          label: path,
          patterns: [new RegExp(`^${path.replace(/\./g, '\\.')}$`)],
        })),
        note: 'Kilo reads the first of these root files it finds; AGENT.md is documented as an AGENTS.md fallback, and the order of CLAUDE.md and CONTEXT.md is assumed from the source.',
      },
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'on-demand',
        nestedTrigger: 'when the Read tool opens a file in',
      },
      { kind: 'root-file', path: '.kilocoderules', note: 'Legacy file, still loaded through auto-migration.' },
      { kind: 'pattern', pattern: /^\.(?:kilo|kilocode)\/rules\/[^/]+\.md$/, mode: 'always', trigger: 'rules folder (all modes)' },
      {
        kind: 'pattern',
        pattern: /^\.(?:kilo|kilocode)\/rules-[\w-]+\/[^/]+\.md$/,
        mode: 'on-demand',
        trigger: 'only in that Kilo mode',
        note: "Kilo's user docs say mode rules load only in their mode; its GitHub migration doc says they load in every mode.",
      },
      {
        kind: 'pattern',
        pattern: /^\.kilocoderules-[\w-]+$/,
        mode: 'on-demand',
        trigger: 'only in that Kilo mode (legacy)',
        note: "Kilo's user docs say mode rules load only in their mode; its GitHub migration doc says they load in every mode.",
      },
      ...['kilo', 'kilocode', 'agents', 'claude'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir}\\/skills\\/[^/]+\\/SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          bodyTrigger: 'when the agent uses the skill',
        }),
      ),
      ...['kilo/agents', 'kilo/agent', 'kilocode/agents'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir.replace('/', '\\/')}\\/[^/]+\\.md$`),
          rootPrefix: `.${dir}/`,
          bodyTrigger: "as the agent's own prompt when it runs",
        }),
      ),
      { kind: 'pattern', pattern: /^\.kilo\/commands\/.+\.md$/, mode: 'manual', trigger: 'only as a /command' },
    ],
    limits: [],
    notes: [
      'The custom rules page says .kilo/rules files are added through instructions in kilo.jsonc; the migration guide and the source read .kilo/rules and .kilocode/rules automatically, which is what is counted. When both folders hold a file with the same name, only the .kilo copy is read (not modelled).',
      'Files listed under instructions in kilo.json or kilo.jsonc are not counted.',
      'Nested CLAUDE.md and CONTEXT.md files are not documented and not counted.',
      'In VS Code, .claude/skills are read only with Claude Code Compatibility on; the CLI reads them by default and they are counted. The legacy .kilocode/skills folder is documented on the Cloud Agents page.',
      'Custom agent descriptions are assumed to be listed for the Task tool (inferred).',
      'Kilo also reads ~/.claude/CLAUDE.md as a global fallback until Claude Code migration runs; turntax does not count it for Kilo.',
    ],
  },
  {
    id: 'jules',
    name: 'Google Jules',
    families: ['gemini'],
    sources: ['https://jules.google/docs/', 'https://jules.google/docs/environment/', 'https://jules.google/docs/changelog/'],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'skip',
        nestedTrigger: '',
        note: 'Jules looks for AGENTS.md at the repository root; reading it for every task is assumed.',
      },
    ],
    limits: [],
    notes: [
      'Jules runs each task in a cloud VM; setup scripts, MCP connections and memories are configured in the Jules web app and are not counted.',
      'When subdirectory AGENTS.md files load is not documented, so they are not counted.',
    ],
  },
  {
    id: 'devin',
    name: 'Devin Local / Devin CLI',
    families: [],
    sources: [
      'https://docs.devin.ai/cli/extensibility/rules',
      'https://docs.devin.ai/cli/reference/configuration/read-config-from',
      'https://docs.devin.ai/cli/extensibility/skills/overview',
      'https://docs.devin.ai/desktop/devin-local',
    ],
    checkedAt: '2026-10-17',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'AGENTS.local.md', 'AGENT.md', '.windsurfrules', 'CLAUDE.md'],
        nested: 'on-demand',
        nestedTrigger: 'when Devin accesses files in',
      },
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.(?:devin|windsurf)\/rules\/[^/]+\.md$/,
        rootPrefixes: ['.devin/rules/', '.windsurf/rules/'],
        decide: (fm) => {
          switch (str(fm.trigger).trim()) {
            case 'always_on':
              return { mode: 'always', trigger: 'trigger: always_on' };
            case 'model_decision':
              return { mode: 'on-demand', trigger: 'trigger: model_decision', descriptionOnly: true };
            case 'agent':
              return {
                mode: 'on-demand',
                trigger: 'trigger: agent',
                descriptionOnly: true,
                note: 'trigger: agent is assumed to be agent-decided from the description, like model_decision (not documented).',
              };
            case 'glob':
              return { mode: 'on-demand', trigger: `trigger: glob ${str(fm.globs)}`.trim() };
            case 'manual':
              return { mode: 'manual', trigger: 'trigger: manual' };
            default:
              return {
                mode: 'manual',
                trigger: 'no trigger set',
                note: 'Docs do not state the default when trigger is missing; not counted.',
              };
          }
        },
      },
      {
        kind: 'precedence',
        groups: [
          { label: '.devin/global_rules.md', patterns: [/^\.devin\/global_rules\.md$/] },
          { label: '.windsurf/global_rules.md', patterns: [/^\.windsurf\/global_rules\.md$/] },
        ],
      },
      { kind: 'frontmatter', pattern: /^\.cursor\/rules\/[^/]+\.mdc?$/, rootPrefixes: ['.cursor/rules/'], decide: cursorRule },
      ...['devin', 'windsurf', 'agents'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir}\\/skills\\/[^/]+\\/SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          bodyTrigger: 'when the skill is invoked',
        }),
      ),
      ...['claude', 'github'].map(
        (dir): FileRule => ({
          kind: 'skill',
          pattern: new RegExp(`^\\.${dir}\\/skills\\/(?:[^/]+\\/)+SKILL\\.md$`),
          rootPrefix: `.${dir}/skills/`,
          bodyTrigger: 'when the skill is invoked',
        }),
      ),
      {
        kind: 'skill',
        pattern: /^\.claude\/commands\/.+\.md$/,
        rootPrefix: '.claude/commands/',
        bodyTrigger: 'when the command is invoked',
      },
    ],
    limits: [],
    notes: [
      'New Devin Desktop (Windsurf) conversations start on Devin Local, which follows these Devin CLI rules; the Windsurf (Devin Desktop) entry covers the legacy Cascade agent.',
      'Imports from the AGENTS.md standard, Cursor, Windsurf, Claude Code and Copilot are on by default; turning one off with read_config_from is not modelled.',
      'Nested .devin/rules folders are assumed to load like nested .windsurf/rules (documented for .windsurf only); nested .cursor/rules, global_rules.md and skill folders are not counted.',
      'A skill with triggers: [user] is still counted as listed for the agent.',
      'Global rules (~/.config/devin/AGENTS.md, ~/.devin/rules/) are outside the repository; --include-user counts them. Devin CLI also reads ~/.claude/CLAUDE.md, which --include-user counts too.',
    ],
  },
];

export const TOOL_IDS = TOOLS.map((t) => t.id);

export function getTool(id: ToolId): ToolSpec {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
