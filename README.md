# turntax

Coding agents re-send their instruction files with every turn. `turntax` measures that fixed per-turn cost for a repository, per tool and per model, and shows where to cut it.

```bash
npx turntax
```

It reads the files each agent actually loads (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`, `.github/copilot-instructions.md`, Windsurf rules, skills) and applies each tool's documented loading rules: what is sent on every turn, what loads only when the agent works in a folder or touches a matching file, and what is ignored.

```text
tool          always  o200k/turn  on-demand  model              tokens/turn  counted by                                100 turns  cached
Claude Code   4       272         53         Claude Sonnet 5.5  -            needs --claude-api and ANTHROPIC_API_KEY  -          -
OpenAI Codex  1       63          0          GPT-6.1 Sol        63           estimate (o200k_base proxy)               $0.01      $0.0006
Cursor        4       297         37         Claude Sonnet 5.5  -            needs --claude-api and ANTHROPIC_API_KEY  -          -
                                             GPT-6.1 Sol        297          estimate (o200k_base proxy)               $0.06      $0.0030

Advice (savings are estimates in o200k tokens per turn)
  HIGH duplicate CLAUDE.md, AGENTS.md [saves ~48 tokens/turn]
    3 identical lines are loaded twice every turn by cursor. Keep them in one file.
  HIGH contradiction AGENTS.md, CLAUDE.md [saves ~11 tokens/turn]
    Conflicting package manager: "Always use npm ..." (AGENTS.md:3) vs "Always use pnpm ..." (CLAUDE.md:5).
  MEDIUM scopable-section CLAUDE.md:11 [saves ~128 tokens/turn]
    Section "API package" is mostly about packages/api/. Move it to packages/api/AGENTS.md ...
```

(Output for [`test/fixtures/mixed`](test/fixtures/mixed).)

## What it counts, and how

| Model family | How tokens are counted | Label |
| --- | --- | --- |
| OpenAI GPT-5.x, gpt-oss | Offline with `o200k_base` (the encoding OpenAI's tiktoken maps them to) | exact |
| OpenAI GPT-6.x | Offline with `o200k_base`; OpenAI has not published a newer encoding | estimate |
| Claude | Only Anthropic's `count_tokens` API, with your key and `--claude-api` | API count |
| Gemini | Only Google's `countTokens` API, with your key and `--gemini-api` | API count |

Claude's tokenizer is not public, and Anthropic's docs note that newer Claude models produce noticeably more tokens than older ones for the same text. `turntax` never shows an OpenAI count as a Claude or Gemini number: without a key those rows say "needs API key". The `o200k` column is a labelled reference count for every file.

Cost per N turns = tokens per turn × N × input price. The "cached" column assumes every turn reads the context from the prompt cache. Prices come from a dated table with a source link per model (`turntax --list-models`); pass `--prices my-prices.json` to use your own.

See [docs/how-it-counts.md](docs/how-it-counts.md) for the loading rules per tool and their sources.

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

## Options

```text
turntax [path]
  --tools claude-code,codex,gemini-cli,cursor,copilot,windsurf
  --models <ids>            see --list-models (default: claude-sonnet-5.5, gpt-6.1-sol, gemini-3.8-flash)
  --turns <n>               cost projection (default 100)
  --json | --md | --badge   output format (default: terminal table)
  --out <file>              write the output to a file
  --max-tokens <n>          exit 1 when any tool loads more than n o200k tokens per turn (CI gate)
  --claude-api              exact Claude counts (ANTHROPIC_API_KEY)
  --gemini-api              Gemini counts (GEMINI_API_KEY)
  --english <file=en>       measure a language multiplier against your English version
  --translate               opt-in Claude translation for that measurement (needs --claude-api)
  --prices <file.json>      your own price table
  --section-tokens <n>      threshold for oversized sections (default 600)
```

## Privacy

Offline by default: no network calls, no telemetry. File contents are sent only when you pass `--claude-api`, `--gemini-api` or `--translate`, and only to that vendor's API. Keys are read from environment variables and sent only in request headers.

## Web page

[`web/`](web) is a static page that runs the same engine in the browser with the offline tokenizer only. Drop a repository folder or paste files; nothing is uploaded.

Try it: https://torutdev.github.io/turntax/

```bash
npm run build:web
```

## Badge

```bash
npx turntax --badge
```

[![context tax (o200k)](https://img.shields.io/badge/context%20tax%20(o200k)-297%20tokens%2Fturn-brightgreen)](https://github.com/TorutDev/turntax)

The badge shows the largest always-loaded total among the tools found, counted with o200k_base.

## Limits

- Assumes the agent starts at the repository root. Files outside the repository (user-level `~/.claude/CLAUDE.md`, global rules, team rules in a dashboard) are not counted.
- Counts instruction files only, not the agent's own system prompt, tool definitions or MCP servers.
- Loading rules change. Each rule cites the vendor page and the date it was checked; please open an issue when one is out of date.

## Contributing

Loading rules and prices go out of date. Corrections with a link to the vendor's page are the most useful contribution; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
