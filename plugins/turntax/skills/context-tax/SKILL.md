---
description: Measure the per-turn token cost of this project's agent instruction files and MCP servers with turntax, and preview safe fixes.
argument-hint: "[folder]"
disable-model-invocation: true
allowed-tools: mcp__plugin_turntax_turntax__audit mcp__plugin_turntax_turntax__fix_preview
---

Measure the context tax of this project with the turntax MCP tools. Do not change any file.

1. Call the turntax `audit` tool. Set `path` to the folder given as an argument, if any, otherwise to the absolute path of the project root.
2. Summarise the report in a few lines:
   - the agents that load the most every turn, with their o200k tokens per turn and the cost for the priced models;
   - the files and MCP servers that add the most to every turn;
   - the advice with the largest savings.
   Say that o200k counts are a reference, not Claude's or Gemini's own tokenizer, as the report does.
3. Call the turntax `fix_preview` tool with the same `path`. List the safe fixes and their estimated savings; show the diff when the user asks for it.

The fixes are a preview only. Apply them only when the user explicitly asks you to, with `npx turntax --fix --write` in the audited folder or by applying the diff.
