# How turntax counts

`turntax` assumes the agent is started at the repository root. For each agent it sorts every instruction file into one of four modes:

- **always**: sent with every turn. This is the per-turn cost.
- **on-demand**: loaded when the agent works in a folder, touches a matching file, invokes a skill, or decides a rule is relevant.
- **manual**: loaded only when you reference it explicitly.
- **ignored**: the tool does not read the file in this repository's situation.

Skills and description-driven rules are split in two: the short description is always in context, the body loads on demand.

Rule folders inside a subdirectory (for example `packages/api/.claude/rules/` or `packages/api/.cursor/rules/`) are counted as on-demand: they apply only when the agent works in that folder.

The rules below live in [`src/core/tools.ts`](../src/core/tools.ts). Each entry cites the page it came from; all were checked on 2026-10-10.

## Claude Code

Sources: [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents)

| File | Mode |
| --- | --- |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` at the root | always; block-level HTML comments are removed first; `@imports` are expanded up to four hops |
| `CLAUDE.md` in a subdirectory | on-demand, when Claude reads or edits a file there |
| `AGENTS.md` | always, but only when there is no root `CLAUDE.md` or `CLAUDE.local.md` (default setting); otherwise ignored unless imported |
| `.claude/rules/**/*.md` | always without `paths` frontmatter; on-demand with `paths` |
| `.claude/skills/*/SKILL.md`, `.claude/commands/**/*.md` | description (capped at 1,536 characters) always; body on-demand; `disable-model-invocation: true` keeps both out |
| `.claude/agents/*.md` | description always; body is the subagent's own prompt |

## OpenAI Codex

Sources: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skills](https://learn.chatgpt.com/docs/build-skills)

| File | Mode |
| --- | --- |
| `AGENTS.override.md`, else `AGENTS.md`, at the root | always; reading stops at 32 KiB (`project_doc_max_bytes`) |
| The same files in a subdirectory | on-demand: only read when Codex is launched there |
| `.agents/skills/*/SKILL.md` | name and description always; body when the skill is selected |

## Gemini CLI

Source: [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/)

| File | Mode |
| --- | --- |
| `GEMINI.md` at the root | always, with `@file.md` imports |
| `GEMINI.md` in a subdirectory | on-demand, when a tool accesses that folder |

`context.fileName` can make Gemini CLI read `AGENTS.md`; that setting is not modelled.

## Cursor

Sources: [rules](https://cursor.com/docs/context/rules), [rules help](https://cursor.com/help/customization/rules)

| File | Mode |
| --- | --- |
| `.cursor/rules/**/*.mdc` | `alwaysApply: true` always; `globs` on-demand; `description` only: description always, body on-demand; neither: manual |
| `.cursor/rules/**/*.md` | ignored (Cursor only reads `.mdc`) |
| `.cursorrules` | always (legacy) |
| `AGENTS.md`, `CLAUDE.md` at the root | always |
| `AGENTS.md`, `CLAUDE.md` in a subdirectory | on-demand |

Treating a description-only rule's description as always in context is an inference; Cursor's docs say the agent decides from it.

## GitHub Copilot

Sources: [repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions), [VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

| File | Mode |
| --- | --- |
| `.github/copilot-instructions.md` | always |
| `.github/instructions/**/*.instructions.md` | `applyTo` on-demand; `description` only: description always, body on-demand; neither: manual |
| `AGENTS.md` at the root | always; nested ones on-demand (the nearest wins) |
| `CLAUDE.md` or `GEMINI.md` at the root | always, only when there is no `AGENTS.md` |

Support differs between Copilot surfaces and VS Code settings.

## Windsurf (Devin Desktop)

Source: [rules](https://docs.devin.ai/desktop/cascade/memories)

| File | Mode |
| --- | --- |
| `.devin/rules/*.md`, `.windsurf/rules/*.md` | `trigger: always_on` always; `model_decision`: description always, body on-demand; `glob` on-demand; `manual` manual; no trigger: not counted and flagged |
| `.windsurfrules` | always (legacy) |
| `AGENTS.md` | always at the root; nested ones apply to their folder |

## Cline

Source: [Cline rules](https://docs.cline.bot/features/cline-rules)

| File | Mode |
| --- | --- |
| `.clinerules/**/*.md`, `.cline/rules/**/*.md` | always without `paths`; on-demand with `paths`; `paths: []` never applies |

Rules can be toggled off in Cline; the audit assumes they are on. Cline also detects `AGENTS.md`, `.cursorrules` and `.windsurfrules`, but whether those are on by default is not documented, so they are not counted. A single `.clinerules` file is not counted for Cline.

## Roo Code

Source: [custom instructions](https://roocodeinc.github.io/Roo-Code/features/custom-instructions)

| File | Mode |
| --- | --- |
| `.roo/rules/**` | always |
| `.roo/rules-{mode}/**`, `.roorules-{mode}` | on-demand: only in that mode |
| `.roorules`, then `.clinerules` (order assumed) | always, only when `.roo/rules/` is empty or missing |
| `AGENTS.md`, else `AGENT.md`, at the root | always (the `roo-cline.useAgentRules` setting turns it off) |

## Kiro

Source: [steering](https://kiro.dev/docs/steering/)

| File | Mode |
| --- | --- |
| `.kiro/steering/*.md` | `inclusion: always` (the default) always; `fileMatch` on-demand; `manual` manual; `auto`: description always, body on-demand; an unknown value is counted as always |
| `AGENTS.md` at the root | always |

When subdirectory `AGENTS.md` files load is not documented, so they are not counted.

## JetBrains Junie

Source: [guidelines and memory](https://junie.jetbrains.com/docs/guidelines-and-memory.html)

The first of these that exists is loaded every turn; the others are ignored:

1. `.junie/AGENTS.md` (used on its own)
2. `AGENTS.md`, together with `.junie/playbook.md` and `.junie/rules/*.md`
3. `.junie/guidelines.md` or `.junie/guidelines/*.md` (deprecated)

A custom path set in project settings is not modelled.

## Zed

Source: [instructions](https://zed.dev/docs/ai/instructions)

Zed loads the first of these at the project root, every turn: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. The others are ignored.

## Continue

Source: [rules](https://docs.continue.dev/customize/deep-dives/rules)

| File | Mode |
| --- | --- |
| `.continue/rules/*.md` | `alwaysApply: true` always; `globs` on-demand; `alwaysApply: false` with only a `description`: description always, body on-demand; no frontmatter: always |

Rules in `config.yaml` and from the Continue hub are not counted.

## Aider

Source: [conventions](https://aider.chat/docs/usage/conventions.html)

| File | Mode |
| --- | --- |
| Files listed under `read:` in `.aider.conf.yml` | always |
| `CONVENTIONS.md` | manual: only with `--read` or `/read` |

## Goose

Source: [goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints)

| File | Mode |
| --- | --- |
| `AGENTS.md`, `.goosehints` at the root | always (needs the Developer extension) |
| The same files in a subdirectory | on-demand, when goose accesses files there |

## Amp

Source: [AGENTS.md](https://ampcode.com/docs/customize/agents-md)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root (or `AGENT.md` / `CLAUDE.md` when there is no `AGENTS.md`) | always |
| The same files in a subdirectory | on-demand, when Amp reads a file there |
| Files @-mentioned in them | always, or on-demand when they have `globs` frontmatter |

## OpenCode

Source: [rules](https://opencode.ai/docs/rules/)

| File | Mode |
| --- | --- |
| `AGENTS.md` at the root, or `CLAUDE.md` when there is none | always |

Files listed under `instructions` in `opencode.json` are not counted. When subdirectory `AGENTS.md` files load is not documented, so they are not counted.

## User-level files

With `--include-user`, files in the home directory are classified by the same rules as their project counterpart, for the one agent that reads them. Checked on 2026-10-11.

| File | Agent | Read as |
| --- | --- | --- |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/agents/` | Claude Code ([memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills)) | the same paths at the root |
| `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md` | OpenAI Codex ([AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) | root `AGENTS.override.md` / `AGENTS.md` |
| `~/.agents/skills/*/SKILL.md` | OpenAI Codex ([skills](https://learn.chatgpt.com/docs/build-skills)) | `.agents/skills` |
| `~/.gemini/GEMINI.md` | Gemini CLI ([GEMINI.md](https://geminicli.com/docs/cli/gemini-md/)) | root `GEMINI.md` |
| `~/.codeium/windsurf/memories/global_rules.md` | Windsurf ([rules](https://docs.devin.ai/desktop/cascade/memories)) | always loaded |
| `~/Documents/Cline/Rules/`, `~/Cline/Rules/`, `~/.cline/rules/` | Cline ([rules](https://docs.cline.bot/features/cline-rules)) | `.clinerules/` |
| `~/.roo/rules/`, `~/.roo/rules-{mode}/` | Roo Code ([instructions](https://roocodeinc.github.io/Roo-Code/features/custom-instructions)) | the same paths |
| `~/.kiro/steering/*.md` | Kiro ([steering](https://kiro.dev/docs/steering/)) | `.kiro/steering/` |
| `~/.config/goose/.goosehints` | Goose ([goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints)) | root `.goosehints` |
| `~/.config/AGENTS.md` and `~/.config/amp/AGENTS.md` (both) | Amp ([AGENTS.md](https://ampcode.com/docs/customize/agents-md)) | root `AGENTS.md` |
| `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md` | OpenCode ([rules](https://opencode.ai/docs/rules/)) | root `AGENTS.md` / `CLAUDE.md` |

`@imports` inside user-level files are not followed. Continue keeps user rules in `~/.continue/config.yaml`, Cursor and Copilot in app settings; those are not counted.

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
