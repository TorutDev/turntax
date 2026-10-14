import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, posix, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hasNonEnglish } from './core/advice.js';
import { audit, type AuditOptions, type McpMeasurement } from './core/audit.js';
import { classify } from './core/classify.js';
import { asDiffInput, diffReports, maxIncrease } from './core/diff.js';
import { planFixes, unifiedDiff, type FixPlan } from './core/fix.js';
import { globMatcher } from './core/glob.js';
import { parseMcpConfigs, serverKey, toolDefinitionsText, toolNamesText, type McpServer } from './core/mcp.js';
import { DEFAULT_MODEL_IDS, MODELS, validateModels } from './core/prices.js';
import { badgeMarkdown, headlineTokens, renderAnnotations, renderMarkdown, renderPrComment, renderText } from './core/render.js';
import { countO200k } from './core/tokenize.js';
import { TOOL_IDS } from './core/tools.js';
import type { ModelInfo, RepoFile, ToolId } from './core/types.js';
import { applyChanges } from './node/apply.js';
import { CONFIG_FILE, loadConfig, type Config } from './node/config.js';
import { discover, discoverMcpConfigs, discoverUser, existsIn, linkedPaths, packageScripts } from './node/discover.js';
import { filesAtRef } from './node/git.js';
import { measureServer } from './node/mcp.js';
import { anthropicCounter, geminiCounter, translateToEnglish } from './node/remote.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `turntax ${VERSION}
Measure the token tax that agent instruction files add to every turn.

Usage: turntax [path] [options]

Options:
  --tools <list>          Tools to report: ${TOOL_IDS.join(', ')} (default: tools with files)
  --models <list>         Model ids to price (default: ${DEFAULT_MODEL_IDS.join(', ')})
  --list-models           Print the price table and exit
  --turns <n>             Turns for the cost projection (default: 100)
  --json                  Print the full report as JSON
  --md                    Print a Markdown report
  --pr-comment            Print a pull request comment: the change first, the full report folded
  --out <file>            Write the report to a file instead of stdout
  --badge                 Print a shields.io badge snippet
  --annotations           Print GitHub Actions annotations for the advice, shown inline on pull requests
  --path-prefix <dir>     With --annotations, the audited folder relative to the repository root
  --max-tokens <n>        Exit with code 1 if any tool loads more than n o200k tokens per turn
                          (repository files plus measured project MCP tools)
  --include-user          Also count user-level files and MCP servers in your home directory
                          (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, ...)
  --mcp                   Start the configured MCP servers and count their tool definitions
                          (runs the commands in .mcp.json and the other agents' MCP configs)
  --mcp-timeout <s>       Seconds to wait for each MCP server (default: 30)
  --baseline <file.json>  Compare with an earlier --json report
  --compare <git-ref>     Compare with the instruction files at a git ref (for example origin/main)
  --max-increase <n>      Exit with code 1 if any tool's per-turn tokens grew by more than n
                          compared with --baseline or --compare
  --claude-api            Count Claude tokens with Anthropic's count_tokens (needs ANTHROPIC_API_KEY;
                          sends file contents to api.anthropic.com)
  --gemini-api            Count Gemini tokens with Google's countTokens (needs GEMINI_API_KEY;
                          sends file contents to generativelanguage.googleapis.com)
  --english <file=en>     English version of a file, to measure its language token multiplier (repeatable)
  --translate             Translate non-English files to English with Claude to measure the multiplier
                          (needs --claude-api; sends those files to api.anthropic.com)
  --prices <file.json>    Use your own price table (same shape as --list-models --json)
  --section-tokens <n>    Flag always-loaded sections at or above n o200k tokens (default: 600)
  --fix                   Print a diff of the safe fixes: duplicate lines, sections that can load only in
                          their folder, misnamed Cursor rules. Every agent keeps reading the moved text;
                          --tools limits the agents whose context is kept
  --write                 With --fix, apply the changes to the files
  --config <file>         Read defaults from this file (default: ${CONFIG_FILE} in the audited folder, if any)
  -h, --help              Show help
  -v, --version           Show version

Config file keys (all optional; command-line flags override them):
  tools, models           Lists of ids, like --tools and --models
  turns, maxTokens, maxIncrease, sectionTokens
                          Integers, like the matching flags (maxIncrease applies only when comparing)
  ignore                  Globs of instruction files to leave out, relative to the audited folder (* and ? within a
                          folder name, ** across folders, a trailing / for a whole folder)

