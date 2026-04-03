import { describe, it, expect } from 'vitest';
import { recordGameStats } from '../src/stats-db';
import type { Player } from '../src/types';

// Minimal D1 mock that captures batch() calls
function makeMockDb() {
  const inserted: Array<{ sql: string; args: unknown[] }> = [];
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          // Return an object that batch() can receive
          return { _sql: sql, _args: args };
        },
      };
    },
    async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
      for (const s of stmts) inserted.push({ sql: s._sql, args: s._args });
      return stmts.map(() => ({ success: true, results: [], meta: {} }));
    },
    _inserted: inserted,
  } as unknown as D1Database & { _inserted: typeof inserted };
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id, i) => ({
    id,
    name: `P${i}`,
    seat: i,
    connected: true,
  }));
}

describe('recordGameStats', () => {
  it('inserts one row per authenticated player', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    await recordGameStats(db, 'ROOM1', null, players, 0, 1, 12, [4, 4, 5, 5], [0, 1]);
    expect(db._inserted).toHaveLength(4);
  });

  it('skips guest players (non-tg_ ids)', async () => {
    const db = makeMockDb();
    // seat 0 = tg_1, seat 1 = guest_abc, seat 2 = tg_3, seat 3 = bot_0
    const players: Player[] = [
      { id: 'tg_1',    name: 'P0', seat: 0, connected: true },
      { id: 'guest_x', name: 'P1', seat: 1, connected: true },
      { id: 'tg_3',    name: 'P2', seat: 2, connected: true },
      { id: 'bot_0',   name: 'P3', seat: 3, connected: true },
    ];
    await recordGameStats(db, 'ROOM2', null, players, 0, 1, 12, [4, 4, 5, 5], [0, 1]);
    expect(db._inserted).toHaveLength(2); // only tg_1 and tg_3
  });

  it('assigns roles correctly: bidder, partner, opposition', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_10', 'tg_20', 'tg_30', 'tg_40']);
    // bidderSeat=0, partnerSeat=2, winnerSeats=[0,2]
    await recordGameStats(db, 'ROOM3', null, players, 0, 2, 12, [5, 4, 5, 4], [0, 2]);
    const roles = db._inserted.map((r) => r.args[4]); // 5th param is role
    expect(roles).toContain('bidder');
    expect(roles).toContain('partner');
    expect(roles.filter((r) => r === 'opposition')).toHaveLength(2);
  });

  it('parses bid 12 as level 3, suit ♥', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    await recordGameStats(db, 'ROOM4', null, players, 0, 1, 12, [5, 5, 4, 4], [0, 1]);
    const bidderRow = db._inserted.find((r) => r.args[4] === 'bidder')!;
    expect(bidderRow.args[6]).toBe(3);   // bid_level
    expect(bidderRow.args[7]).toBe('♥'); // bid_suit
  });

  it('sets partner_telegram_id to null for solo bidder (partner === bidder)', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    // partnerSeat === bidderSeat → solo bid
    await recordGameStats(db, 'ROOM5', null, players, 0, 0, 5, [7, 2, 2, 2], [0]);
    const bidderRow = db._inserted.find((r) => r.args[4] === 'bidder')!;
    expect(bidderRow.args[9]).toBeNull(); // partner_telegram_id
  });

  it('sets won=1 for winner seats and won=0 for losers', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_100', 'tg_200', 'tg_300', 'tg_400']);
    // seats: 0=tg_100, 1=tg_200, 2=tg_300, 3=tg_400
    // winnerSeats = [0, 1] → tg_100 and tg_200 win
    await recordGameStats(db, 'ROOM6', null, players, 0, 1, 12, [5, 5, 4, 4], [0, 1]);
    // args order: game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id
    const tg100row = db._inserted.find((r) => r.args[3] === 100)!;
    const tg300row = db._inserted.find((r) => r.args[3] === 300)!;
    expect(tg100row.args[5]).toBe(1); // won
    expect(tg300row.args[5]).toBe(0); // lost
  });
});
