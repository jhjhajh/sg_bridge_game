import { describe, it, expect } from 'vitest';
import {
  insertGameHands,
  updateGameFinalHands,
  insertGameTricks,
  insertGameMetadata,
} from '../src/game-logging';
import type { Player, Hand, TrickLogEntry, BidHistoryEntry } from '../src/types';

function makeMockDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  let runCalled = false;
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            _sql: sql,
            _args: args,
            async run() {
              runCalled = true;
              calls.push({ sql, args });
              return { success: true, results: [], meta: {} };
            },
          };
        },
      };
    },
    async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
      for (const s of stmts) calls.push({ sql: s._sql, args: s._args });
      return stmts.map(() => ({ success: true, results: [], meta: {} }));
    },
    _calls: calls,
    _runCalled: () => runCalled,
  } as unknown as D1Database & { _calls: typeof calls; _runCalled: () => boolean };
}

function makeHand(clubs = ['A'], diamonds = ['K'], hearts = ['Q'], spades = ['J']): Hand {
  return { '♣': clubs, '♦': diamonds, '♥': hearts, '♠': spades };
}

function makePlayers(): Player[] {
  return [
    { id: 'tg_1', name: 'Alice', seat: 0, connected: true },
    { id: 'tg_2', name: 'Bob',   seat: 1, connected: true },
    { id: 'bot_0', name: 'Bot A', seat: 2, connected: true },
    { id: 'guest_x', name: 'Carol', seat: 3, connected: true },
  ];
}

describe('insertGameHands', () => {
  it('inserts one row per player with flattened card arrays', async () => {
    const db = makeMockDb();
    const players = makePlayers();
    const hands = [makeHand(), makeHand(), makeHand(), makeHand()];
    await insertGameHands(db, 'game-1', players, hands);
    expect(db._calls).toHaveLength(4);
    expect(db._calls[0].sql).toContain('INSERT INTO game_hands');
    expect(db._calls[0].args[0]).toBe('game-1');
    expect(db._calls[0].args[1]).toBe(0); // seat
    expect(db._calls[0].args[2]).toBe('Alice'); // name
    const hand0 = JSON.parse(db._calls[0].args[3] as string) as string[];
    expect(hand0).toContain('A ♣');
    expect(hand0).toContain('K ♦');
  });
});

describe('updateGameFinalHands', () => {
  it('updates one row per player with remaining cards', async () => {
    const db = makeMockDb();
    const players = makePlayers();
    const hands = [makeHand(['2'], [], [], []), makeHand(), makeHand(), makeHand()];
    await updateGameFinalHands(db, 'game-1', players, hands);
    expect(db._calls).toHaveLength(4);
    expect(db._calls[0].sql).toContain('UPDATE game_hands');
    const final0 = JSON.parse(db._calls[0].args[0] as string) as string[];
    expect(final0).toEqual(['2 ♣']);
  });
});

describe('insertGameTricks', () => {
  it('inserts one row per trickLog entry', async () => {
    const db = makeMockDb();
    const log: TrickLogEntry[] = [
      { trickNum: 1, playOrder: 1, seat: 0, card: 'A ♠' },
      { trickNum: 1, playOrder: 2, seat: 1, card: 'K ♠' },
    ];
    await insertGameTricks(db, 'game-1', log);
    expect(db._calls).toHaveLength(2);
    expect(db._calls[0].sql).toContain('INSERT INTO game_tricks');
    expect(db._calls[0].args).toEqual(['game-1', 1, 1, 0, 'A ♠']);
  });

  it('does nothing when trickLog is empty', async () => {
    const db = makeMockDb();
    await insertGameTricks(db, 'game-1', []);
    expect(db._calls).toHaveLength(0);
  });
});

describe('insertGameMetadata', () => {
  it('inserts one metadata row', async () => {
    const db = makeMockDb();
    const players = makePlayers();
    const bidHistory: BidHistoryEntry[] = [{ seat: 0, name: 'Alice', bidNum: 12 }];
    await insertGameMetadata(
      db, 'game-1', 0, 12, '♠', 'A ♥', bidHistory, players, [4, 3, 3, 3], 'bidder',
    );
    expect(db._runCalled()).toBe(true);
    const call = db._calls[0];
    expect(call.sql).toContain('INSERT INTO game_metadata');
    expect(call.args[0]).toBe('game-1');
    expect(call.args[8]).toBe('bidder');
  });
});
