# Project guide

<!-- maintainer note: this comment is stripped by Claude Code and costs nothing -->

Always use pnpm for installs and scripts in this repository.
Run the full test suite with `pnpm run test` before every commit you make.
Keep functions small and name them after what they return, not how they work.
Never commit secrets, tokens or credentials to the repository under any circumstances.

See @docs/extra.md for the release checklist.

## API package

The API lives in `packages/api/` and its handlers are in `packages/api/handlers/`.
Every handler in `packages/api/handlers/` must validate input with the shared schema module.
Database access goes through `packages/api/db.ts` only; do not import the driver elsewhere.
Write integration tests for handlers next to them in `packages/api/handlers/`.
Use structured logging in the API package and never log request bodies or headers.
Return problem+json errors from the API with a stable error code for each failure.

Old helpers were in `src/legacy/helpers.ts` and must not be used.
