# How turntax counts

`turntax` assumes the agent is started at the repository root. For each tool it sorts every instruction file into one of four modes:

- **always**: sent with every turn. This is the per-turn cost.
- **on-demand**: loaded when the agent works in a folder, touches a matching file, invokes a skill, or decides a rule is relevant.
- **manual**: loaded only when you reference it explicitly.
- **ignored**: the tool does not read the file in this repository's situation.

Skills and description-driven rules are split in two: the short description is always in context, the body loads on demand.

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

## Token counts

- **o200k**: OpenAI `o200k_base`, counted offline with [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer). OpenAI's tiktoken maps GPT-4o, GPT-4.1, GPT-5.x and o-series models to it, and gpt-oss to `o200k_harmony`, which gives the same counts for plain text. GPT-6.x has no published encoding, so its counts are labelled estimates.
- **Claude**: `POST /v1/messages/count_tokens`. Each file is sent as a system prompt next to a one-character user message, and the same request without the system prompt is subtracted.
- **Gemini**: `models/{model}:countTokens` with the file as user content.
- Text is counted per file and summed; joining files changes the total by a few tokens at most.

## Prices

[`src/core/prices.ts`](../src/core/prices.ts) holds USD per 1M input and cache-read tokens for the shortest-context tier, with the pricing page and the date checked for each model. Long-context tiers, cache-write premiums and cache storage fees are not included. `turntax --list-models --json` prints the table in the format `--prices` accepts.
