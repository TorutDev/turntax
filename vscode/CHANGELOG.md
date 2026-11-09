# Changelog

## 0.6.0

- The engine of turntax 0.11.0: a finding when the repository's Claude Code skill and command descriptions pass the skill listing budget (30,000 characters on a 1M-token context window).

## 0.5.0

- The engine of turntax 0.10.0: GitHub Copilot is counted as Copilot CLI loads instruction files (checked against Copilot CLI 1.0.107), which VS Code's Copilot harness shares, and a root `CLAUDE.md` over 4 MiB counts as skipped by Claude Code.

## 0.4.0

- The engine of turntax 0.9.0: loading rules re-checked against every agent's docs on 2026-11-06 (Augment Code reads `AGENTS.md` instead of a `CLAUDE.md` in the same folder, Devin's custom subagents are counted, Claude Code size limits), and duplicate findings and fixes leave table rows alone.

## 0.3.0

- Safe fixes can link a `CLAUDE.md` that repeats most of the `AGENTS.md` next to it with `@AGENTS.md`, as in turntax 0.8.0.
- On a misconfigured finding, "Preview safe fixes" now appears only for `.md` files in `.cursor/rules`, the one misconfiguration a fix can change. It no longer appears on a Windsurf rule without a trigger, for example.
- Amp glob mentions followed by a bold closer (`**See @docs/*.md.**`) now match the files, and gpt-tokenizer is 4.1.0.

## 0.2.0

- CodeLens at the top of each instruction file, and of each file one of them imports: how many o200k tokens it adds to every turn and in how many agents, and how many load it only on demand, only when referenced, or not at all. Hover for the agents; click for the report. The `turntax.codeLens` setting turns it off.
- The tokenizer now loads only in the background thread, which also makes the report and the diagnostics: `dist/extension.js` went from 2.8 MB to 67 kB, so the extension activates faster.

## 0.1.0

- First release: the per-turn cost of the workspace folder in the status bar, findings as diagnostics, the full report as a Markdown preview, and safe fixes previewed as diffs and applied on request. Uses the turntax engine and the folder's `turntax.config.json`; counts are o200k_base estimates made offline, in a background thread.
