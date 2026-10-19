// Same bounded validation on Windows, macOS and Linux. Installs/deploys nothing.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
function run(script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules', script), ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('typescript/bin/tsc', ['--noEmit']);
run('vitest/vitest.mjs', ['run', '--maxWorkers=2']);
// Includes real local multi-client games/chat plus scrollable touch input.
run('@playwright/test/cli.js', ['test'], { HAND_TABLE_VIEW: 'classic' });
// Repeat the complete hand legality/cancellation/layout suite in the other view.
run('@playwright/test/cli.js', ['test', 'tests/ui/hand-layout.pw.js'], { HAND_TABLE_VIEW: '25d' });
