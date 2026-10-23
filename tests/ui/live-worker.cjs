// Real local Worker/SQLite Durable Object; no Cloudflare account or remote data.
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');

// `outboundService` (optional) intercepts the Worker's outbound fetches, e.g. to capture Telegram API calls.
// `skipMigrations` (optional) leaves named migration files unapplied, e.g. to test a not-yet-migrated database.
exports.startWorker = async function startWorker(port = 4210, testBindings = {}, { outboundService, skipMigrations = [] } = {}) {
  const root = path.join(__dirname, '../..');
  const { outputFiles } = await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*', 'node:*'],
  });
  const stateRoot = path.resolve(root, '.wrangler');
  await fs.mkdir(stateRoot, { recursive: true });
  const state = await fs.mkdtemp(path.join(stateRoot, 'chat-test-'));
  const mf = new Miniflare({
    host: '127.0.0.1', port, modules: true, script: outputFiles[0].text,
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GAME_ROOM: { className: 'GameRoom', useSQLite: true }, REGICIDE_ROOM: { className: 'RegicideRoom', useSQLite: true } },
    durableObjectsPersist: path.join(state, 'rooms'),
    d1Databases: ['DB'], d1Persist: path.join(state, 'db'),
    bindings: { JWT_SECRET: 'local-chat-test-only', ALLOW_DEV_LOGIN: '1', TELEGRAM_BOT_USERNAME: 'local_test_only', ...testBindings },
    assets: { directory: path.join(root, 'static'), routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/api/*'] } } },
    ...(outboundService ? { outboundService } : {}),
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const file of (await fs.readdir(path.join(root, 'migrations'))).filter(name => name.endsWith('.sql') && !skipMigrations.includes(name)).sort()) {
    const sql = (await fs.readFile(path.join(root, 'migrations', file), 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  return { mf, db, origin: `http://127.0.0.1:${port}`, stop: async () => {
    await mf.dispose();
    // Remove only the exact temporary state folder created by this helper.
    if (path.dirname(state) !== stateRoot || !path.basename(state).startsWith('chat-test-')) throw new Error('Unexpected test storage path');
    await fs.rm(state, { recursive: true, force: true });
  } };
};
