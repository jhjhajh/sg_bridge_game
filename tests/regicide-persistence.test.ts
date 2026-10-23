import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordRegicideGame, type RegicideGameResult } from '../src/regicide/db';
import { createRegicideHarness, deferred } from './regicide-persistence-harness';

type Harness = Awaited<ReturnType<typeof createRegicideHarness>>;
let worker: Harness;
const result = (gameId: string, overrides: Partial<RegicideGameResult> = {}): RegicideGameResult => ({
  gameId, roomCode: 'TEST', numPlayers: 1, defeated: 12, outcome: 'won', jestersUsed: 0,
  telegramIds: [1], groupId: '-100', memberIds: [1], ...overrides,
});

// Both calls must finish their SELECT before either can enter its transaction.
// All writes still execute in real local D1/SQLite, not a mock SQL interpreter.
function simultaneousReads(db: Harness['db'], count = 2) {
  const ready = deferred();
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('SELECT telegram_id, rating, games_played')) return statement;
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { async all() {
          const rows = await bound.all();
          if (--count === 0) ready.resolve();
          await ready.promise;
          return rows;
        } };
      } };
    },
    batch: (statements: Parameters<Harness['db']['batch']>[0]) => db.batch(statements),
  } as unknown as Parameters<typeof recordRegicideGame>[0];
}

describe('Regicide D1 completion transactions (real Miniflare SQLite)', () => {
  beforeAll(async () => { worker = await createRegicideHarness(); }, 30000);
  afterAll(async () => { await worker?.stop(); });
  beforeEach(async () => {
    for (const table of ['regicide_games', 'regicide_rating_history', 'regicide_ratings', 'regicide_group_stats']) {
      await worker.db.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it('rolls back a late group failure and retries the complete game exactly once', async () => {
    const input = result('failed-group', { groupId: '-missing' });
    await expect(recordRegicideGame(worker.db as any, input)).rejects.toThrow();
    for (const table of ['regicide_games', 'regicide_rating_history', 'regicide_ratings', 'regicide_group_stats']) {
      expect(await worker.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
    }
    await worker.db.prepare("INSERT INTO groups (group_id) VALUES ('-missing')").run();
    expect(await recordRegicideGame(worker.db as any, input)).toEqual([{ telegramId: 1, before: 1000, after: 1024, delta: 24 }]);
    expect(await recordRegicideGame(worker.db as any, input)).toEqual([]);
    expect(await worker.db.prepare('SELECT games_played FROM regicide_group_stats').first('games_played')).toBe(1);
    expect(await worker.db.prepare('SELECT games_played FROM regicide_ratings').first('games_played')).toBe(1);
  });

  it('rolls back earlier player writes when a later history statement fails', async () => {
    await worker.db.prepare(`CREATE TRIGGER fail_second_player BEFORE INSERT ON regicide_rating_history
      WHEN NEW.telegram_id = 2 BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`).run();
    const input = result('failed-history', { numPlayers: 2, telegramIds: [1, 2], memberIds: [1, 2] });
    try {
      await expect(recordRegicideGame(worker.db as any, input)).rejects.toThrow(/injected history failure/);
      for (const table of ['regicide_games', 'regicide_rating_history', 'regicide_ratings', 'regicide_group_stats']) {
        expect(await worker.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
      }
    } finally {
      await worker.db.prepare('DROP TRIGGER fail_second_player').run();
    }
    expect(await recordRegicideGame(worker.db as any, input)).toHaveLength(2);
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_rating_history').first('n')).toBe(2);
  });

  it('deduplicates overlapping retries including global history and group increments', async () => {
    const db = simultaneousReads(worker.db);
    const input = result('duplicate', { telegramIds: [1, 1], memberIds: [1, 1] });
    const changes = await Promise.all([recordRegicideGame(db, input), recordRegicideGame(db, input)]);
    expect(changes.map((c) => c.length).sort()).toEqual([0, 1]);
    expect(await worker.db.prepare('SELECT rating, games_played, wins FROM regicide_ratings').first()).toEqual({ rating: 1024, games_played: 1, wins: 1 });
    expect(await worker.db.prepare('SELECT games_played, wins FROM regicide_group_stats').first()).toEqual({ games_played: 1, wins: 1 });
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_games').first('n')).toBe(1);
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_rating_history').first('n')).toBe(1);
  });

  it('adds simultaneous cross-room deltas and records the actual serial before/after ratings', async () => {
    const db = simultaneousReads(worker.db);
    const changes = (await Promise.all([
      recordRegicideGame(db, result('room-a')),
      recordRegicideGame(db, result('room-b', { roomCode: 'OTHER' })),
    ])).flat().sort((a, b) => a.before - b.before);
    expect(changes).toEqual([
      { telegramId: 1, before: 1000, after: 1024, delta: 24 },
      { telegramId: 1, before: 1024, after: 1048, delta: 24 },
    ]);
    expect(await worker.db.prepare('SELECT rating, games_played, wins FROM regicide_ratings').first()).toEqual({ rating: 1048, games_played: 2, wins: 2 });
    expect((await worker.db.prepare('SELECT rating_before, rating_after, delta FROM regicide_rating_history ORDER BY rating_before').all()).results).toEqual([
      { rating_before: 1000, rating_after: 1024, delta: 24 },
      { rating_before: 1024, rating_after: 1048, delta: 24 },
    ]);
    expect(await worker.db.prepare('SELECT games_played FROM regicide_group_stats').first('games_played')).toBe(2);
  });

  it('records an empty signed-in roster atomically and remains idempotent', async () => {
    const input = result('no-ids', { telegramIds: [], memberIds: [] });
    expect(await recordRegicideGame(worker.db as any, input)).toEqual([]);
    expect(await recordRegicideGame(worker.db as any, input)).toEqual([]);
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_games').first('n')).toBe(1);
  });
});
