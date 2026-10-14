import { planFixes, unifiedDiff, type FixPlan } from '../core/fix.js';
import type { RepoFile, ToolId } from '../core/types.js';

/** What the page knows about the loaded source, for planning fixes. */
export interface FixSource {
  files: RepoFile[];
  /** Repo-relative paths of a loaded repository or folder, beyond the loaded files. */
  paths?: Iterable<string>;
  /** Symlinks and the in-repo paths they point to (GitHub only; browsers follow links in local folders). */
  linked?: Iterable<string>;
}

export interface WebFixPlan extends FixPlan {
  /** The changes as a patch for `git apply`; empty when nothing changes. */
  diff: string;
}

/** A folder exists when some known path lies under it. */
export function folderExists(paths: Iterable<string>): (folder: string) => boolean {
  const dirs = new Set<string>();
  for (const p of paths) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i));
  return (folder) => dirs.has(folder);
}

/** A path is linked when it, or a folder it lies in, is a symlink or a symlink's target. */
export function linkedCheck(linked: Iterable<string>): (path: string) => boolean {
  const set = new Set(linked);
  return (path) => {
    for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) if (set.has(path.slice(0, i))) return true;
    return set.has(path);
  };
}

/** Runs the CLI's --fix planning on the loaded files; `tools` narrows the agents whose context is kept. */
export function planWebFixes(src: FixSource, tools?: ToolId[]): WebFixPlan {
  const loaded = new Set(src.files.map((f) => f.path));
  const known = new Set([...(src.paths ?? []), ...loaded]);
  const linked = linkedCheck(src.linked ?? []);
  const plan = planFixes(src.files, {
    tools,
    exists: folderExists(known),
    // A repository file that is not loaded (removed from the list, or not downloaded) is never written over.
    readOnly: (path) => linked(path) || (known.has(path) && !loaded.has(path)),
  });
  return { ...plan, diff: unifiedDiff(plan.changes) };
}
