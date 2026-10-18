# How turntax counts

`turntax` assumes the agent is started at the repository root. For each agent it sorts every instruction file into one of four modes:

- **always**: sent with every turn. This is the per-turn cost.
- **on-demand**: loaded when the agent works in a folder, touches a matching file, invokes a skill, or decides a rule is relevant.
- **manual**: loaded only when you reference it explicitly.
- **ignored**: the tool does not read the file in this repository's situation.

Skills and description-driven rules are split in two: the short description is always in context, the body loads on demand.

Rule folders inside a subdirectory (for example `packages/api/.claude/rules/` or `packages/api/.cursor/rules/`) are counted as on-demand: they apply only when the agent works in that folder. Skill folders inside a subdirectory are on-demand for agents that list them once they work there, and ignored for agents that look for them only from the launch directory up. Agents whose docs do not mention skill folders in subdirectories do not count them.

When an agent reads two skills with the same name at the same level, for example `.agents/skills/deploy/` and `.claude/skills/deploy/` (often symlinked copies), only the one from the folder that takes precedence is counted; the other is ignored with "same skill name as ...". A skill's name is its `name` frontmatter, else its folder name. The order is the agent's documented precedence; where its docs are silent, the order shown below is an assumption. Agents that list both copies (OpenAI Codex, GitHub Copilot, Devin Local / Devin CLI, and Warp, which also lists each skill's path) count both.

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
| `.agents/skills` and `.cursor/skills` in a subdirectory | on-demand, when the agent works with files there (the docs name only these two for subdirectories) |

Which skill folder wins on a name clash is not documented; `.agents`, `.cursor`, `.claude`, `.codex` is assumed.

## GitHub Copilot

Sources: VS Code [custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), [settings](https://code.visualstudio.com/docs/agents/reference/ai-settings) and [skills](https://code.visualstudio.com/docs/agent-customization/agent-skills); GitHub [repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), [Copilot CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), [support by surface](https://docs.github.com/en/copilot/reference/custom-instructions-support) and [skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)

Copilot surfaces read different files. turntax models the defaults of VS Code's Local harness (the `chat.useAgentsMdFile`, `chat.useClaudeMdFile` and `chat.useNestedAgentsMdFiles` settings are documented for Local harness sessions):

| File | Mode |
| --- | --- |
| `.github/copilot-instructions.md` | always |
| `.github/instructions/**/*.instructions.md` | `applyTo` on-demand; `description` only: description always, body on-demand; neither: manual |
| `AGENTS.md` at the root | always (`chat.useAgentsMdFile`, on by default) |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` at the root | always (`chat.useClaudeMdFile`, on by default), together with `AGENTS.md` |
| `.claude/rules/**/*.md` | on-demand: `paths`, which defaults to `**` |
| `AGENTS.md` or `CLAUDE.md` in a subdirectory | ignored (nested `AGENTS.md` needs `chat.useNestedAgentsMdFiles`, off by default) |
| `.github/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | description always; body on-demand; `disable-model-invocation: true` manual; same-name skills in two folders are both counted |

Treating a description-only instructions file's description as always in context is an inference; VS Code says the agent decides from it. VS Code does not expand `@imports`. Other surfaces:

- Copilot CLI reads `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `GEMINI.md` from the repository root, the working directory, the folders between and the folders of files it works on, combines them all, and expands `@path` references in `copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md`.
- Copilot cloud agent uses the nearest `AGENTS.md`, or a single root `CLAUDE.md` or `GEMINI.md` instead.
- VS Code's Copilot harness shares the Copilot CLI runtime ([agent harnesses](https://code.visualstudio.com/docs/agents/concepts/agent-harnesses)), so it is assumed to read what the CLI reads, `GEMINI.md` included. `GEMINI.md` is not counted for Copilot, because the Local harness modelled here does not document it.
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
| Files @-mentioned in them, globs such as `@doc/*.md` included | always, or on-demand when they have `globs` frontmatter |
| `SKILL.md` up to five folders below `.agents/skills/` or `.claude/skills/` | name and description always; body when Amp loads the skill; the first skill of a name wins |

A glob mention pulls in every matching file, relative to the file that mentions it. `amp.skills.disableClaudeCodeSkills` turns off the `.claude/skills` folders.

## OpenCode

Sources: [rules](https://opencode.ai/docs/rules/), [skills](https://opencode.ai/docs/skills/)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root, or `CLAUDE.md` when there is none | always |
| `.opencode/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | name and description always; body when the agent loads the skill |
| The same skill folders in a subdirectory | ignored: OpenCode reads skills from the launch directory up |

Files listed under `instructions` in `opencode.json` are not counted. When subdirectory `AGENTS.md` files load is not documented, so they are not counted. Which skill folder wins on a name clash is not documented; the order above is assumed.


## Warp

Sources: [rules](https://docs.warp.dev/agents/capabilities/rules/), [skills](https://docs.warp.dev/agents/capabilities/skills/), [Agent CLI](https://docs.warp.dev/agents/cli/configuration/)

| File | Mode |
| --- | --- |
| `WARP.md`, else `AGENTS.md`, at the root | always (all caps only; `WARP.md` wins in the same folder) |
| The same files in a subdirectory | on-demand: best effort when Warp edits files there |
| `.agents`, `.warp`, `.claude`, `.codex`, `.cursor`, `.gemini`, `.copilot`, `.factory`, `.github`, `.opencode` + `/skills/*/SKILL.md` | name and description always; body when the skill is used; skill folders in a subdirectory only when working there |

Warp does not read `CLAUDE.md`, `.cursorrules` or similar files by name; `/init` can link them to `AGENTS.md`. Global Rules live in Warp Drive and are not counted. With `--include-user`, `~/.agents/AGENTS.md` (Warp Agent CLI) and the same skill folders in the home directory are counted.

## Factory Droid

Sources: [AGENTS.md](https://docs.factory.com/harness/agents-md), [skills](https://docs.factory.com/harness/skills), [custom droids](https://docs.factory.com/harness/subagents), [custom commands](https://docs.factory.com/harness/custom-slash-commands), [output styles](https://docs.factory.com/droid-cli/output-styles)

| File | Mode |
| --- | --- |
| `AGENTS.md`, `agents.md`, `Agents.md`, `CLAUDE.md`, `Claude.md` at the root or in `.factory/`, `.agents/`, `.agent/` | always; every file found is assumed to be read |
| The same files in a subdirectory | on-demand, when Droid reads files there |
| `DESIGN.md`, `Design.md`, `design.md` at the root | always (where Droid looks for them is not documented, so only the root copy is counted) |
| `.factory/skills/**/SKILL.md`, `.agents/skills/**/SKILL.md`, `.agent/skills/**/SKILL.md` | name and description always; body when the skill is invoked; `disable-model-invocation: true` is assumed to keep the description out; `.factory/skills` in a subdirectory only when working there |
| `.factory/droids/*.md` | description always (assumed, for the Task tool); body is the droid's own prompt |
| `.factory/commands/**/*.md`, `.factory/output-styles/*.md` | manual |

Droid keeps one effective version of a skill name; the folder order `.factory`, `.agents`, `.agent` is assumed. Factory caps the AGENTS-style files loaded at startup at 80,000 characters together (40,000 for files found later); `turntax` flags single files over 80,000 characters. Skills turned off with `enabled: false` or `disabledSkills` are still counted. `.claude/skills`, `.claude/agents` and `.claude/commands` are only imported on request, not read in place. With `--include-user`, the same files in `~/.factory/`, `~/.agents/` and `~/.agent/` are counted (the file names there are assumed).

## TRAE

Sources: [rules](https://docs.trae.ai/ide/rules?_lang=en), [skills](https://docs.trae.ai/ide/skills?_lang=en), [slash commands](https://docs.trae.ai/ide/slash-commands?_lang=en), [subagents](https://docs.trae.ai/ide/subagents?_lang=en)

| File | Mode |
| --- | --- |
| `.trae/rules/**/*.md`, up to three folder levels deep | `alwaysApply: true` always; `alwaysApply: false` with `globs` on-demand; with only a `description`: description always, body on-demand; with neither: manual (`#Rule`); no `alwaysApply`: manual (the default is not documented) |
| `.trae/rules/` files four or more folder levels deep | ignored and flagged |
| `.trae/rules/` in a subdirectory | on-demand, when files there are read or mentioned |
| `.trae/skills/*/SKILL.md` | name and description always; body when the agent loads the skill |
| `.trae/agents/*.md` | manual: read only with its switch in Settings on, and the default is not documented |
| `.trae/commands/**/*.md` | manual |

`AGENTS.md` (root, and nested when files there are read or mentioned), the root `CLAUDE.md` and `CLAUDE.local.md`, and `.agents/skills` are read only with their switches in Settings on ("Include AGENTS.md in the context", "Include CLAUDE.md in context", "Enable .agents Skills Directory"); the defaults are not documented, so they are not counted. Global rules in `~/.trae/user_rules` have no documented file format and are not counted; with `--include-user`, `~/.trae/skills/` is.

## Augment Code

Sources: [rules and guidelines](https://docs.augmentcode.com/setup-augment/guidelines), [CLI rules](https://docs.augmentcode.com/cli/rules), [CLI skills](https://docs.augmentcode.com/cli/skills), [IDE skills](https://docs.augmentcode.com/using-augment/skills), [custom commands](https://docs.augmentcode.com/cli/custom-commands), [subagents](https://docs.augmentcode.com/cli/subagents)

| File | Mode |
| --- | --- |
| `AGENTS.md` and `CLAUDE.md` at the root | always (both are read) |
| `AGENTS.md` and `CLAUDE.md` in a subdirectory | on-demand, when Augment works on a file there |
| `.augment-guidelines` | always |
| `.augment/rules/**/*.md` at the root | `type: always_apply` or no type: always; `agent_requested`: description always, body on-demand (flagged without a description); `manual`: manual (the CLI skips it); an unknown type is counted as always and flagged |
| `.augment/rules/` in a subdirectory | ignored and flagged (only the workspace root is read) |
| `.augment/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | name and description always; body when the skill is activated; a name found in several folders counts once (`.augment` over `.claude` over `.agents`, as documented) |
| `.augment/agents/*.md` | description always (assumed); body is the subagent's own prompt |
| `.augment/commands/`, `.claude/commands/`, `.agents/commands/`, `.cursor/commands/` | manual |

Workspace guidelines and rules are limited to 49,512 characters together; `turntax` flags single files over the limit. VS Code skills are a beta with modes whose default is not documented, so the CLI behaviour is counted. With `--include-user`, `~/.augment/rules/` and `~/.augment/user-guidelines.md` count as always (user rules ignore their frontmatter), plus the user skill and subagent folders.

## Kilo Code

Sources: [custom instructions](https://kilo.ai/docs/customize/custom-instructions), [AGENTS.md](https://kilo.ai/docs/customize/agents-md), [custom rules](https://kilo.ai/docs/customize/custom-rules), [skills](https://kilo.ai/docs/customize/skills), [workflows](https://kilo.ai/docs/customize/workflows), [subagents](https://kilo.ai/docs/customize/custom-subagents), [migrating](https://kilo.ai/docs/getting-started/migrating), [Cloud Agents](https://kilo.ai/docs/code-with-ai/platforms/cloud-agent), [rules migration (GitHub)](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/docs/rules-migration.md), [skill loading (GitHub)](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/skill/index.ts)

| File | Mode |
| --- | --- |
| The first of `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CONTEXT.md` at the root (order after `AGENT.md` assumed from the source) | always; the others are ignored |
| `AGENTS.md` in a subdirectory | on-demand, when the Read tool opens a file there |
| `.kilo/rules/*.md`, `.kilocode/rules/*.md`, `.kilocoderules` | always |
| `.kilo/rules-{mode}/*.md`, `.kilocode/rules-{mode}/*.md`, `.kilocoderules-{mode}` | on-demand: only in that mode |
| `.kilo/skills/`, `.kilocode/skills/`, `.agents/skills/`, `.claude/skills/` + `*/SKILL.md` | name and description always; body when the agent uses the skill; of skills with the same name, the first folder in this order wins (from the source) |
| `.kilo/agents/*.md`, `.kilo/agent/*.md`, `.kilocode/agents/*.md` | description always (assumed, for the Task tool); body is the agent's own prompt |
| `.kilo/commands/**/*.md` | manual |

Kilo's docs disagree in places, and `turntax` follows the user-facing pages: the custom rules page adds `.kilo/rules` files through `instructions` in `kilo.jsonc`, while the migration guide and the source read `.kilo/rules` and `.kilocode/rules` automatically; the user docs load mode rules only in their mode, while the GitHub migration doc loads them in every mode. Files under `instructions` in `kilo.json(c)` and nested `CLAUDE.md` or `CONTEXT.md` files are not counted. In VS Code, `.claude/skills` are read only with Claude Code Compatibility on. With `--include-user`, `~/.config/kilo/AGENTS.md`, `~/.kilo/rules/`, `~/.kilocode/rules/`, the user skill folders and `~/.config/kilo/agents/` are counted; the `~/.claude/CLAUDE.md` fallback is not.

## Google Jules

Sources: [getting started](https://jules.google/docs/), [environment](https://jules.google/docs/environment/), [changelog](https://jules.google/docs/changelog/)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root | always (assumed for every task) |

Jules runs each task in a cloud VM. Setup scripts, MCP connections and memories are configured in the Jules web app and are not counted. When subdirectory `AGENTS.md` files load is not documented, so they are not counted.

## Devin Local / Devin CLI

Sources: [rules](https://docs.devin.ai/cli/extensibility/rules), [configuration import](https://docs.devin.ai/cli/reference/configuration/read-config-from), [skills](https://docs.devin.ai/cli/extensibility/skills/overview), [Devin Local](https://docs.devin.ai/desktop/devin-local), [changelog](https://docs.devin.ai/cli/changelog/stable)

New Devin Desktop (Windsurf) conversations start on Devin Local, which follows the Devin CLI rules below; the Windsurf entry above covers the legacy Cascade agent.

| File | Mode |
| --- | --- |
| `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md` at the root | always (all are read) |
| The same files in a subdirectory | on-demand, when Devin accesses files there |
| `.devin/rules/*.md`, `.windsurf/rules/*.md` | `trigger: always_on` always; `model_decision` or `agent` (assumed alike): description always, body on-demand; `glob` on-demand; `manual` or no trigger: manual (not counted); nested `.devin/rules` are not read when Devin starts at the root, nested `.windsurf/rules` only when working there |
| `.devin/global_rules.md`, else `.windsurf/global_rules.md` | always |
| `.cursor/rules/*.mdc` and `.cursor/rules/*.md` | the same as Cursor: `alwaysApply: true` always; `globs` on-demand; `description` only: description always, body on-demand; neither: manual |
| `.devin/skills/*/SKILL.md`, `.windsurf/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, `.claude/skills/**/SKILL.md`, `.github/skills/**/SKILL.md`, `.claude/commands/**/*.md` | name and description always; body when the skill is invoked |

Imports from the AGENTS.md standard, Cursor, Windsurf, Claude Code and Copilot are on by default (`read_config_from`); turning one off is not modelled. Nested `.devin/rules` folders are not read when Devin is launched at the root (`.devin` folders are read at the root and in each folder between the root and the working directory); nested `.windsurf/rules` load on demand. Nested `.cursor/rules`, nested `global_rules.md` and nested skill folders are not counted, and a skill with `triggers: [user]` is still counted as listed. Skills with the same name in several folders are all listed, each with a location prefix such as `/agents:foo`; a skill folder reached through a symlink loads once, but `turntax` counts each path. With `--include-user`, `~/.config/devin/` (`%APPDATA%\devin\` on Windows) rule files and skills, `~/.devin/rules/`, `~/.devin/global_rules.md`, `~/.agents/skills/`, `~/.codeium/windsurf/skills/`, `~/.copilot/skills/` and `~/.claude/CLAUDE.md` (which Devin CLI also reads) are counted.

## User-level files

With `--include-user`, files in the home directory are classified by the same rules as their project counterpart, for each agent that reads them. Checked on 2026-10-17.

| File | Agent | Read as |
| --- | --- | --- |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/agents/` | Claude Code ([memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents)) | the same paths at the root |
| `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md` | OpenAI Codex ([AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) | root `AGENTS.override.md` / `AGENTS.md` |
| `~/.agents/skills/` | OpenAI Codex, Gemini CLI, Cursor, GitHub Copilot, Windsurf Cascade, Roo Code, JetBrains Junie, Zed, Goose, Amp, OpenCode, Warp, Factory Droid, Augment Code, Kilo Code, Devin (skills pages above) | `.agents/skills` |
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

Sources are listed in [`src/core/mcp.ts`](../src/core/mcp.ts); checked on 2026-10-17.

| Agent | Project configs | User configs |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `~/.claude.json` (top level and `projects[<repo path>]`) |
| GitHub Copilot | `.mcp.json`, `.github/mcp.json` (both may also be a bare server map); `.vscode/mcp.json` (deprecated, see below) | `~/.copilot/mcp-config.json` |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` |
| Kiro | `.kiro/settings/mcp.json` | `~/.kiro/settings/mcp.json` |
| Roo Code | `.roo/mcp.json` | |
| OpenAI Codex | `.codex/config.toml` | `~/.codex/config.toml` |
| OpenCode | `opencode.json`, `opencode.jsonc` | `~/.config/opencode/opencode.json` |
| Kilo Code | `kilo.json`, `kilo.jsonc`, `.kilo/kilo.json`, `.kilo/kilo.jsonc`, `opencode.json`, `opencode.jsonc` | `kilo.json`, `kilo.jsonc`, `opencode.json`, `opencode.jsonc`, `config.json` in `~/.config/kilo/` |
| Zed | `.zed/settings.json` | |
| Windsurf (legacy Cascade agent) | | `~/.config/devin/mcp_config.json`, `%APPDATA%\devin\mcp_config.json` |
| Devin Local / Devin CLI | `.devin/mcp_config.json`, `.devin/mcp_config.local.json`; imported: `.mcp.json`, `.cursor/mcp.json`, `opencode.json`, `.zed/settings.json` | `~/.config/devin/mcp_config.json`, `%APPDATA%\devin\mcp_config.json`; imported: `~/.claude.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.config/opencode/opencode.json`, `~/.config/zed/settings.json` |
| Augment (Auggie CLI) | `.augment/settings.json`, `.augment/settings.local.json` | `~/.augment/settings.json` |
| Factory Droid | `.factory/mcp.json` | `~/.factory/mcp.json` |
| Warp | | `~/.warp/.mcp.json` |

- Shapes: most files hold an `mcpServers` map; VS Code uses `servers`, OpenCode and Kilo Code `mcp` (with a `command` array, `environment` and `enabled`), Zed `context_servers`, Codex `[mcp_servers.<name>]` tables. Augment, VS Code, Zed, OpenCode and Kilo Code files may contain comments and trailing commas. A `url` is streamable HTTP unless `type` (Devin: `transport`) says `sse`; in Gemini CLI `url` is SSE and `httpUrl` streamable HTTP; Claude Code's `type: "ws"` is a WebSocket server. Warp's `working_directory` is the server's working directory.
- Devin imports MCP servers from Claude Code, Cursor, Windsurf, OpenCode and Zed configs by default (`read_config_from`, [configuration import](https://docs.devin.ai/cli/reference/configuration/read-config-from)), so those servers are listed for Devin too. That it reads the same `projects[<repo path>]` servers in `~/.claude.json` as Claude Code is assumed. Its imports from `.claude/settings*.json`, `~/.claude/settings*.json` and `~/.claude/mcp_servers.json` are not read (the key is not documented), nor are the Windsurf `next` and `insiders` channels. `read_config_from` set to `false` is not read.
- Copilot: Copilot CLI and the Copilot harness in VS Code read `.mcp.json` and `~/.copilot/mcp-config.json` directly. `.vscode/mcp.json` is deprecated: Copilot CLI does not read it, and VS Code forwards only servers that need no `${input:...}` value to Copilot sessions. Copilot CLI defers MCP tools to tool search on supported models once there are more than about 30 tools ([tool search](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/tool-search)); the threshold is approximate, so Copilot tools are counted in full.
- A server with `disabled: true` or `enabled: false` is listed as disabled and not started.
- Tool filters: tools a config leaves out never reach the model, so they are not counted and the row says how many were left out. Read per agent: Codex `enabled_tools` / `disabled_tools`, Gemini CLI `includeTools` / `excludeTools`, Factory `enabledTools` / `disabledTools`, Copilot CLI `tools` (`["*"]` for all), Kiro, Roo Code and Windsurf `disabledTools`. A tool on both lists is left out; an empty allow list allows every tool, except Copilot's `tools: []`, which allows none.
- `--mcp` sends `initialize`, `notifications/initialized` and `tools/list` (all pages). The definitions are counted as one JSON object per tool (`name`, `description`, `input_schema`) with o200k. Agents wrap tool definitions in their own format, so this is an estimate. `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `{env:VAR}` (OpenCode, Kilo Code) and `${workspaceFolder}` (the repository folder, as in Cursor, VS Code and Augment) are expanded.
- Stdio and streamable HTTP servers are measured. Legacy SSE and WebSocket servers are listed and not measured: Claude Code documents only the `url` and `headers` of a WebSocket server, not the subprotocol or framing it speaks, and Node's WebSocket client accepts custom headers only through a non-standard option.
- Claude Code defers MCP tool definitions to tool search by default ([MCP docs](https://code.claude.com/docs/en/mcp)): a deferred tool counts only its name per turn, and its full size is shown as loading on use. A tool whose `tools/list` entry sets `_meta["anthropic/alwaysLoad"]: true` counts in full; `alwaysLoad: true` on the server counts every tool in full, `alwaysLoad: false` defers every tool. Claude Code cuts the description of an upfront tool at 4,096 characters and of a tool loaded through tool search at 16,384; the counts follow those cuts. Setting `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` or a non-first-party API host changes this; `turntax` does not read those settings.
- Server instructions (the `instructions` a server returns from `initialize`) are counted per turn where the agent's docs say they reach the model: Claude Code (loaded at session start, cut at 4,096 characters), Gemini CLI (appended to the system instructions), Codex (used alongside the tools; no cut documented, so counted in full, although Codex advises keeping the first 512 characters self-contained) and Kilo Code (added to the model context). Copilot CLI includes only allowlisted servers' instructions upfront, and the other agents do not document theirs, so they are not counted there. Resources and prompts are not counted.
- Augment loads every MCP tool upfront unless `enableToolSearch` is on; that setting is not read.
- Not counted: Warp project configs (`.warp/.mcp.json` and other agents' project files; Warp never starts project servers by itself) and Warp's import of other agents' user configs (a setting with an undocumented default); TRAE's `.trae/mcp.json` (needs the Project MCP switch, whose default is undocumented); servers added through an app's settings UI, plugins or remote/cloud configurations; OpenCode's top-level `tools` map.
- When an agent finds the same server name in several of its configs it uses one definition, so only that one is started and counted; the other copies are listed as `overridden by <config>`. The documented precedence decides: Claude Code local (`projects[<repo path>]` in `~/.claude.json`) over project (`.mcp.json`) over user; Copilot CLI `.mcp.json` over `.github/mcp.json` over `~/.copilot/mcp-config.json`; Augment `.augment/settings.local.json` over `.augment/settings.json` over `~/.augment/settings.json`; project over user for Gemini CLI and Kiro; for Kilo Code, `.kilo/kilo.json(c)` over the root `kilo.json(c)` over the user config, with the legacy `opencode.json(c)` assumed to rank with the root `kilo.json(c)`. Devin: `.devin/mcp_config.local.json` over `.devin/mcp_config.json` over the user config over imported configs (assumed). Anything else (other agents, Copilot's `.vscode/mcp.json`, two project files of one agent) follows the order of `MCP_CONFIGS` in `src/core/mcp.ts` (project files first) and is marked `(precedence assumed)`; for Factory the user config is assumed to win, because turning a project server on or off writes a copy to the user config.

## Token counts

- **o200k**: OpenAI `o200k_base`, counted offline with [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer). OpenAI's tiktoken maps GPT-4o, GPT-4.1, GPT-5.x and o-series models to it, and gpt-oss to `o200k_harmony`, which gives the same counts for plain text. GPT-6.x has no published encoding, so its counts are labelled estimates.
- **Claude**: `POST /v1/messages/count_tokens`. Each file is sent as a system prompt next to a one-character user message, and the same request without the system prompt is subtracted.
- **Gemini**: `models/{model}:countTokens` with the file as user content.
- Text is counted per file and summed; joining files changes the total by a few tokens at most.

## Prices

[`src/core/prices.ts`](../src/core/prices.ts) holds USD per 1M input and cache-read tokens for the shortest-context tier, with the pricing page and the date checked for each model. Long-context tiers, cache-write premiums and cache storage fees are not included. `turntax --list-models --json` prints the table in the format `--prices` accepts.
