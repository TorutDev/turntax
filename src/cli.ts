import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hasNonEnglish } from './core/advice.js';
import { audit, type AuditOptions } from './core/audit.js';
import { classify } from './core/classify.js';
import { DEFAULT_MODEL_IDS, MODELS, validateModels } from './core/prices.js';
import { badgeMarkdown, headlineTokens, renderMarkdown, renderText } from './core/render.js';
import { TOOL_IDS } from './core/tools.js';
import type { ModelInfo, ToolId } from './core/types.js';
import { discover, existsIn, packageScripts } from './node/discover.js';
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
  --out <file>            Write the report to a file instead of stdout
  --badge                 Print a shields.io badge snippet
  --max-tokens <n>        Exit with code 1 if any tool loads more than n o200k tokens per turn
  --claude-api            Count Claude tokens with Anthropic's count_tokens (needs ANTHROPIC_API_KEY;
                          sends file contents to api.anthropic.com)
  --gemini-api            Count Gemini tokens with Google's countTokens (needs GEMINI_API_KEY;
                          sends file contents to generativelanguage.googleapis.com)
  --english <file=en>     English version of a file, to measure its language token multiplier (repeatable)
  --translate             Translate non-English files to English with Claude to measure the multiplier
                          (needs --claude-api; sends those files to api.anthropic.com)
  --prices <file.json>    Use your own price table (same shape as --list-models --json)
  --section-tokens <n>    Flag always-loaded sections at or above n o200k tokens (default: 600)
  -h, --help              Show help
  -v, --version           Show version

Without --claude-api or --gemini-api nothing leaves your machine.
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

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
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
        out: { type: 'string' },
        badge: { type: 'boolean' },
        'max-tokens': { type: 'string' },
        'claude-api': { type: 'boolean' },
        'gemini-api': { type: 'boolean' },
        english: { type: 'string', multiple: true },
        translate: { type: 'boolean' },
        prices: { type: 'string' },
        'section-tokens': { type: 'string' },
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

    const modelIds = list(o.models) ?? DEFAULT_MODEL_IDS.filter((id) => catalog.some((m) => m.id === id));
    const models = modelIds.map((id) => {
      const m = catalog.find((x) => x.id === id);
      if (!m) throw new UsageError(`Unknown model "${id}". Run --list-models.`);
      return m;
    });
    const tools = list(o.tools) as ToolId[] | undefined;
    for (const t of tools ?? []) if (!TOOL_IDS.includes(t)) throw new UsageError(`Unknown tool "${t}". Use: ${TOOL_IDS.join(', ')}`);

    const root = resolve(positionals[0] ?? '.');
    const files = await discover(root);

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
      turns: positiveInt('turns', o.turns, 100),
      advice: {
        exists: existsIn(root),
        packageScripts: packageScripts(root),
        english,
        sectionTokens: positiveInt('section-tokens', o['section-tokens'], 600),
      },
    });

    const output = o.json
      ? JSON.stringify({ root, ...report }, null, 2) + '\n'
      : o.md
        ? renderMarkdown(report)
        : o.badge
          ? badgeMarkdown(report) + '\n'
          : renderText(report, root) + '\n';
    if (o.out) writeFileSync(o.out, output);
    else process.stdout.write(output);

    const max = o['max-tokens'] === undefined ? undefined : positiveInt('max-tokens', o['max-tokens'], 0);
    if (max !== undefined && headlineTokens(report) > max) {
      process.stderr.write(`turntax: ${headlineTokens(report)} o200k tokens per turn exceeds --max-tokens ${max}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`turntax: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`turntax: ${(e as Error).message}\n`);
    return 1;
  }
}

function notice(message: string): void {
  process.stderr.write(`turntax: ${message}\n`);
}

function describeModel(m: ModelInfo): string {
  const counting =
    m.offline === 'o200k-exact' ? 'offline exact' : m.offline === 'o200k-proxy' ? 'offline proxy (o200k)' : 'API only';
  return `${m.id.padEnd(20)} ${m.label.padEnd(26)} in $${m.inputPerMTok ?? 'n/a'}  cached $${m.cachedInputPerMTok ?? 'n/a'}  ${counting}  (${m.checkedAt})`;
}

