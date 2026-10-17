# How turntax counts

`turntax` assumes the agent is started at the repository root. For each agent it sorts every instruction file into one of four modes:

- **always**: sent with every turn. This is the per-turn cost.
- **on-demand**: loaded when the agent works in a folder, touches a matching file, invokes a skill, or decides a rule is relevant.
- **manual**: loaded only when you reference it explicitly.
- **ignored**: the tool does not read the file in this repository's situation.

Skills and description-driven rules are split in two: the short description is always in context, the body loads on demand.

Rule folders inside a subdirectory (for example `packages/api/.claude/rules/` or `packages/api/.cursor/rules/`) are counted as on-demand: they apply only when the agent works in that folder. Skill folders inside a subdirectory are on-demand for agents that list them once they work there, and ignored for agents that look for them only from the launch directory up. Agents whose docs do not mention skill folders in subdirectories do not count them.

When an agent reads two skills with the same name at the same level, for example `.agents/skills/deploy/` and `.claude/skills/deploy/` (often symlinked copies), only the one from the folder that takes precedence is counted; the other is ignored with "same skill name as ...". A skill's name is its `name` frontmatter, else its folder name. The order is the agent's documented precedence; where its docs are silent, the order shown below is an assumption. Agents that list both copies (OpenAI Codex, GitHub Copilot) count both.

The rules below live in [`src/core/tools.ts`](../src/core/tools.ts). Each entry cites the page it came from; all were checked on 2026-10-17.

## Claude Code

Sources: [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents)

