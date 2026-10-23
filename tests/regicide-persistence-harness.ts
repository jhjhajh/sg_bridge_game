// Local-only workerd/SQLite harness. Test-only inspection and retry routes are
// bundled here, never into the production Worker or its public debug endpoint.
import { Miniflare, Response } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export { Response };

export async function createRegicideHarness(outbound?: (request: Request) => Promise<Response>, ratingGate = false) {
  const root = path.resolve(import.meta.dirname, '..');
  const state = await mkdtemp(path.join(tmpdir(), 'regicide-persistence-'));
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root, sourcefile: 'regicide-persistence-worker.ts', contents: `
        import { RegicideRoom } from './src/regicide/room';
        export class TestRoom extends RegicideRoom {
          constructor(ctx, env) {
            const db = {
              prepare(sql) {
                const statement = env.DB.prepare(sql);
                if (!env.TEST_RATING_GATE || !sql.startsWith('SELECT telegram_id, rating, games_played')) return statement;
                return { bind(...values) {
                  const bound = statement.bind(...values);
                  return { async all() {
                    const result = await bound.all();
                    await fetch('https://regicide.test/rating-read');
                    return result;
                  } };
                } };
              },
              batch: (statements) => env.DB.batch(statements),
            };
            super(ctx, { ...env, DB: db });
          }
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/__state') {
              if (request.method === 'POST') await this.ctx.storage.put('state', await request.json());
              return Response.json({ state: await this.ctx.storage.get('state'), alarm: await this.ctx.storage.getAlarm() });
            }
            if (url.pathname === '/__retry') {
              await this.alarm();
              return Response.json({ ok: true });
            }
            return super.fetch(request);
          }
        }
        export default { fetch() { return new Response('not used'); } };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*'],
  });
  let mf: Miniflare;
  const launch = async () => {
    mf = new Miniflare({
      modules: true, script: outputFiles[0].text,
      compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { ROOM: { className: 'TestRoom', useSQLite: true } },
      durableObjectsPersist: path.join(state, 'rooms'),
      d1Databases: ['DB'], d1Persist: path.join(state, 'db'),
      bindings: { TELEGRAM_BOT_TOKEN: 'local-test-token', ALLOW_DEV_LOGIN: '1', TEST_RATING_GATE: ratingGate },
      outboundService: outbound ?? (async () => Response.json({ ok: true, result: { status: 'member' } })),
    });
    await mf.ready;
  };
  await launch();
  let db = await mf!.getD1Database('DB');
  await db.prepare('CREATE TABLE groups (group_id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO groups (group_id) VALUES ('-100')").run();
  const migration = await readFile(path.join(root, 'migrations/0011_regicide.sql'), 'utf8');
  for (const sql of migration.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(sql).run();
  }
  const room = async (name: string) => {
    const namespace = await mf!.getDurableObjectNamespace('ROOM');
    return namespace.get(namespace.idFromName(name));
  };
  return {
    get db() { return db; }, room,
    async restart() {
      await mf!.dispose();
      await launch();
      db = await mf!.getD1Database('DB');
    },
    async stop() {
      await mf!.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function readRoom(room: Awaited<ReturnType<Awaited<ReturnType<typeof createRegicideHarness>>['room']>>) {
  return (await room.fetch('https://room.test/__state')).json() as Promise<{ state: any; alarm: number | null }>;
}

export async function connect(room: Awaited<ReturnType<Awaited<ReturnType<typeof createRegicideHarness>>['room']>>, id: number) {
  const response = await room.fetch(`https://room.test/?playerId=tg_${id}&name=Player${id}`, { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket!;
  ws.accept();
  // Consume state frames so sockets can be cleanly closed/disposed.
  ws.addEventListener('message', () => {});
  return ws;
}