Without --claude-api, --gemini-api or --mcp nothing leaves your machine.
`;

class UsageError extends Error {}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tools: { type: 'string' },
        models: { type: 'string' },
        'list-models': { type: 'boolean' },
        turns: { type: 'string' },
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        'pr-comment': { type: 'boolean' },
        out: { type: 'string' },
        badge: { type: 'boolean' },
        annotations: { type: 'boolean' },
        'path-prefix': { type: 'string' },
        config: { type: 'string' },
        'max-tokens': { type: 'string' },
        'claude-api': { type: 'boolean' },
        'gemini-api': { type: 'boolean' },
        english: { type: 'string', multiple: true },
        translate: { type: 'boolean' },
        prices: { type: 'string' },
        'section-tokens': { type: 'string' },
        'include-user': { type: 'boolean' },
        mcp: { type: 'boolean' },
        'mcp-timeout': { type: 'string' },
        baseline: { type: 'string' },
        compare: { type: 'string' },
        'max-increase': { type: 'string' },
        fix: { type: 'boolean' },
        write: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
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
  if (o.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    let catalog: ModelInfo[] = MODELS;
    if (o.prices) {
      const data = JSON.parse(readFileSync(o.prices, 'utf8'));
      const problems = validateModels(data);
      if (problems.length) throw new UsageError(`Invalid price table ${o.prices}:\n  ${problems.join('\n  ')}`);
      catalog = data;
    }
    if (o['list-models']) {
      process.stdout.write(o.json ? JSON.stringify(catalog, null, 2) + '\n' : catalog.map(describeModel).join('\n') + '\n');
      return 0;
    }

    const root = resolve(positionals[0] ?? '.');
    let config: Config;
    try {
      config = loadConfig(root, o.config, catalog);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const modelIds = list(o.models) ?? config.models ?? DEFAULT_MODEL_IDS.filter((id) => catalog.some((m) => m.id === id));
    const models = modelIds.map((id) => {
      const m = catalog.find((x) => x.id === id);
      if (!m) throw new UsageError(`Unknown model "${id}". Run --list-models.`);
      return m;
    });
    const tools = (list(o.tools) as ToolId[] | undefined) ?? config.tools;
    for (const t of tools ?? []) if (!TOOL_IDS.includes(t)) throw new UsageError(`Unknown tool "${t}". Use: ${TOOL_IDS.join(', ')}`);
    const ignored = globMatcher(config.ignore ?? []);
    const repoFiles = (files: RepoFile[]) => files.filter((f) => !ignored(f.path));

    if (o.write && !o.fix) throw new UsageError('--write needs --fix.');
    if (o['path-prefix'] !== undefined && !o.annotations) throw new UsageError('--path-prefix needs --annotations.');
    if (o.annotations) {
      const other = (['json', 'md', 'pr-comment', 'badge', 'fix'] as const).filter((k) => o[k] !== undefined);
      if (other.length) throw new UsageError(`--annotations cannot be combined with --${other.join(', --')}.`);
    }
    if (o.fix) {
      const other: string[] = (
        ['json', 'md', 'pr-comment', 'badge', 'baseline', 'compare', 'max-tokens', 'max-increase', 'include-user', 'mcp'] as const
      ).filter((k) => o[k] !== undefined);
      if (o.write && o.out) other.push('out');
      if (other.length) throw new UsageError(`--fix${o.write ? ' --write' : ''} cannot be combined with --${other.join(', --')}.`);
      return await fix(root, tools, ignored, Boolean(o.write), o.out);
    }
    const discovered = await discover(root);
    const files = repoFiles(discovered);
    // Budgets in the config are for report runs; an --annotations run only prints findings.
    const gates: Config = o.annotations ? {} : config;
    const label = (flag: 'max-tokens' | 'max-increase', key: keyof Config) =>
      o[flag] !== undefined ? `--${flag}` : `${key} in ${o.config ?? CONFIG_FILE}`;
    if (o.baseline && o.compare) throw new UsageError('Use --baseline or --compare, not both.');
    // The config's maxIncrease applies only when a comparison runs, so plain local runs keep working.
    if (o['max-increase'] !== undefined && !o.baseline && !o.compare)
      throw new UsageError('--max-increase needs --baseline or --compare.');
    const maxIncreaseLimit =
      o['max-increase'] === undefined ? gates.maxIncrease : nonNegativeInt('max-increase', o['max-increase']);
    stalePrices(models, now);

    let userFiles: RepoFile[] = [];
    let mcpFiles = discoverMcpConfigs(root);
    if (o['include-user']) {
      const user = discoverUser(env.HOME || env.USERPROFILE || homedir());
      userFiles = user.files;
      mcpFiles = [...mcpFiles, ...user.mcpConfigs];
    }
    const parsedMcp = parseMcpConfigs(mcpFiles, root);
    for (const p of parsedMcp.problems) notice(`${p.path} ${p.message}`);
    const servers = parsedMcp.servers;
    let measured: Map<string, McpMeasurement> | undefined;
    if (o.mcp) {
      const timeoutMs = positiveInt('mcp-timeout', o['mcp-timeout'], 30) * 1000;
      measured = await measureAll(
        servers.filter((s) => !s.disabled && (!tools || tools.includes(s.tool))),
        root,
        timeoutMs,
        env,
      );
    }

    const counters: AuditOptions['counters'] = {};
    if (o['claude-api']) {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new UsageError('--claude-api needs the ANTHROPIC_API_KEY environment variable.');
      counters.claude = anthropicCounter(key);
      if (models.some((m) => m.family === 'claude')) notice(`Sending instruction file contents to api.anthropic.com to count Claude tokens.`);
    }
    if (o['gemini-api']) {
      const key = env.GEMINI_API_KEY;
      if (!key) throw new UsageError('--gemini-api needs the GEMINI_API_KEY environment variable.');
      counters.gemini = geminiCounter(key);
      if (models.some((m) => m.family === 'gemini')) notice(`Sending instruction file contents to generativelanguage.googleapis.com to count Gemini tokens.`);
    }

    const english = new Map<string, string>();
    for (const pair of o.english ?? []) {
      const [target, source] = pair.split('=');
      if (!target || !source) throw new UsageError(`--english expects file=englishFile, got "${pair}"`);
      english.set(relative(root, resolve(root, target)).replace(/\\/g, '/'), readFileSync(source, 'utf8'));
    }
    if (o.translate) {
      if (!o['claude-api'] || !env.ANTHROPIC_API_KEY) throw new UsageError('--translate needs --claude-api and ANTHROPIC_API_KEY.');
      const always = classify(files, tools).filter((u) => u.mode === 'always' && u.part !== 'description');
      const targets = [...new Set(always.filter((u) => hasNonEnglish(u.text)).map((u) => u.path))];
      for (const path of targets) {
        if (english.has(path)) continue;
        notice(`Translating ${path} with Claude (api.anthropic.com) to measure its language multiplier.`);
        try {
          english.set(path, await translateToEnglish(env.ANTHROPIC_API_KEY, files.find((f) => f.path === path)!.text));
        } catch (e) {
          notice(`Could not translate ${path}: ${(e as Error).message}. Its multiplier is not measured.`);
        }
      }
    }

    const report = await audit(files, {
      tools,
      models,
      counters,
      turns: positiveInt('turns', o.turns, config.turns ?? 100),
      userFiles,
      mcp: { servers, measured },
      advice: {
        exists: existsIn(root),
        packageScripts: packageScripts(root),
        english,
        sectionTokens: positiveInt('section-tokens', o['section-tokens'], config.sectionTokens ?? 600),
      },
    });

    if (o.baseline) {
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(o.baseline, 'utf8'));
      } catch (e) {
        throw new UsageError(`Could not read --baseline ${o.baseline}: ${(e as Error).message}`);
      }
      report.diff = diffReports(asDiffInput(data), report, basename(o.baseline));
    } else if (o.compare) {
      const base = await filesAtRef(root, o.compare).catch((e: Error) => {
        throw new UsageError(e.message);
      });
      const before = await audit(repoFiles(base.files), {
        tools,
        models: [],
        mcp: { servers: parseMcpConfigs(base.mcpConfigs, root).servers },
      });
      report.diff = diffReports(before, report, o.compare);
    }

    const output = o.json
      ? JSON.stringify({ root, ...report }, null, 2) + '\n'
      : o['pr-comment']
        ? renderPrComment(
            report,
            files.length ? fixPlan(root, discovered, tools, ignored) : undefined,
            fixCommand(positionals[0], o.config, o.tools),
          )
        : o.annotations
          ? renderAnnotations(report, pathPrefix(o['path-prefix']))
          : o.md
            ? renderMarkdown(report)
            : o.badge
              ? badgeMarkdown(report) + '\n'
              : renderText(report, root) + '\n';
    if (o.out) writeFileSync(o.out, output);
    else process.stdout.write(output);

    let code = 0;
    const max = o['max-tokens'] === undefined ? gates.maxTokens : positiveInt('max-tokens', o['max-tokens'], 0);
    if (max !== undefined && headlineTokens(report) > max) {
      process.stderr.write(`turntax: ${headlineTokens(report)} o200k tokens per turn exceeds ${label('max-tokens', 'maxTokens')} ${max}\n`);
      code = 1;
    }
    if (maxIncreaseLimit !== undefined && report.diff && maxIncrease(report.diff) > maxIncreaseLimit) {
      process.stderr.write(
        `turntax: per-turn tokens grew by ${maxIncrease(report.diff)} vs ${report.diff.base}, more than ${label('max-increase', 'maxIncrease')} ${maxIncreaseLimit}\n`,
      );
      code = 1;
    }
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`turntax: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`turntax: ${(e as Error).message}\n`);
    return 1;
  }
}

