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
      nested: 'on-demand' | 'ignored';
      nestedTrigger: string;
      stripHtmlComments?: boolean;
      /** Maximum @import depth, when the tool expands @path imports. */
      importDepth?: number;
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
    };

export interface SizeLimit {
  /** Applies to files matching this pattern. */
  pattern: RegExp;
  unit: 'lines' | 'chars' | 'bytes';
  max: number;
  /** "hard" limits drop content; "advice" limits are vendor recommendations. */
  severity: 'hard' | 'advice';
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
        severity: 'hard',
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
        note: 'Copilot docs allow a single root CLAUDE.md or GEMINI.md as an alternative to AGENTS.md.',
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
        severity: 'hard',
        text: 'Windsurf limits workspace rule files to 12,000 characters each.',
        source: 'https://docs.devin.ai/desktop/cascade/memories',
      },
    ],
    notes: ['Global rules (~/.codeium/windsurf/memories/global_rules.md) are outside the repository and not counted.'],
  },
];

export const TOOL_IDS = TOOLS.map((t) => t.id);

export function getTool(id: ToolId): ToolSpec {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
