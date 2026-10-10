# Changelog

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
