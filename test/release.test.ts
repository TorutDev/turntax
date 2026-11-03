import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version: string = JSON.parse(read('package.json')).version;

describe('version pins', () => {
  // These run the published package or name a release, so they must move with package.json.
  it.each([
    ['.pre-commit-hooks.yaml', `npx --yes turntax@${version}`],
    ['plugins/turntax/.claude-plugin/plugin.json', `"turntax@${version}"`],
    ['plugins/turntax/.claude-plugin/plugin.json', `"version": "${version}"`],
    ['.claude-plugin/marketplace.json', `"version": "${version}"`],
    ['server.json', `"version": "${version}"`],
    ['README.md', `uses: TorutDev/turntax@v${version}`],
    ['README.md', `rev: v${version}`],
  ])('%s has %s', (path, pin) => {
    expect(read(path)).toContain(pin);
  });
});
