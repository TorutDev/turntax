import { planFixes, type FixPlan } from '../core/fix.js';
import type { RepoFile, ToolId } from '../core/types.js';
import { existsIn, linkedPaths } from './discover.js';

/**
 * Safe fixes. The plan sees every repository file, ignored ones included, because the agents still read
 * them and the safety check must see what they read; symlinks, their targets and ignored files are never
 * written.
 */
export function fixPlan(root: string, discovered: RepoFile[], tools: ToolId[] | undefined, ignored: (path: string) => boolean): FixPlan {
  const linked = linkedPaths(root, discovered);
  return planFixes(discovered, {
    tools,
    exists: existsIn(root),
    readOnly: (p) => (ignored(p) ? `${p} is in the config's ignore list; it is left alone.` : linked(p)),
  });
}

/** The lines `--fix` prints before the diff: each fix with its saving, then each skipped fix with the reason. */
export function fixLines(plan: FixPlan): string[] {
  return [
    ...plan.fixes.map((f) => `fix: ${f.message}${f.savingTokens ? ` [saves ~${f.savingTokens} tokens/turn]` : ''}`),
    ...plan.skipped.map((s) => `skipped ${s.kind}: ${s.reason}`),
  ];
}
