import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Integration test runner using a REAL Extension Development Host (not a mock), per the
 * "Testing" requirement that OdooLens's VS Code-dependent layers (language features, commands,
 * webviews) be exercised end-to-end rather than only unit-tested against the framework-
 * independent parser/index/analyzer layer (see tests/**\/*.test.ts for those).
 *
 * ENVIRONMENT NOTE: `@vscode/test-electron` downloads a real VS Code binary on first run, from
 * update.code.visualstudio.com / az764295.vo.msecnd.net. Sandboxed CI/build environments that
 * only allow an npm-registry-scoped egress allowlist (as this project's own dev container does)
 * cannot reach that download and this script will fail with a network error there — that is
 * expected, not a bug in the test itself. Run `npm run test:integration` on a machine/CI runner
 * with normal internet access (or a machine that already has a cached VS Code test binary).
 */
async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const workspacePath = path.resolve(__dirname, '../../tests/fixtures/basic_odoo');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, '--disable-extensions'],
    });
  } catch (err) {
    console.error('Failed to run VS Code integration tests:', err);
    process.exit(1);
  }
}

void main();
