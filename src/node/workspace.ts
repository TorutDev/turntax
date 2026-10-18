import { audit, type Report } from '../core/audit.js';
import type { FixPlan } from '../core/fix.js';
import { globMatcher } from '../core/glob.js';
import { parseMcpConfigs, type ParsedMcpConfig } from '../core/mcp.js';
import { DEFAULT_MODEL_IDS, MODELS } from '../core/prices.js';
import type { ToolId } from '../core/types.js';
import { loadConfig } from './config.js';
import { discover, discoverMcpConfigs, existsIn, packageScripts } from './discover.js';
import { fixPlan } from './fix-plan.js';

/**
 * Shared setup of the MCP server and the VS Code extension: a folder audited and fixed as the CLI does
 * without flags, with its turntax.config.json. Read-only; invalid configs throw.
 */

export interface WorkspaceAudit {
  report: Report;
  /** Project MCP config files that could not be parsed. */
  problems: ParsedMcpConfig['problems'];
}

/** The report `turntax <root>` makes: config, ignored files, project MCP configs. `tools` and `models` override the config. */
export async function auditWorkspace(root: string, { tools, models }: { tools?: ToolId[]; models?: string[] } = {}): Promise<WorkspaceAudit> {
  const config = loadConfig(root, undefined, MODELS);
  const ignored = globMatcher(config.ignore ?? []);
  const files = (await discover(root)).filter((f) => !ignored(f.path));
  const mcp = parseMcpConfigs(discoverMcpConfigs(root), root);
  const report = await audit(files, {
    tools: tools ?? config.tools,
    models: (models ?? config.models ?? DEFAULT_MODEL_IDS).flatMap((id) => MODELS.filter((m) => m.id === id)),
    turns: config.turns ?? 100,
    mcp: { servers: mcp.servers },
    advice: { exists: existsIn(root), packageScripts: packageScripts(root), sectionTokens: config.sectionTokens ?? 600 },
  });
  return { report, problems: mcp.problems };
}

/** The safe fixes `turntax --fix` plans for `root`, keeping the context of `tools` (default: the config's, else every agent). */
export async function planWorkspaceFixes(root: string, tools?: ToolId[]): Promise<FixPlan> {
  const config = loadConfig(root, undefined, MODELS);
  return fixPlan(root, await discover(root), tools ?? config.tools, globMatcher(config.ignore ?? []), config.sectionTokens);
}
