import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../src/node/discover.js';
import type { LoadedUnit, RepoFile, ToolId } from '../src/core/types.js';

export const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const loadFixture = (name: string): Promise<RepoFile[]> => discover(fixture(name));

export function find(units: LoadedUnit[], tool: ToolId, path: string, part: LoadedUnit['part'] = 'full'): LoadedUnit | undefined {
  return units.find((u) => u.tool === tool && u.path === path && u.part === part);
}

/**
 * Copies a fixture to a temporary folder and adds files that cannot live in the repository under their
 * real names (agent config paths such as .mcp.json or .claude/ that tools refuse to write or that would
 * configure an agent working on this repository).
 */
export function materialize(name: string, extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `turntax-${name}-`));
  cpSync(fixture(name), dir, { recursive: true });
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

export const MCP_FIXTURE_FILES: Record<string, string> = {
  '.mcp.json': `{
  "mcpServers": {
    "docs": { "command": "node", "args": ["server.mjs"] },
    "broken": { "command": "node", "args": ["-e", "process.exit(3)"] },
    "socket": { "type": "ws", "url": "wss://example.invalid/socket" }
  }
}
`,
  // Copilot CLI also accepts a bare server map; its required tools list keeps one of the two tools.
  '.github/mcp.json': `{
  "search": { "type": "local", "command": "node", "args": ["server.mjs"], "tools": ["search_docs"] }
}
`,
  '.gemini/settings.json': `{
  "mcpServers": { "docs": { "command": "node", "args": ["server.mjs"], "excludeTools": ["open_ticket"] } }
}
`,
  '.vscode/mcp.json': `{
  // VS Code accepts comments and trailing commas.
  "inputs": [{ "id": "token", "type": "promptString" }],
  "servers": {
    "remote": { "type": "http", "url": "https://example.invalid/mcp", "headers": { "Authorization": "Bearer \${input:token}" } },
  },
}
`,
};

export const HOME_FIXTURE_FILES: Record<string, string> = {
  '.claude/CLAUDE.md': `# Personal preferences

- Answer in English and keep explanations short.
- Always run the full test suite before you say a change is done.
`,
  '.claude/rules/style.md': 'Prefer small, focused commits with descriptive messages.\n',
  '.claude.json': `{
  "numStartups": 3,
  "mcpServers": { "personal": { "command": "node", "args": ["personal.mjs"] } },
  "projects": { "/somewhere/else": { "mcpServers": { "other": { "command": "x" } } } }
}
`,
};

/** test/fixtures/mcp with its MCP configs. */
export const mcpFixture = (): string => materialize('mcp', MCP_FIXTURE_FILES);

/** test/fixtures/home with its ~/.claude files. */
export const homeFixture = (): string => materialize('home', HOME_FIXTURE_FILES);
