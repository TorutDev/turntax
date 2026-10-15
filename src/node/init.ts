import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { FileChange } from '../core/fix.js';
import { TOOL_IDS } from '../core/tools.js';
import type { ToolId } from '../core/types.js';
import { applyChanges } from './apply.js';
import { CONFIG_FILE } from './config.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const WORKFLOW_FILE = '.github/workflows/turntax.yml';

const HELP = `Usage: turntax init [path] [options]
Add the turntax GitHub Action and a ${CONFIG_FILE} to a repository.

Writes ${WORKFLOW_FILE}, which runs turntax on every pull request, and ${CONFIG_FILE}
that lists no agents (every agent that reads a file is reported). Existing files are kept unless --force.

  path                    Repository root (default: .)

Options:
  --tools <list>          Agents for the config: ${TOOL_IDS.join(', ')}
                          (default: none, so every agent that reads a file is reported and gated)
  --max-increase <n>      Fail a pull request when an agent's per-turn tokens grow by more than n (default: 500)
  --force                 Overwrite existing files
  --dry-run               Print the files instead of writing them
  -h, --help              Show help

Exit codes: 0 ok, 1 nothing was written because a file could not be written safely, 2 usage error.
`;

/** `turntax init`: adds the GitHub Action workflow and a turntax.config.json to a repository. */
export async function runInit(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tools: { type: 'string' },
        'max-increase': { type: 'string' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const usage = (message: string) => {
    process.stderr.write(`turntax: ${message}\n`);
    return 2;
  };
  if (positionals.length > 1) return usage('init takes one path.');
  const root = resolve(positionals[0] ?? '.');
  if (!isFolder(root)) return usage(`${root} is not a folder.`);
  const increase = o['max-increase'] ?? '500';
  if (!/^\d+$/.test(increase)) return usage('--max-increase must be a non-negative integer');

  // Without --tools the config names no agents, so the report and the pull request gate cover every agent
  // that reads a file, including agents whose files are added later.
  let tools: ToolId[] = [];
  if (o.tools !== undefined) {
    const given = o.tools.split(',').map((s) => s.trim()).filter(Boolean);
    if (!given.length) return usage('--tools needs at least one tool.');
    const unknown = given.find((t) => !TOOL_IDS.includes(t as ToolId));
    if (unknown) return usage(`Unknown tool "${unknown}". Use: ${TOOL_IDS.join(', ')}`);
    tools = TOOL_IDS.filter((id) => given.includes(id));
  }
  if (!existsSync(join(root, '.git')))
    process.stderr.write(`turntax: ${root} has no .git; GitHub runs only workflows in .github/workflows at the repository root.\n`);

  const files = [
    { path: WORKFLOW_FILE, text: workflow(Number(increase)), note: '' },
    {
      path: CONFIG_FILE,
      text: JSON.stringify(tools.length ? { tools, ignore: [] } : { ignore: [] }, null, 2) + '\n',
      note: tools.length
        ? ` (tools: ${tools.join(', ')}; agents outside this list are not reported or gated)`
        : ' (every agent that reads a file is reported; add "tools" to limit it)',
    },
  ];
  const dry = Boolean(o['dry-run']);
  const out: string[] = [];
  const changes: FileChange[] = [];
  try {
    for (const f of files) {
      const existing = lstatSync(join(root, f.path), { throwIfNoEntry: false });
      if (existing && !o.force) {
        out.push(`${dry ? 'would skip' : 'skipped'} ${f.path} (exists; --force overwrites it)`);
        continue;
      }
      if (existing && !existing.isFile()) throw new Error(`${f.path} is not a regular file; nothing was written.`);
      changes.push({ path: f.path, before: existing ? readFileSync(join(root, f.path), 'utf8') : null, after: f.text });
      const verb = existing ? (dry ? 'would overwrite' : 'overwritten') : dry ? 'would create' : 'created';
      out.push(dry ? `${verb} ${f.path}${f.note}:\n\n${f.text}` : `${verb} ${f.path}${f.note}`);
    }
    if (!dry && changes.length) applyChanges(root, changes);
  } catch (e) {
    process.stderr.write(`turntax: ${(e as Error).message}\n`);
    return 1;
  }

  if (dry) out.push('Dry run: nothing was written.');
  else if (changes.length) {
    const fix = positionals[0] && positionals[0] !== '.' ? `npx turntax ${quote(positionals[0])} --fix` : 'npx turntax --fix';
    out.push(
      '',
      'Next steps:',
      `  - Commit ${changes.map((c) => c.path).join(' and ')}.`,
      '  - On every pull request the Action comments with the per-turn token change and marks findings on the changed lines.',
      `  - Run ${fix} to preview safe fixes; add --write to apply them.`,
    );
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Matches the README's Action example; tools come from the config file. */
function workflow(maxIncrease: number): string {
  return `name: turntax
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  turntax:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: TorutDev/turntax@v${VERSION}
        with:
          ${`max-increase: ${maxIncrease}`.padEnd(22)} # fail when an agent grows by more than this many tokens per turn
          # max-tokens: 8000     # optional: absolute budget
          # annotations: false   # optional: no findings on the changed lines
`;
}

function quote(s: string): string {
  return /^[\w./@:,=-]+$/.test(s) ? s : `"${s}"`;
}
