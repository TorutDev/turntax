import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { headlineTokens } from '../../src/core/render.js';

/**
 * Opens test/fixtures/mixed in VS Code 1.95.0 (the engines floor) with the extension under development and
 * runs suite.js in its extension host. The expected headline comes from the CLI, so both must agree.
 */
async function main(): Promise<void> {
  // Bundled into vscode/dist/test.
  const extension = resolve(__dirname, '../..');
  const repo = resolve(extension, '..');
  const cli = resolve(repo, 'dist/bin.js');
  if (!existsSync(cli)) throw new Error(`${cli} is missing: run npm run build in the repository root first.`);
  const fixture = resolve(repo, 'test/fixtures/mixed');
  const report = JSON.parse(execFileSync(process.execPath, [cli, fixture, '--json'], { encoding: 'utf8' }));
  await runTests({
    version: '1.95.0',
    cachePath: resolve(extension, '.vscode-test'),
    extensionDevelopmentPath: extension,
    extensionTestsPath: resolve(__dirname, 'suite.js'),
    extensionTestsEnv: { TURNTAX_EXPECTED_HEADLINE: String(headlineTokens(report)), TURNTAX_REPO: repo },
    launchArgs: [fixture, '--disable-extensions'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