| File | Mode |
| --- | --- |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` at the root | always; block-level HTML comments are removed first; `@imports` are expanded up to four hops |
| `CLAUDE.md` in a subdirectory | on-demand, when Claude reads or edits a file there |
| `AGENTS.md` | always, but only when there is no root `CLAUDE.md` or `CLAUDE.local.md` (default setting); otherwise ignored unless imported |
| `.claude/rules/**/*.md` | always without `paths` frontmatter; on-demand with `paths` |
| `.claude/skills/*/SKILL.md`, `.claude/commands/**/*.md` | description (capped at 1,536 characters) always; body on-demand; `disable-model-invocation: true` keeps both out; a skill wins over a command of the same name |
| The same skill and command folders in a subdirectory | on-demand, once Claude reads or edits a file there |
| `.claude/agents/**/*.md` | description always; body is the subagent's own prompt |
| `.claude/agents/` in a subdirectory | ignored: Claude Code finds subagents only from the launch directory up |

Claude Code caps the skill listing at 1% of the context window and drops the descriptions of the least-used skills past it; that cap is not applied. Skills with `paths` frontmatter are counted like other skills, since how they are listed is not documented. Claude Code warns at startup when the subagent descriptions together pass 15,000 tokens.

## OpenAI Codex

Sources: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skills](https://learn.chatgpt.com/docs/build-skills)

| File | Mode |
| --- | --- |
| `AGENTS.override.md`, else `AGENTS.md`, at the root | always; reading stops at 32 KiB (`project_doc_max_bytes`) |
| The same files in a subdirectory | on-demand: only read when Codex is launched there |
| `.agents/skills/*/SKILL.md` | name, description and file path always; body when the skill is selected; same-name skills are both listed |
| `.agents/skills/` in a subdirectory | ignored: Codex reads skills from the launch directory up to the repository root |

The skill list is capped at 2% of the context window (8,000 characters when the window is unknown; `skills.max_context_tokens`); that cap is not applied. `.codex/skills` is not a Codex location.

## Gemini CLI

Sources: [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), [imports](https://geminicli.com/docs/reference/memport/), [skills](https://geminicli.com/docs/cli/skills/)

| File | Mode |
| --- | --- |
| `GEMINI.md` at the root | always, with `@file.md` imports up to five levels |
| `GEMINI.md` in a subdirectory | on-demand, when a tool accesses that folder |
| `.agents/skills/*/SKILL.md`, `.gemini/skills/*/SKILL.md` at the root | name and description always (`skills.enabled` is on by default); body when Gemini activates the skill; on a name clash `.agents/skills` wins |

`context.fileName` can make Gemini CLI read `AGENTS.md`; that setting is not modelled. Skill folders in subdirectories are not documented and not counted. Antigravity CLI replaced Gemini CLI for unpaid and Google One users on 2026-06-18.

## Cursor

Sources: [rules](https://cursor.com/docs/rules), [rules help](https://cursor.com/help/customization/rules), [skills](https://cursor.com/docs/skills)

| File | Mode |
| --- | --- |
| `.cursor/rules/**/*.mdc` | `alwaysApply: true` always; `globs` on-demand; `description` only: the description is given to the agent every turn, the body loads on-demand; neither: manual |
| `.cursor/rules/**/*.md` | ignored (Cursor only reads `.mdc`) |
| `.cursorrules` | always (legacy) |
| `AGENTS.md`, `CLAUDE.md` at the root | always |
| `AGENTS.md`, `CLAUDE.md` in a subdirectory | on-demand |
| `SKILL.md` anywhere below `.agents/skills/`, `.cursor/skills/`, `.claude/skills/` or `.codex/skills/` (category folders included) | description always; on-demand with `paths` (or the legacy `globs`) frontmatter; `disable-model-invocation: true` manual; body on-demand |
| The same skill folders in a subdirectory | on-demand, when the agent works with files there |

Which skill folder wins on a name clash is not documented; `.agents`, `.cursor`, `.claude`, `.codex` is assumed.

## GitHub Copilot

Sources: VS Code [custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), [settings](https://code.visualstudio.com/docs/agents/reference/ai-settings) and [skills](https://code.visualstudio.com/docs/agent-customization/agent-skills); GitHub [repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), [Copilot CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), [support by surface](https://docs.github.com/en/copilot/reference/custom-instructions-support) and [skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)

Copilot surfaces read different files. turntax models VS Code with its default settings:

| File | Mode |
| --- | --- |
| `.github/copilot-instructions.md` | always |
| `.github/instructions/**/*.instructions.md` | `applyTo` on-demand; `description` only: description always, body on-demand; neither: manual |
| `AGENTS.md` at the root | always (`chat.useAgentsMdFile`, on by default) |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` at the root | always (`chat.useClaudeMdFile`, on by default), together with `AGENTS.md` |
| `.claude/rules/**/*.md` | on-demand: `paths`, which defaults to `**` |
| `AGENTS.md` or `CLAUDE.md` in a subdirectory | ignored (nested `AGENTS.md` needs `chat.useNestedAgentsMdFiles`, off by default) |
| `GEMINI.md` | ignored |
| `.github/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | description always; body on-demand; `disable-model-invocation: true` manual; same-name skills in two folders are both counted |

Treating a description-only instructions file's description as always in context is an inference; VS Code says the agent decides from it. VS Code does not expand `@imports`. Other surfaces:

- Copilot CLI reads `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `GEMINI.md` from the repository root, the working directory, the folders between and the folders of files it works on, combines them all, and expands `@path` references in `copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md`.
- Copilot cloud agent uses the nearest `AGENTS.md`, or a single root `CLAUDE.md` or `GEMINI.md` instead.
- Copilot code review also reads `REVIEW.md` and uses only skills in `.github/skills`.

## Windsurf Cascade

