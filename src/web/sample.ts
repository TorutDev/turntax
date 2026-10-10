import type { RepoFile } from '../core/types.js';

/** A small made-up repository used by the "Try a sample repo" button. */
export const SAMPLE_REPO: RepoFile[] = [
  {
    path: 'AGENTS.md',
    text: `# Agent instructions

Use pnpm for installs and scripts in this repository.
Run \`pnpm run test\` before every commit and keep commits small.
Never commit secrets, tokens or credentials to the repository.
Prefer small, pure functions and early returns.
Write tests next to the code they cover.

## Web app

The web app lives in \`apps/web/\`. Components are in \`apps/web/components/\`.
Pages in \`apps/web/pages/\` must stay server-rendered; do not add client-only data fetching.
Shared styles are in \`apps/web/styles/\` and use CSS variables only; never hard-code colours or spacing.
Every component in \`apps/web/components/\` needs a story, a visual regression snapshot and an accessibility check.
Data loading for pages goes through \`apps/web/lib/api.ts\`; do not call the backend directly from components.
Forms in \`apps/web/components/forms/\` validate on the server as well as the client.
`,
  },
  {
    path: 'CLAUDE.md',
    text: `# Project guide

Use npm for installs and scripts in this repository.
Run \`pnpm run test\` before every commit and keep commits small.
Never commit secrets, tokens or credentials to the repository.
Prefer small, pure functions and early returns.
`,
  },
  {
    path: '.cursor/rules/style.mdc',
    text: `---
alwaysApply: true
---
Use 2 spaces for indentation and single quotes in TypeScript.
`,
  },
  {
    path: '.cursor/rules/legacy.md',
    text: `This rule uses the .md extension, so Cursor never reads it.
`,
  },
  {
    path: '.github/copilot-instructions.md',
    text: `Answer in English and keep code suggestions minimal.
`,
  },
  {
    path: 'GEMINI.md',
    text: `Prefer small pull requests that change one thing at a time.
`,
  },
];
