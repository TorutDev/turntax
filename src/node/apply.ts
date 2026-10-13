import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { FileChange } from '../core/fix.js';
import { realLocation } from './discover.js';

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Writes planned changes under `root`. Every file is checked first: files to change must still have the
 * content the plan was made from, new files must not exist, and nothing may be written through a symlink
 * (dangling ones included) or outside the repository. Nothing is written when a check fails.
 */
export function applyChanges(root: string, changes: FileChange[]): void {
  const realRoot = realpathSync(root);
  const exists = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  const abs = (path: string) => {
    const p = resolve(root, path);
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} is a symlink; nothing was written.`);
    const real = realLocation(p);
    if (!inside(root, p) || real === null || !inside(realRoot, real)) throw new Error(`${path} is outside ${root}; nothing was written.`);
    return p;
  };
  for (const c of changes) {
    const source = c.renamedFrom ?? c.path;
    if (c.renamedFrom && exists(abs(c.path))) throw new Error(`${c.path} already exists; nothing was written.`);
    if (c.before === null ? exists(abs(c.path)) : !exists(abs(source)) || readFileSync(abs(source), 'utf8') !== c.before)
      throw new Error(`${source} ${c.before === null ? 'already exists' : 'changed since it was read'}; nothing was written.`);
  }
  for (const c of changes) {
    const target = abs(c.path);
    mkdirSync(dirname(target), { recursive: true });
    if (c.renamedFrom) renameSync(abs(c.renamedFrom), target);
    // New files are created exclusively, so a link placed in the meantime is not followed.
    if (c.before === null) writeFileSync(target, c.after, { flag: 'wx' });
    else if (c.after !== c.before || !c.renamedFrom) writeFileSync(target, c.after);
  }
}