Sources: [rules](https://docs.devin.ai/desktop/cascade/memories), [AGENTS.md](https://docs.devin.ai/desktop/cascade/agents-md), [skills](https://docs.devin.ai/desktop/cascade/skills)

| File | Mode |
| --- | --- |
| `.devin/rules/*.md`, `.windsurf/rules/*.md` | `trigger: always_on` always; `model_decision`: description always, body on-demand; `glob` on-demand; `manual` manual; no trigger: not counted and flagged |
| `.windsurfrules` | always (legacy) |
| `AGENTS.md` or `agents.md` | always at the root; nested ones apply to their folder |
| `.devin/skills/*/SKILL.md`, `.windsurf/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | name and description always; body when Cascade invokes the skill or it is @-mentioned |

Cascade is the legacy agent: new Devin Desktop conversations start on Devin Local, which follows the Devin CLI rules. Workspace rule files are limited to 12,000 characters each and the global rules file to 6,000. Which skill folder wins on a name clash is not documented; the order above is assumed. `.claude/skills` is read only with an opt-in setting whose default is not documented, so it is not counted.

## Cline

Sources: [Cline rules](https://docs.cline.bot/customization/cline-rules), [skills](https://docs.cline.bot/customization/skills)

| File | Mode |
| --- | --- |
| `.clinerules/**/*.md` (except `.clinerules/skills/`), `.cline/rules/**/*.md` | always without `paths`; on-demand with `paths`; `paths: []` never applies |
| `.cline/skills/*/SKILL.md`, `.clinerules/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md` | name and description always; body when Cline activates the skill |

Rules and skills can be toggled off in Cline; the audit assumes they are on (skills are on when discovered). Which project skill folder wins on a name clash is not documented; the order above is assumed. Cline also detects `AGENTS.md`, `.cursorrules` and `.windsurfrules`, but whether those are on by default is not documented, so they are not counted. A single `.clinerules` file is not counted for Cline.

## Roo Code

Sources: [custom instructions](https://roocodeinc.github.io/Roo-Code/features/custom-instructions), [skills](https://roocodeinc.github.io/Roo-Code/features/skills)

| File | Mode |
| --- | --- |
| `.roo/rules/**` | always |
| `.roo/rules-{mode}/**`, `.roorules-{mode}` | on-demand: only in that mode |
| `.roorules`, then `.clinerules` (order assumed) | always, only when `.roo/rules/` is empty or missing |
| `AGENTS.md`, else `AGENT.md`, at the root | always (the `roo-cline.useAgentRules` setting turns it off) |
| `.roo/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | name and description always; body when used; `.roo` wins on a name clash |
| `.roo/skills-{mode}/*/SKILL.md`, `.agents/skills-{mode}/*/SKILL.md` | on-demand: only in that mode |

Roo also skips the legacy `.roorules` and `.clinerules` when the global `~/.roo/rules/` has content; that case is not modelled.

## Kiro

Sources: [steering](https://kiro.dev/docs/steering/), [skills](https://kiro.dev/docs/skills/)

| File | Mode |
| --- | --- |
| `.kiro/steering/*.md` | `inclusion: always` (the default) always; `fileMatch` on-demand; `manual` manual; `auto`: description always, body on-demand; an unknown value is counted as always |
| `AGENTS.md` at the root and in subdirectories | always: Kiro loads every `AGENTS.md` as steering |
| `.kiro/skills/*/SKILL.md` | name and description always; body when Kiro activates the skill |

`#[[file:...]]` and `#[[folder:...]]` references in steering files are not followed.

## JetBrains Junie

Sources: [guidelines and memory](https://junie.jetbrains.com/docs/guidelines-and-memory.html), [skills](https://junie.jetbrains.com/docs/agent-skills.html)

Junie CLI loads the first of these that exists every turn; the others are ignored:

1. `.junie/AGENTS.md` (used on its own)
2. `AGENTS.md`, together with `.junie/playbook.md` and `.junie/rules/*.md`
3. `.junie/guidelines.md` or `.junie/guidelines/*.md` (deprecated)

Skills in `.junie/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` (the latter only in trusted projects): name and description always, body when used. Which folder wins on a name clash is not documented; `.junie/skills` is assumed.

## Zed

Sources: [instructions](https://zed.dev/docs/ai/instructions), [skills](https://zed.dev/docs/ai/skills)

Zed loads the first of these at the project root, every turn: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. The others are ignored.

Skills in `.agents/skills/*/SKILL.md` (direct children only): name and description always, body when used; `disable-model-invocation: true` keeps a skill out of the catalog. Zed caps the catalog at 50 KB (not applied) and loads project skills only in trusted worktrees.

## Continue

Source: [rules](https://docs.continue.dev/customize/deep-dives/rules)

| File | Mode |
| --- | --- |
| `.continue/rules/*.md` | `alwaysApply: true` always; `globs` on-demand; `alwaysApply: false` with only a `description`: description always, body on-demand; no frontmatter: always |

Rules in `config.yaml` and from the Continue hub are not counted. `regex` frontmatter (a rule included when a file in context matches it) is not modelled.

## Aider

Source: [conventions](https://aider.chat/docs/usage/conventions.html)

| File | Mode |
| --- | --- |
| Files listed under `read:` in `.aider.conf.yml` | always |
| `CONVENTIONS.md` | manual: only with `--read` or `/read` |

## Goose

Sources: [goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints), [skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills)

| File | Mode |
| --- | --- |
| `AGENTS.md`, `.goosehints` at the root | always (needs the Developer extension); files referenced with `@` are included |
| The same files in a subdirectory | on-demand, when goose accesses files there |
| `.agents/skills/*/SKILL.md`, `.goose/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md` | name and description always; body when goose loads the skill |

Following `@` references one level deep, and the skill folder order on a name clash, are assumptions.

## Amp

Sources: [AGENTS.md](https://ampcode.com/docs/customize/agents-md), [skills](https://ampcode.com/docs/customize/skills)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root (or `AGENT.md` / `CLAUDE.md` when there is no `AGENTS.md`) | always |
| The same files in a subdirectory | on-demand, when Amp reads a file there |
| Files @-mentioned in them | always, or on-demand when they have `globs` frontmatter |
| `SKILL.md` up to five folders below `.agents/skills/` or `.claude/skills/` | name and description always; body when Amp loads the skill; the first skill of a name wins |

Glob @-mentions such as `@doc/*.md` are not expanded. `amp.skills.disableClaudeCodeSkills` turns off the `.claude/skills` folders.

## OpenCode

Sources: [rules](https://opencode.ai/docs/rules/), [skills](https://opencode.ai/docs/skills/)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root, or `CLAUDE.md` when there is none | always |
| `.opencode/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | name and description always; body when the agent loads the skill |
| The same skill folders in a subdirectory | ignored: OpenCode reads skills from the launch directory up |

Files listed under `instructions` in `opencode.json` are not counted. When subdirectory `AGENTS.md` files load is not documented, so they are not counted. Which skill folder wins on a name clash is not documented; the order above is assumed.

<!-- new agents -->

## User-level files

With `--include-user`, files in the home directory are classified by the same rules as their project counterpart, for each agent that reads them. Checked on 2026-10-17.

| File | Agent | Read as |
| --- | --- | --- |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/agents/` | Claude Code ([memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents)) | the same paths at the root |
| `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md` | OpenAI Codex ([AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) | root `AGENTS.override.md` / `AGENTS.md` |
| `~/.agents/skills/` | OpenAI Codex, Gemini CLI, Cursor, GitHub Copilot, Windsurf Cascade, Roo Code, JetBrains Junie, Zed, Goose, Amp, OpenCode (skills pages above) | `.agents/skills` |
| `~/.gemini/GEMINI.md`, `~/.gemini/skills/` | Gemini CLI ([GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), [skills](https://geminicli.com/docs/cli/skills/)) | root `GEMINI.md`, `.gemini/skills` |
| `~/.cursor/skills/`, `~/.claude/skills/`, `~/.codex/skills/` | Cursor ([skills](https://cursor.com/docs/skills)) | the same folders |
| `~/.copilot/copilot-instructions.md`, `~/.copilot/instructions/**/*.instructions.md`, `~/.copilot/skills/` | GitHub Copilot ([instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), [skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)) | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/skills` |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/` | GitHub Copilot in VS Code ([instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), [settings](https://code.visualstudio.com/docs/agents/reference/ai-settings)) | the same paths |
| `~/.codeium/windsurf/memories/global_rules.md` | Windsurf Cascade ([rules](https://docs.devin.ai/desktop/cascade/memories)) | always loaded; limited to 6,000 characters |
| `~/.codeium/windsurf/skills/`, `~/.config/devin/skills/` | Windsurf Cascade ([skills](https://docs.devin.ai/desktop/cascade/skills)) | `.windsurf/skills`, `.devin/skills` |
| `~/Documents/Cline/Rules/`, `~/Cline/Rules/`, `~/.cline/rules/` | Cline ([rules](https://docs.cline.bot/customization/cline-rules)) | `.clinerules/` |
| `~/.cline/skills/` | Cline ([skills](https://docs.cline.bot/customization/skills)) | `.cline/skills` |
| `~/.roo/rules/`, `~/.roo/rules-{mode}/`, `~/.roo/skills/`, `~/.roo/skills-{mode}/`, `~/.agents/skills-{mode}/` | Roo Code ([instructions](https://roocodeinc.github.io/Roo-Code/features/custom-instructions), [skills](https://roocodeinc.github.io/Roo-Code/features/skills)) | the same paths |
| `~/.kiro/steering/*.md` (including `AGENTS.md`), `~/.kiro/skills/` | Kiro ([steering](https://kiro.dev/docs/steering/), [skills](https://kiro.dev/docs/skills/)) | `.kiro/steering/`, `.kiro/skills` |
| `~/.junie/AGENTS.md`, `~/.junie/skills/` | JetBrains Junie ([guidelines](https://junie.jetbrains.com/docs/guidelines-and-memory.html), [skills](https://junie.jetbrains.com/docs/agent-skills.html)) | `.junie/AGENTS.md`, `.junie/skills` |
| `~/.config/zed/AGENTS.md` (`%APPDATA%\Zed\AGENTS.md` on Windows) | Zed ([instructions](https://zed.dev/docs/ai/instructions)) | root `AGENTS.md`, in addition to the project file |
| `~/.config/goose/.goosehints`, `~/.config/goose/AGENTS.md`, `~/.claude/skills/` | Goose ([goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints), [skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills)) | root `.goosehints` / `AGENTS.md`, `.claude/skills` |
| `~/.config/AGENTS.md` and `~/.config/amp/AGENTS.md` (both) | Amp ([AGENTS.md](https://ampcode.com/docs/customize/agents-md)) | root `AGENTS.md` |
| `~/.config/agents/skills/`, `~/.config/amp/skills/`, `~/.claude/skills/` | Amp ([skills](https://ampcode.com/docs/customize/skills)) | `.agents/skills`, `.claude/skills` |
| `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md` | OpenCode ([rules](https://opencode.ai/docs/rules/)) | root `AGENTS.md` / `CLAUDE.md` |
| `~/.config/opencode/skills/`, `~/.claude/skills/` | OpenCode ([skills](https://opencode.ai/docs/skills/)) | `.opencode/skills`, `.claude/skills` |

`@imports` inside user-level files are not followed. Same-name skills are not resolved between user-level and repository folders, where an agent's personal skill may replace a project skill. Continue keeps user rules in `~/.continue/config.yaml` and Cursor in app settings; those are not counted.

## MCP servers

Sources are listed in [`src/core/mcp.ts`](../src/core/mcp.ts); checked on 2026-10-11.

- Configs are read for Claude Code (`.mcp.json`; `~/.claude.json` top-level and `projects[<repo path>]` servers), Cursor, VS Code / Copilot (`servers` key), Gemini CLI (`url` is SSE, `httpUrl` is streamable HTTP), Kiro, Roo Code, OpenAI Codex (`[mcp_servers.<name>]` in `config.toml`), OpenCode (`mcp` key), Zed (`context_servers`) and Windsurf (`~/.config/devin/mcp_config.json`, `%APPDATA%\devin\mcp_config.json`).
- A server with `disabled: true` or `enabled: false` is listed as disabled and not started.
- `--mcp` sends `initialize`, `notifications/initialized` and `tools/list` (all pages). The definitions are counted as one JSON object per tool (`name`, `description`, `input_schema`) with o200k. Agents wrap tool definitions in their own format, so this is an estimate.
- Claude Code defers MCP tool definitions to tool search by default ([MCP docs](https://code.claude.com/docs/en/mcp)): only tool names count per turn, and the full size is shown as loading on use. `alwaysLoad: true` on a server counts it in full. Setting `ENABLE_TOOL_SEARCH=false` or using a non-first-party API host turns deferral off; `turntax` does not read those settings.
- Server instructions and resources are not counted.

## Token counts

- **o200k**: OpenAI `o200k_base`, counted offline with [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer). OpenAI's tiktoken maps GPT-4o, GPT-4.1, GPT-5.x and o-series models to it, and gpt-oss to `o200k_harmony`, which gives the same counts for plain text. GPT-6.x has no published encoding, so its counts are labelled estimates.
- **Claude**: `POST /v1/messages/count_tokens`. Each file is sent as a system prompt next to a one-character user message, and the same request without the system prompt is subtracted.
- **Gemini**: `models/{model}:countTokens` with the file as user content.
- Text is counted per file and summed; joining files changes the total by a few tokens at most.

## Prices

[`src/core/prices.ts`](../src/core/prices.ts) holds USD per 1M input and cache-read tokens for the shortest-context tier, with the pricing page and the date checked for each model. Long-context tiers, cache-write premiums and cache storage fees are not included. `turntax --list-models --json` prints the table in the format `--prices` accepts.
