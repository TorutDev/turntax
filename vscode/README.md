# turntax for VS Code

Coding agents re-send their instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md`, skills and more) with every turn. This extension shows that per-turn cost while you edit them, following each of the 23 supported agents' documented loading rules, and previews safe fixes.

It runs the same engine as the [turntax CLI](https://github.com/TorutDev/turntax), on the workspace folder of the active editor.

## What it shows

- **Status bar**: the largest per-turn cost across the agents that read the folder, for example `330 tok/turn`. It is the number the CLI badge shows: repository instruction files that load every turn, in o200k tokens. Hover for each agent's number; click for the full report.
- **CodeLens**: at the top of each instruction file, and of each file one of them imports, how the agents load it, for example `turntax: 219 tokens every turn in 6 agents · not read by 4`. Each agent counts once, under the strongest way it loads the file (every turn, on demand, only when referenced, not read); the number is the largest every-turn count among them, in o200k tokens. Hover for the agents and their counts; click for the full report.
- **Problems**: each finding on its file and line, with the estimated saving, such as lines loaded twice, sections that could load only in their folder, large procedures that could be an on-demand skill, misconfigured rules, references to files that no longer exist and contradictions.
- **Safe fixes**: on findings the fixer handles, the quick fix *turntax: Preview safe fixes* (or the command *turntax: Preview Safe Fixes*) opens a diff for every file the fixes would change. Nothing is written until you choose **Apply**, which plans the fixes again, writes only if nothing changed since the preview, and needs a trusted workspace.

The numbers update when an instruction file, a project MCP config, `package.json` or `turntax.config.json` changes. The folder is read in a background thread, so a large folder does not slow the editor down; the first count can take a while there.

The first lines of the tooltip for a repository with `CLAUDE.md`, `AGENTS.md`, Cursor rules and Copilot instructions:

```text
Claude Code: 272 tokens/turn
OpenAI Codex: 63 tokens/turn
Gemini CLI: 17 tokens/turn
Cursor: 311 tokens/turn
GitHub Copilot: 307 tokens/turn
...
Counts are o200k_base estimates, made offline.
```

## Commands

| Command | What it does |
| --- | --- |
| turntax: Show Report | Opens the full report (per agent, per file, advice) as a Markdown preview |
| turntax: Preview Safe Fixes | Opens the planned changes as diffs, then offers Apply or Cancel |
| turntax: Refresh | Audits the folder again |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `turntax.codeLens` | `true` | Shows the CodeLens at the top of instruction files |

A `turntax.config.json` in the folder (`tools`, `models`, `ignore`, `sectionTokens`) applies as it does for the CLI.

## How it counts

- Every count is OpenAI `o200k_base`, made offline: an estimate for each agent, not a Claude or Gemini count. Those come only from the vendors' token-counting APIs, which the CLI can call on request (`--claude-api`, `--gemini-api`).
- MCP servers in project configs are listed in the report, but their tool definitions are not counted: that needs starting the servers (`npx turntax --mcp`).
- User-level files in your home folder are not included (`npx turntax --include-user`).

Nothing leaves your machine: the extension makes no network requests and has no telemetry. The report preview has no images: it leaves out the shields.io badge the CLI adds, and images or HTML quoted from the repository are shown as text.

## More

- CLI: `npx turntax`, with the GitHub Action, PR comments and a CI budget: https://github.com/TorutDev/turntax
- In the browser, with nothing uploaded: https://torutdev.github.io/turntax/

## Building

The extension bundles the engine from the repository's `src/`, so install the root dependencies first:

```bash
npm ci && npm run build          # repository root; the integration test compares with dist/bin.js
cd vscode && npm ci
npm run typecheck && npm run build
npm test                         # downloads VS Code 1.95.0 into .vscode-test and runs the extension in it
npx vsce package --no-dependencies
```

MIT License, TORUT LTD. Bundled third-party licences are in ThirdPartyNotices.txt.
