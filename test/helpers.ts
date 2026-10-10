import { fileURLToPath } from 'node:url';
import { discover } from '../src/node/discover.js';
import type { LoadedUnit, RepoFile, ToolId } from '../src/core/types.js';

export const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const loadFixture = (name: string): Promise<RepoFile[]> => discover(fixture(name));

export function find(units: LoadedUnit[], tool: ToolId, path: string, part: LoadedUnit['part'] = 'full'): LoadedUnit | undefined {
  return units.find((u) => u.tool === tool && u.path === path && u.part === part);
}
