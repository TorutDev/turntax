# Changelog

## 0.7.0 (2026-10-17)

- Seven more agents, 23 in all: Warp, Factory Droid, TRAE, Augment Code, Kilo Code, Google Jules and Devin Local / Devin CLI, each from its official docs with sources, notes and documented limits. TRAE files behind settings switches with undocumented defaults are noted and not counted.
- The 16 existing agents were checked against their docs again (2026-10-17):
  - Skill folders are now read for Gemini CLI, Cursor, GitHub Copilot, Windsurf, Cline, Roo Code, Kiro, JetBrains Junie, Zed, Goose, Amp and OpenCode. A skill name an agent finds in two folders is counted once, in the agent's documented order (or an assumed order, noted per agent).
  - GitHub Copilot follows VS Code's defaults: `CLAUDE.md` and `.claude/rules` are read together with `AGENTS.md`; nested files are not read. CLI and cloud-agent differences are in the notes.
  - Kiro reads nested `AGENTS.md` files every turn; Claude Code subagents are found recursively and nested `.claude/agents` folders are not read; Windsurf's global rules are limited to 6,000 characters; Goose `@` includes are followed; moved documentation links are updated.
- MCP:
  - Claude Code: server instructions are counted every turn (cut at 4,096 characters), tools marked `alwaysLoad` count in full, and WebSocket servers are listed. Server instructions also count for Gemini CLI, Codex and Kilo Code.
  - New configs for Copilot (`.mcp.json`, `.github/mcp.json`, `~/.copilot/mcp-config.json`), Devin, Augment, Factory, Kilo and Warp; tool filters in the configs are applied; a server name found in several configs of one agent is counted once.
- Totals for the same repository can be higher than in 0.6: skills, Copilot's `CLAUDE.md`, Kiro's nested files and MCP instructions are now counted, and the new agents (Devin, Augment Code and Factory Droid read `AGENTS.md` and `CLAUDE.md` together) can raise the largest per-turn total. That total drives the badge and `--max-tokens`, so an existing CI budget may need a look.

## 0.6.1 (2026-10-16)

- turntax is listed in the official MCP Registry as `io.github.TorutDev/turntax` (`server.json`, `mcpName` in package.json). No change to the CLI.

## 0.6.0 (2026-10-15)

- `turntax init` writes the GitHub Action workflow and a starter `turntax.config.json` (no agent list unless `--tools`, so every agent that reads a file is reported and gated); existing files are kept unless `--force`, and `--dry-run` shows what it would write.
- `turntax mcp` runs turntax as a read-only MCP server with `audit` and `fix_preview` tools, and the repository is a Claude Code plugin marketplace (`/plugin install turntax@turntax`) with a `/turntax:context-tax` command.
- `--fix` moves large procedure sections (release, deploy, setup and the like, or mostly numbered steps) into an on-demand skill for Claude Code or Codex, leaving a one-line pointer, when every protected agent keeps the text.
- The [State of agent instruction files](https://torutdev.github.io/turntax/state/) is a monthly edition, collected by GitHub Actions on the 1st of each month, with a trend view from the second edition and `?edition=YYYY-MM` links.
- Pull request comments no longer turn @names quoted from instruction files into mentions.

## 0.5.0 (2026-10-14)

- The web page previews `--fix` for any loaded repository or folder, with the agents you use as checkboxes and a downloadable `fix.patch`.
- The GitHub Action marks each finding on its line in the pull request (`annotations` input, `--annotations` and `--path-prefix` in the CLI), and the pull request comment lists the safe fixes with their diff.
- `turntax.config.json` (or `--config <file>`) holds defaults for `tools`, `models`, `turns`, `maxTokens`, `maxIncrease`, `sectionTokens` and `ignore` globs; flags override it.
- When `--tools` narrows `--fix`, a moved section's message names the agents outside `--tools` that stop reading it.
- A notice when a selected model's price was checked more than 90 days ago.
- The web page accepts GitHub links to a folder (`/tree/main/packages/api`) and analyses the whole repository at that branch.
- Fixed: advice line numbers now point at the line in the file, also when a CLAUDE.md has HTML comments or a rule has frontmatter.
- Fewer false positives, found while measuring 100 public repositories: terse English is no longer flagged as non-English, a section is suggested for a folder only when the folder exists, and paths with `..` are not checked against files outside the repository.
- [State of agent instruction files, October 2026](https://torutdev.github.io/turntax/state/): turntax on 100 popular repositories, with pinned commits and `scripts/state-of.mjs` to reproduce it.

## 0.4.0 (2026-10-13)

- `--fix` prints a diff of safe fixes: duplicate lines an agent already reads every turn from another file, sections that can load only in the folder they are about (moved to a nested `CLAUDE.md` / `AGENTS.md` or a Claude Code rule with `paths:`), and `.md` files in `.cursor/rules` renamed to `.mdc`. `--write` applies them.
- Every fix is checked by classifying the files again: each agent must still read every line it read before, as often as before (a moved section may load only in its folder), or the fix is skipped with the reason. `--tools` limits the check to the agents you use. Symlinked files are never changed.
- The web page loads a public GitHub repository by URL or `owner/name`, and `?repo=owner/name` links open straight to its report. Files come from api.github.com and raw.githubusercontent.com; nothing is uploaded. Files that cannot be downloaded are listed.

## 0.3.0 (2026-10-11)

- MCP servers: the agents' MCP configs (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` and more) are read and listed per agent. `--mcp` starts the servers and counts their tool definitions; Claude Code's deferred tools (tool search) count as names only.
- `--include-user` adds user-level instruction files and MCP servers from the home directory (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and others) in a separate column and a total.
- `--compare <git-ref>` and `--baseline <report.json>` show how much each agent's per-turn cost changed and which files caused it; `--max-increase` fails CI when it grows too much.
- GitHub Action (`uses: TorutDev/turntax@v0.3.0`): comments on pull requests with the change against the base branch and keeps that one comment up to date. `--pr-comment` prints the same comment.
- Agents that only have an MCP config (no instruction files) are now reported.

## 0.2.0 (2026-10-10)

- Ten more agents: Aider, Amp, Cline, Continue, Goose, JetBrains Junie, Kiro, OpenCode, Roo Code and Zed, each linked to its documentation.
- Agents that load the same files share one row in the report and one card on the web page.
- Redesigned web page with per-agent cards, a tokens-per-turn chart and a sample repository.
- Fixed: when several instruction files sat in the same folder (for example `CLAUDE.md` and `CLAUDE.local.md`), only one was counted.
- The per-turn total, the badge and the `--max-tokens` check can be higher than in 0.1.0 for the same repository: the fix above and the new agents count files that were missed before.

## 0.1.0 (2026-10-10)

First version.

- Loading rules for Claude Code, OpenAI Codex, Gemini CLI, Cursor, GitHub Copilot and Windsurf, each linked to the vendor documentation.
- Offline `o200k_base` counts; Claude and Gemini counts through their token-counting APIs when you opt in with your own key.
- Dated price table with cost per N turns, uncached and cached.
- Advice: duplicates, contradictions, scopable and oversized sections, size limits, misconfigured files, stale references, non-English text.
- Terminal, JSON, Markdown and badge output; `--max-tokens` CI gate.
- Static web page that runs the same engine in the browser.
