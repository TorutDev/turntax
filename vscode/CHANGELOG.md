# Changelog

## 0.2.0

- CodeLens at the top of each instruction file, and of each file one of them imports: how many o200k tokens it adds to every turn and in how many agents, and how many load it only on demand, only when referenced, or not at all. Hover for the agents; click for the report. The `turntax.codeLens` setting turns it off.
- The tokenizer now loads only in the background thread, which also makes the report and the diagnostics: `dist/extension.js` went from 2.8 MB to 67 kB, so the extension activates faster.

## 0.1.0

- First release: the per-turn cost of the workspace folder in the status bar, findings as diagnostics, the full report as a Markdown preview, and safe fixes previewed as diffs and applied on request. Uses the turntax engine and the folder's `turntax.config.json`; counts are o200k_base estimates made offline, in a background thread.
