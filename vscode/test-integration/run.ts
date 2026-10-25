import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { headlineTokens } from '../../src/core/render.js';

/**
 * Opens a copy of test/fixtures/mixed in VS Code 1.95.0 (the engines floor) with the extension under
 * development and runs suite.js in its extension host. The suite applies fixes, so it gets a fresh copy in
 * the temp folder, trusted so that Apply is allowed. The expected headline comes from the CLI, so both must agree.
 */
async function main(): Promise<void> {
  // Bundled into vscode/dist/test.
  const extension = resolve(__dirname, '../..');
  const repo = resolve(extension, '..');
  const cli = resolve(repo, 'dist/bin.js');
  if (!existsSync(cli)) throw new Error(`${cli} is missing: run npm run build in the repository root first.`);
  const folder = mkdtempSync(join(tmpdir(), 'turntax-vscode-'));
  try {
    cpSync(resolve(repo, 'test/fixtures/mixed'), folder, { recursive: true });
    const report = JSON.parse(execFileSync(process.execPath, [cli, folder, '--json'], { encoding: 'utf8' }));
    await runTests({
      version: '1.95.0',
      cachePath: resolve(extension, '.vscode-test'),
      extensionDevelopmentPath: extension,
      extensionTestsPath: resolve(__dirname, 'suite.js'),
      extensionTestsEnv: { TURNTAX_EXPECTED_HEADLINE: String(headlineTokens(report)), TURNTAX_REPO: repo },
      launchArgs: [folder, '--disable-extensions', '--disable-workspace-trust'],
    });
  } finally {
    // A folder VS Code still holds must not turn a passing run into a failure.
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.warn(`Could not remove ${folder}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
