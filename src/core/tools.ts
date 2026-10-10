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
      /** 'skip' when the docs do not say when subdirectory copies load; they are then left out. */
      nested: 'on-demand' | 'ignored' | 'skip';
      nestedTrigger: string;
      stripHtmlComments?: boolean;
      /** Maximum @import depth, when the tool expands @path imports. */
      importDepth?: number;
      /** Imported files with `globs` frontmatter load only when a matching file is read (Amp). */
      importGlobs?: boolean;
      /** Bytes read before the tool stops (content beyond is dropped). */
      maxBytes?: number;
      /** Only read when the condition holds for the repository. */
      condition?: 'claude-reads-agents-md' | 'copilot-no-agents-md';
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
      /** Directory prefix that counts as "root"; matches elsewhere load on demand. */
      rootPrefix: string;
      /** Characters of the description kept in the listing. */
      descriptionCap?: number;
      /** Frontmatter flag that removes the description from context. */
      hideFlag?: string;
      bodyTrigger: string;
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
    checkedAt: '2026-10-10',
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
      },
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.claude\/commands\/.+\.md$/,
        rootPrefix: '.claude/commands/',
        descriptionCap: 1536,
        hideFlag: 'disable-model-invocation',
        bodyTrigger: 'when the command is invoked',
      },
      {
        kind: 'skill',
        pattern: /^(?:.*\/)?\.claude\/agents\/[^/]+\.md$/,
        rootPrefix: '.claude/agents/',
        bodyTrigger: "as the subagent's own system prompt when it runs",
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
      'User (~/.claude/CLAUDE.md), managed policy and auto-memory files live outside the repository and are not counted.',
      'With the "claude-md-and-agents-md" setting Claude Code reads AGENTS.md as well; the default reads it only when no CLAUDE.md exists.',
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
    checkedAt: '2026-10-10',
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
        kind: 'skill',
        pattern: /^(?:.*\/)?\.agents\/skills\/[^/]+\/SKILL\.md$/,
        rootPrefix: '.agents/skills/',
        bodyTrigger: 'when the skill is selected',
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
    notes: ['Global ~/.codex/AGENTS.md is outside the repository and not counted.'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    families: ['gemini'],
    sources: ['https://geminicli.com/docs/cli/gemini-md/'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'hierarchical',
        names: ['GEMINI.md'],
        nested: 'on-demand',
        nestedTrigger: 'when a tool accesses',
        // The docs describe @file.md imports but not a depth limit; deeper chains are rare.
        importDepth: 5,
      },
    ],
    limits: [],
    notes: [
      'Only GEMINI.md is read by default; context.fileName can add AGENTS.md (not modelled).',
      'Global ~/.gemini/GEMINI.md is outside the repository and not counted.',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    families: [],
    sources: ['https://cursor.com/docs/context/rules', 'https://cursor.com/help/customization/rules'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^(?:.*\/)?\.cursor\/rules\/.+\.mdc$/,
        rootPrefixes: ['.cursor/rules/'],
        decide: (fm) => {
          if (fm.alwaysApply === true || str(fm.alwaysApply) === 'true')
            return { mode: 'always', trigger: 'alwaysApply: true' };
          if (has(fm, 'globs')) return { mode: 'on-demand', trigger: `globs: ${str(fm.globs)}` };
          if (has(fm, 'description'))
            return {
              mode: 'on-demand',
              trigger: 'agent decides from description',
              descriptionOnly: true,
              note: 'Description assumed to be in context so the agent can decide (inferred, not documented).',
            };
          return { mode: 'manual', trigger: '@-mention only' };
        },
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
    ],
    limits: [
      {
        pattern: /\.mdc$/,
        unit: 'lines',
        max: 500,
        severity: 'advice',
        text: 'Cursor docs recommend keeping each rule under 500 lines.',
        source: 'https://cursor.com/docs/context/rules',
      },
    ],
    notes: ['User and Team rules are configured in Cursor settings, not in the repository, and are not counted.'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    families: [],
    sources: [
      'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
      'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
    ],
    checkedAt: '2026-10-10',
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
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'on-demand',
        nestedTrigger: 'nearest AGENTS.md wins when working in',
      },
      {
        kind: 'hierarchical',
        names: ['CLAUDE.md', 'GEMINI.md'],
        onePerDirectory: true,
        nested: 'ignored',
        nestedTrigger: '',
        condition: 'copilot-no-agents-md',
        note: 'Copilot docs allow a single root CLAUDE.md or GEMINI.md as an alternative to AGENTS.md. When both exist the docs do not say which wins; CLAUDE.md is assumed.',
      },
    ],
    limits: [],
    notes: ['Support for AGENTS.md and CLAUDE.md differs by Copilot surface and VS Code settings.'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf (Devin Desktop)',
    families: [],
    sources: ['https://docs.devin.ai/desktop/cascade/memories'],
    checkedAt: '2026-10-10',
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
      {
        kind: 'hierarchical',
        names: ['AGENTS.md'],
        nested: 'on-demand',
        nestedTrigger: 'auto-glob for files in',
      },
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
    ],
    notes: ['Global rules (~/.codeium/windsurf/memories/global_rules.md) are outside the repository and not counted.'],
  },
  {
    id: 'cline',
    name: 'Cline',
    families: [],
    sources: ['https://docs.cline.bot/features/cline-rules'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'frontmatter',
        pattern: /^\.(?:clinerules|cline\/rules)\/.+\.md$/,
        rootPrefixes: ['.clinerules/', '.cline/rules/'],
        decide: (fm) => {
          if (Array.isArray(fm.paths) && fm.paths.length === 0) return { mode: 'ignored', trigger: 'paths: [] (never applies)' };
          if (has(fm, 'paths')) return { mode: 'on-demand', trigger: `paths: ${str(fm.paths)}` };
          return { mode: 'always', trigger: 'rule without paths' };
        },
      },
    ],
    limits: [],
    notes: [
      'Each rule can be toggled off in Cline; the audit assumes rules are on.',
      'Cline also detects AGENTS.md, .cursorrules and .windsurfrules; whether they are on by default is not documented, so they are not counted.',
      'A single .clinerules file (instead of a folder) is not documented and is not counted.',
    ],
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    families: [],
    sources: ['https://roocodeinc.github.io/Roo-Code/features/custom-instructions'],
    checkedAt: '2026-10-10',
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
    ],
    limits: [],
    notes: ['Global ~/.roo/rules/ is outside the repository and not counted.'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    families: [],
    sources: ['https://kiro.dev/docs/steering/'],
    checkedAt: '2026-10-10',
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
      { kind: 'hierarchical', names: ['AGENTS.md'], nested: 'skip', nestedTrigger: '' },
    ],
    limits: [],
    notes: [
      'fileMatch and manual modes need Kiro CLI V3; older versions skip those files.',
      'Global ~/.kiro/steering/ is outside the repository and not counted.',
    ],
  },
  {
    id: 'junie',
    name: 'JetBrains Junie',
    families: [],
    sources: ['https://junie.jetbrains.com/docs/guidelines-and-memory.html'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'precedence',
        groups: [
          { label: '.junie/AGENTS.md', patterns: [/^\.junie\/AGENTS\.md$/] },
          { label: 'AGENTS.md', patterns: [/^AGENTS\.md$/, /^\.junie\/playbook\.md$/, /^\.junie\/rules\/[^/]+\.md$/] },
          { label: '.junie/guidelines', patterns: [/^\.junie\/guidelines\.md$/, /^\.junie\/guidelines\/[^/]+\.md$/] },
        ],
        note: 'Follows the IDE plugin order; a custom guidelines path set in project settings is not modelled.',
      },
    ],
    limits: [],
    notes: ['Global ~/.junie/AGENTS.md is outside the repository and not counted.'],
  },
  {
    id: 'zed',
    name: 'Zed',
    families: [],
    sources: ['https://zed.dev/docs/ai/instructions'],
    checkedAt: '2026-10-10',
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
    ],
    limits: [],
    notes: ['Personal ~/.config/zed/AGENTS.md is outside the repository and not counted.'],
  },
  {
    id: 'continue',
    name: 'Continue',
    families: [],
    sources: ['https://docs.continue.dev/customize/deep-dives/rules'],
    checkedAt: '2026-10-10',
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
    notes: ['Rules in config.yaml or from the Continue hub are not counted.'],
  },
  {
    id: 'aider',
    name: 'Aider',
    families: [],
    sources: ['https://aider.chat/docs/usage/conventions.html'],
    checkedAt: '2026-10-10',
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
    sources: ['https://goose-docs.ai/docs/guides/context-engineering/using-goosehints'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', '.goosehints'],
        nested: 'on-demand',
        nestedTrigger: 'when goose accesses files in',
      },
    ],
    limits: [],
    notes: [
      'Needs the Developer extension; CONTEXT_FILE_NAMES can change which files are read.',
      'Global ~/.config/goose/.goosehints is outside the repository and not counted.',
    ],
  },
  {
    id: 'amp',
    name: 'Amp',
    families: [],
    sources: ['https://ampcode.com/docs/customize/agents-md'],
    checkedAt: '2026-10-10',
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
    ],
    limits: [],
    notes: ['User and system AGENTS.md files (~/.config/amp, /etc/ampcode) are outside the repository and not counted.'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    families: [],
    sources: ['https://opencode.ai/docs/rules/'],
    checkedAt: '2026-10-10',
    rules: [
      {
        kind: 'hierarchical',
        names: ['AGENTS.md', 'CLAUDE.md'],
        onePerDirectory: true,
        nested: 'skip',
        nestedTrigger: '',
        note: 'CLAUDE.md is read only when there is no AGENTS.md.',
      },
    ],
    limits: [],
    notes: ['Extra files listed under instructions in opencode.json are not counted.'],
  },
];

export const TOOL_IDS = TOOLS.map((t) => t.id);

export function getTool(id: ToolId): ToolSpec {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
