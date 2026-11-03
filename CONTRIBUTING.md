# Contributing

Thanks for helping. The most valuable contributions keep turntax accurate as the agents change.

## Updating a loading rule or a price

Agents change how they load instruction files, and vendors change prices.

- **Loading rules** live in [`src/core/tools.ts`](src/core/tools.ts). Each tool lists its source pages and a `checkedAt` date.
- **Prices** live in [`src/core/prices.ts`](src/core/prices.ts), with a `source` URL and `checkedAt` date per model.

A change needs a link to the vendor's official page that shows the new behaviour or price. Third-party blog posts are not enough. Update `checkedAt`, add or adjust a test, and mention the source in the pull request.

Each week [`docs-watch.yml`](.github/workflows/docs-watch.yml) compares the source pages of the loading rules with the week before and opens an issue labelled `docs-watch` when lines about loading changed, a page moved or is gone, or a page that used to be readable fails two runs in a row. A changed page does not mean a rule is wrong; check it against the rule, then update the rule and `checkedAt` if the behaviour changed. Pages that have only ever rendered with JavaScript (TRAE's docs) cannot be compared this way and are listed as unreadable in the job summary, so they still need a check by hand. The CLI warns when a reported agent's `checkedAt` is more than 90 days old.

Two rules are not negotiable:

- Claude and Gemini counts come only from their vendor APIs. Never map them to an offline tokenizer.
- Every number in the output says how it was counted (exact, estimate, API count).

## Development

Requires Node.js 22 or later.

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build       # CLI into dist/
npm run build:web   # web page bundle into web/app.js
node dist/bin.js test/fixtures/mixed
```

Tests use the small repositories in [`test/fixtures`](test/fixtures). Add a fixture or an in-memory file list for new behaviour rather than relying on a real repository.

## Pull requests

- Keep changes focused; one rule or feature per pull request.
- Add or update tests, and make sure `npm test` and `npm run typecheck` pass.
- No new runtime dependencies without discussion. Pin exact versions.
- No telemetry and no network calls outside the opt-in `--claude-api`, `--gemini-api` and `--translate` paths.

## Reporting issues

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
