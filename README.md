# turntax

Coding agents re-send their instruction files with every turn. `turntax` measures that fixed per-turn cost for a repository, for every agent that reads it, and shows where to cut it.

```bash
npx turntax
```

Try it in the browser, with nothing uploaded: https://torutdev.github.io/turntax/ — drop a folder or enter a public GitHub repository. Links like `https://torutdev.github.io/turntax/?repo=owner/name` open straight to that repository's report.

[State of agent instruction files, October 2026](https://torutdev.github.io/turntax/state/): what turntax finds in 100 popular repositories, with pinned commits and the script to reproduce it ([`scripts/state-of.mjs`](scripts/state-of.mjs)).

## Supported agents

Each agent's documented loading rules decide what is sent on every turn, what loads only when the agent works in a folder or touches a matching file, and what is ignored.

| Agent | Files it reads from the repository |
| --- | --- |
| Aider | files listed under `read:` in `.aider.conf.yml` (`CONVENTIONS.md` only when listed or passed with `--read`) |
| Amp | `AGENTS.md` (or `AGENT.md` / `CLAUDE.md`), nested `AGENTS.md`, @-mentioned files |
| Claude Code | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules`, skills, commands, subagents, `AGENTS.md` when there is no `CLAUDE.md` |
| Cline | `.clinerules/`, `.cline/rules/` |
| Continue | `.continue/rules/` |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md` |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/`, `AGENTS.md` |
| Goose | `.goosehints`, `AGENTS.md` |
| JetBrains Junie | `.junie/AGENTS.md`, or `AGENTS.md` with `.junie/rules/`, or `.junie/guidelines` |
| Kiro | `.kiro/steering/`, `AGENTS.md` |
| OpenAI Codex | `AGENTS.md`, `AGENTS.override.md`, `.agents/skills` |
| OpenCode | `AGENTS.md`, or `CLAUDE.md` when there is none |
| Roo Code | `.roo/rules/`, `.roo/rules-{mode}/`, `.roorules`, `AGENTS.md` |
| Windsurf (Devin Desktop) | `.devin/rules/`, `.windsurf/rules/`, `.windsurfrules`, `AGENTS.md` |
| Zed | the first of `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` |

Agents that load exactly the same files share one row in the report:

```text
always  o200k/turn  on-demand  model                tokens/turn  counted by                   100 turns  cached   agents
4       272         53         (no selected model)                                                                Claude Code
1       63          0          GPT-6.1 Sol          63           estimate (o200k_base proxy)  $0.01      $0.0006  OpenAI Codex, Roo Code, Kiro, JetBrains Junie, Goose, OpenCode
1       17          0          (no selected model)                                                                Gemini CLI
4       297         37         GPT-6.1 Sol          297          estimate (o200k_base proxy)  $0.06      $0.0030  Cursor
2       74          8          GPT-6.1 Sol          74           estimate (o200k_base proxy)  $0.01      $0.0007  GitHub Copilot
2       75          0          GPT-6.1 Sol          75           estimate (o200k_base proxy)  $0.01      $0.0008  Windsurf (Devin Desktop)
1       11          0          GPT-6.1 Sol          11           estimate (o200k_base proxy)  $0.0022    $0.0001  Zed
1       63          19         GPT-6.1 Sol          63           estimate (o200k_base proxy)  $0.01      $0.0006  Amp

Advice (savings are estimates in o200k tokens per turn)
  HIGH duplicate CLAUDE.md, AGENTS.md [saves ~48 tokens/turn]
    3 identical lines are loaded twice every turn by cursor. Keep them in one file.
  HIGH contradiction AGENTS.md, CLAUDE.md [saves ~11 tokens/turn]
    Conflicting package manager: "Always use npm ..." (AGENTS.md:3) vs "Always use pnpm ..." (CLAUDE.md:5).
  MEDIUM scopable-section CLAUDE.md:11 [saves ~128 tokens/turn]
    Section "API package" is mostly about packages/api/. Move it to packages/api/AGENTS.md ...
```

(Excerpt of the output for [`test/fixtures/mixed`](test/fixtures/mixed) with `--models gpt-6.1-sol`.)

## What it counts, and how

| Model family | How tokens are counted | Label |
| --- | --- | --- |
| OpenAI GPT-5.x, gpt-oss | Offline with `o200k_base` (the encoding OpenAI's tiktoken maps them to) | exact |
| OpenAI GPT-6.x | Offline with `o200k_base`; OpenAI has not published a newer encoding | estimate |
| Claude | Only Anthropic's `count_tokens` API, with your key and `--claude-api` | API count |
| Gemini | Only Google's `countTokens` API, with your key and `--gemini-api` | API count |

Claude's tokenizer is not public, and Anthropic's docs note that newer Claude models produce noticeably more tokens than older ones for the same text. `turntax` never shows an OpenAI count as a Claude or Gemini number: without a key those rows say "needs API key". The `o200k` column is a labelled reference count for every file.

Cost per N turns = tokens per turn × N × input price. The "cached" column assumes every turn reads the context from the prompt cache. Prices come from a dated table with a source link per model (`turntax --list-models`); pass `--prices my-prices.json` to use your own.

See [docs/how-it-counts.md](docs/how-it-counts.md) for the loading rules per agent and their sources.

## Advice

All checks are deterministic. Each one shows an estimated saving in o200k tokens per turn.

- **duplicate**: identical lines in two files. A per-turn saving only when one tool loads both; otherwise flagged as drift risk.
- **contradiction**: conflicting rules reaching the same agent (package manager, indentation, quotes, semicolons).
- **scopable-section**: a section mostly about one directory that could load only there (nested file, path-scoped rule, `applyTo`).
- **oversized-section**: a large always-loaded section that could become an on-demand skill.
- **size-limit**: documented limits (CLAUDE.md under 200 lines, Codex's 32 KiB cut-off, Windsurf's 12,000 characters, Cursor's 500 lines).
- **misconfigured**: files a tool ignores, such as `.md` files in `.cursor/rules` or Windsurf rules without a `trigger`.
- **stale-reference**: referenced files or `npm run` scripts that no longer exist.
- **non-english**: non-English sections. The token multiplier is measured only against an English version you supply (`--english CLAUDE.md=CLAUDE.en.md`) or, if you opt in, a Claude translation (`--translate`).

## Fixing

```bash
npx turntax --fix            # print a diff of the safe fixes; nothing is changed
npx turntax --fix --write    # apply them
```

`--fix` handles three kinds of advice:

- **duplicate**: removes lines from a file when every agent that reads the file also reads the same lines every turn from another file. Skill, command and subagent files are left whole.
- **scopable-section**: moves a section into the folder it is about: the same file name there (`packages/api/CLAUDE.md`), a nested `AGENTS.md`, or a Claude Code rule with `paths:`. The folder the section is about must already exist, and sections with `@imports` or relative links stay put. A section moves together with its subsections.
- **misconfigured**: renames `.md` files in `.cursor/rules` to `.mdc`.

Before a fix is kept, the files are classified again with the change applied: every agent must still read every line it read before, including files reached through `@imports`, and as often as before. The only exception is a moved section, which may load only when the agent works in that folder. Otherwise the fix is skipped and the reason is printed. A moved section can reach agents that did not read it before (a nested `AGENTS.md` is read by more agents than a `CLAUDE.md`); the summary names them. By default that check covers every supported agent, so a section of `AGENTS.md` usually stays where it is, because some agents read only the root file. `--tools codex,claude-code` limits the check to the agents you use.

In preview the diff is on stdout and works with `git apply`, and the summary is on stderr; with `--write` the summary is on stdout. `--write` checks that no file changed since it was read and writes nothing if one did. Symlinked files, their targets and files in symlinked folders are never changed. Contradictions and stale references need a person to decide, so `--fix` leaves them alone.

The web page shows the same fixes for any repository you load, with a downloadable `fix.patch`.

## Config file

Put defaults in `turntax.config.json` in the audited folder (or pass `--config <file>`). Command-line flags override it.

```json
{
  "tools": ["claude-code", "codex", "cursor"],
  "models": ["claude-sonnet-5.5", "gpt-6.1-sol"],
  "maxTokens": 8000,
  "maxIncrease": 500,
  "ignore": ["docs/agents/archive/", "**/*.draft.md"]
}
```

Keys: `tools`, `models`, `turns`, `maxTokens`, `maxIncrease` (applies only with `--compare` or `--baseline`), `sectionTokens`, and `ignore`: repository-relative globs of instruction files to leave out (`*` and `?` within a folder name, `**` across folders, a trailing `/` for a whole folder). Ignored files are also left out of `--compare` and are never changed by `--fix`. Unknown keys and ids are errors.

## MCP servers

Every MCP server an agent starts adds its tool definitions (names, descriptions, input schemas) to the context. `turntax` reads the agents' MCP configs and lists the servers each agent starts:

| Agent | Project config | User config |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `~/.claude.json` (user and per-project servers) |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| GitHub Copilot (VS Code) | `.vscode/mcp.json` | |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` |
| Kiro | `.kiro/settings/mcp.json` | `~/.kiro/settings/mcp.json` |
| Roo Code | `.roo/mcp.json` | |
| OpenAI Codex | `.codex/config.toml` (trusted projects) | `~/.codex/config.toml` |
| OpenCode | `opencode.json` | `~/.config/opencode/opencode.json` |
| Zed | `.zed/settings.json` | |
| Windsurf (Devin Desktop) | | `~/.config/devin/mcp_config.json` |

Counting the tool definitions needs the servers running, so it is opt-in:

```bash
npx turntax --mcp
```

`--mcp` starts each stdio server with the command from its config (in the repository folder) and connects to streamable HTTP servers, asks for `tools/list`, and counts the definitions as JSON with o200k. A server several agents share is started once. Environment variables in the config (`${VAR}`, `${VAR:-default}`, `${env:VAR}`) are expanded; servers that need a VS Code `${input:...}` prompt, legacy SSE servers and servers that fail or time out (`--mcp-timeout`, default 30 s) are listed with the reason and not counted.

Claude Code defers MCP tool definitions by default (tool search): only the tool names are in context until a tool is used, so its row counts the names and shows the full size separately. A server with `alwaysLoad: true` is counted in full.

MCP tokens are an o200k estimate and are not included in the model cost columns.

## User-level files

Agents also read instruction files from your home directory in every project. `--include-user` adds them in a separate `user/turn` column and a `total`:

```bash
npx turntax --include-user
```

It reads only the documented locations: `~/.claude/` (CLAUDE.md, rules, skills, commands, agents), `~/.codex/AGENTS.md`, `~/.agents/skills`, `~/.gemini/GEMINI.md`, Windsurf's `global_rules.md`, Cline's global rules folders, `~/.roo/rules*`, `~/.kiro/steering`, `~/.config/goose/.goosehints`, Amp's `~/.config/AGENTS.md` and `~/.config/amp/AGENTS.md`, and `~/.config/opencode/AGENTS.md` (OpenCode falls back to `~/.claude/CLAUDE.md`), plus the user MCP configs above. Contradictions and duplicates between user-level and repository files are reported. User-level files never count toward the badge or `--max-tokens`, so the result does not depend on who runs it.

## Comparing with a baseline

```bash
npx turntax --compare origin/main            # instruction files at a git ref, read with git show
npx turntax --json --out before.json         # or save a report ...
npx turntax --baseline before.json           # ... and compare with it later
npx turntax --compare origin/main --max-increase 200   # exit 1 when any agent grows by more than 200 tokens
```

The comparison covers repository instruction files (o200k), per agent and per file, and lists MCP servers that were added or removed. It never changes the working tree.

## GitHub Action

The repository is also an Action. On pull requests it compares with the base branch, posts one comment (updated on every push), writes the report to the job summary and marks each finding on the line it is about in the pull request's changed files:

```yaml
name: turntax
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  turntax:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: TorutDev/turntax@v0.5.0
        with:
          max-increase: 500      # optional: fail when an agent grows by more than 500 tokens per turn
          # max-tokens: 8000     # optional: absolute budget
          # args: --tools claude-code,cursor
          # annotations: false   # optional: no findings on the changed lines
```

The comment opens with a table of the change per agent and per file. When `--fix` has safe fixes, it says how many and how many tokens they save, with the diff folded; the full report is folded below. A `turntax.config.json` in the repository is read as well. Pull requests from forks get a read-only token, so the comment step is skipped there; the job summary still has the report.

## Options

```text
turntax [path]
  --tools <ids>             agents to report (default: every agent that reads a file); see --help
  --models <ids>            see --list-models (default: claude-sonnet-5.5, gpt-6.1-sol, gemini-3.8-flash)
  --turns <n>               cost projection (default 100)
  --json | --md | --badge   output format (default: terminal table)
  --pr-comment              Markdown for a pull request comment (change first, fixes and full report folded)
  --annotations             GitHub Actions annotations, one per finding (--path-prefix <dir> for a subfolder)
  --out <file>              write the output to a file
  --max-tokens <n>          exit 1 when any tool loads more than n o200k tokens per turn (CI gate)
  --include-user            add user-level files and MCP servers from your home directory
  --mcp                     start the configured MCP servers and count their tool definitions
  --mcp-timeout <s>         seconds to wait for each MCP server (default 30)
  --baseline <file.json>    compare with an earlier --json report
  --compare <git-ref>       compare with the instruction files at a git ref
  --max-increase <n>        exit 1 when any tool grows by more than n tokens per turn vs the baseline
  --claude-api              exact Claude counts (ANTHROPIC_API_KEY)
  --gemini-api              Gemini counts (GEMINI_API_KEY)
  --english <file=en>       measure a language multiplier against your English version
  --translate               opt-in Claude translation for that measurement (needs --claude-api)
  --prices <file.json>      your own price table
  --section-tokens <n>      threshold for oversized sections (default 600)
  --fix                     print a diff of the safe fixes (--tools limits the agents whose context is kept)
  --write                   with --fix, apply the changes
  --config <file>           read defaults from this file (default: turntax.config.json, if any)
```

When a selected model's price was checked more than 90 days ago, turntax says so on stderr; check the source or pass `--prices`.

## Privacy

Offline by default: no network calls, no telemetry. File contents are sent only when you pass `--claude-api`, `--gemini-api` or `--translate`, and only to that vendor's API. Keys are read from environment variables and sent only in request headers.

`--mcp` runs the commands in the MCP configs it finds and connects to the configured HTTP servers, as the agents themselves would. Run it only on repositories whose configs you trust. `turntax` prints each command before starting it. `--include-user` reads files in your home directory and never sends them anywhere. `--fix --write` is the only option that changes files, and only repository files.

## Web page

[`web/`](web) is a static page that runs the same engine in the browser with the offline tokenizer only. Drop a repository folder or paste files; nothing is uploaded.

It can also load a public GitHub repository: it lists the files with the GitHub API (`api.github.com`, unauthenticated, 60 requests per hour) and downloads only the instruction files, and files they `@import`, from `raw.githubusercontent.com`. Those are the only network requests the page makes, and only when you load a repository or open a `?repo=` link.

```bash
npm run build:web
```

## Badge

```bash
npx turntax --badge
```

[![context tax (o200k)](https://img.shields.io/badge/context%20tax%20(o200k)-297%20tokens%2Fturn-brightgreen)](https://github.com/TorutDev/turntax)

The badge shows the largest always-loaded total among the tools found, counted with o200k_base: repository files plus measured project MCP tools, never user-level files.

## Limits

- Assumes the agent starts at the repository root. User-level files are counted only with `--include-user`; rules kept in an app's settings or a team dashboard (Cursor user rules, Copilot organization instructions) are not counted.
- Counts instruction files and, with `--mcp`, MCP tool definitions; not the agent's own system prompt or built-in tools.
- Loading rules change. Each rule cites the vendor page and the date it was checked; please open an issue when one is out of date.

## Contributing

Loading rules and prices go out of date. Corrections with a link to the vendor's page are the most useful contribution; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