async function fix(
  root: string,
  tools: ToolId[] | undefined,
  ignored: (path: string) => boolean,
  write: boolean,
  out: string | undefined,
): Promise<number> {
  const discovered = await discover(root);
  const plan = fixPlan(root, discovered, tools, ignored);
  const log = (line: string) => (write ? process.stdout : process.stderr).write(line + '\n');
  for (const f of plan.fixes) log(`fix: ${f.message}${f.savingTokens ? ` [saves ~${f.savingTokens} tokens/turn]` : ''}`);
  for (const s of plan.skipped) log(`skipped ${s.kind}: ${s.reason}`);
  if (!plan.changes.length) {
    // An empty patch, so an earlier patch in the same file is not applied again.
    if (out && !write) writeFileSync(out, '');
    log('Nothing to fix automatically.');
    return 0;
  }
  if (write) {
    applyChanges(root, plan.changes);
    log(`Changed ${plan.changes.length} file(s): ${plan.changes.map((c) => c.path).join(', ')}`);
    return 0;
  }
  const diff = unifiedDiff(plan.changes);
  if (out) writeFileSync(out, diff);
  else process.stdout.write(diff);
  log('Preview only. Run again with --write to apply, or save the diff and use git apply.');
  return 0;
}

/**
 * Safe fixes. The plan sees every repository file, ignored ones included, because the agents still read
 * them and the safety check must see what they read; symlinks, their targets and ignored files are never
 * written.
 */
