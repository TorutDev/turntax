# turntax plugin for Claude Code

Measures how many tokens your agent instruction files (CLAUDE.md, `.claude/rules`, skills, subagents, AGENTS.md and the rule files of 22 other coding agents) add to every turn, and previews safe fixes.

## What it adds

- The `turntax` MCP server with two read-only tools: `audit` (the per-turn report for a folder) and `fix_preview` (the diff `turntax --fix` would make; nothing is written).
- The `/turntax:context-tax [folder]` command, which runs both tools for the current project and summarises the largest per-turn costs. It applies fixes only when you ask for it explicitly.

## What it runs and sends

The server runs `npx -y turntax@0.7.2 mcp` on your machine. npx downloads the `turntax` package from npm on first use. The tools read instruction files and MCP configs in the folder you audit. They do not start the MCP servers they find, do not call any vendor API, and send nothing over the network.

## Install

```text
/plugin marketplace add TorutDev/turntax
/plugin install turntax@turntax
```

Source, CLI and documentation: https://github.com/TorutDev/turntax (MIT, TORUT LTD).