function fixPlan(root: string, discovered: RepoFile[], tools: ToolId[] | undefined, ignored: (path: string) => boolean): FixPlan {
  const linked = linkedPaths(root, discovered);
  return planFixes(discovered, {
    tools,
    exists: existsIn(root),
    readOnly: (p) => (ignored(p) ? `${p} is in the config's ignore list; it is left alone.` : linked(p)),
  });
}

/** The --fix command matching the run that made a pull request comment. */
function fixCommand(path: string | undefined, config: string | undefined, tools: string | undefined): string {
  const arg = (s: string) => (/^[\w./@:,=-]+$/.test(s) ? s : `"${s}"`);
  const parts = ['npx turntax'];
  if (path && path !== '.' && !isAbsolute(path)) parts.push(arg(path));
  if (config) parts.push('--config', arg(config));
  if (tools) parts.push('--tools', arg(tools));
  return [...parts, '--fix'].join(' ');
}

/** `--path-prefix` as a POSIX folder ending in a slash, or '' for the repository root. */
function pathPrefix(dir: string | undefined): string {
  if (!dir) return '';
  const p = posix.normalize(dir.replace(/\\/g, '/') + '/');
  return p === './' ? '' : p;
}

/** One notice when a selected model's price was checked more than 90 days before `now`. */
function stalePrices(models: ModelInfo[], now: Date): void {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const stale = models.filter((m) => today - Date.parse(m.checkedAt) > 90 * 86_400_000);
  if (!stale.length) return;
  const dates = [...new Set(stale.map((m) => m.checkedAt))].sort();
  notice(
    `prices for ${stale.map((m) => m.label).join(', ')} were checked on ${dates.join(', ')}, over 90 days ago; check the sources or pass --prices.`,
  );
}

function nonNegativeInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

/** Starts each distinct server once (several agents often share one) and counts its tool definitions. */
async function measureAll(
  servers: McpServer[],
  root: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, McpMeasurement>> {
  const unique = new Map<string, McpServer>();
  for (const s of servers) if (!unique.has(serverKey(s))) unique.set(serverKey(s), s);
  const out = new Map<string, McpMeasurement>();
  const queue = [...unique.entries()];
  for (const [, s] of queue)
    notice(
      s.transport === 'stdio'
        ? `Starting MCP server "${s.name}" from ${s.configPath}: ${[s.command, ...(s.args ?? [])].join(' ')}`
        : `Connecting to MCP server "${s.name}" from ${s.configPath}: ${s.url}`,
    );
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, s] = next;
      const r = await measureServer(s, { root, timeoutMs, env });
      if (r.tools) {
        out.set(key, { tools: r.tools.length, o200k: countO200k(toolDefinitionsText(r.tools)), namesO200k: countO200k(toolNamesText(r.tools)) });
      } else {
        out.set(key, { error: r.error ?? 'failed' });
        notice(`MCP server "${s.name}" was not measured: ${r.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}

function notice(message: string): void {
  process.stderr.write(`turntax: ${message}\n`);
}

function describeModel(m: ModelInfo): string {
  const counting =
    m.offline === 'o200k-exact' ? 'offline exact' : m.offline === 'o200k-proxy' ? 'offline proxy (o200k)' : 'API only';
  return `${m.id.padEnd(20)} ${m.label.padEnd(26)} in $${m.inputPerMTok ?? 'n/a'}  cached $${m.cachedInputPerMTok ?? 'n/a'}  ${counting}  (${m.checkedAt})`;
}

