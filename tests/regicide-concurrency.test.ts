import { describe, expect, it } from 'vitest';
import { connect, createRegicideHarness, deferred, readRoom, Response } from './regicide-persistence-harness';

const create = async (room: any, group = false) => {
  const response = await room.fetch('https://room.test/create', {
    method: 'POST', body: JSON.stringify({ roomCode: 'TEST', seed: 5, ...(group ? { groupId: '-100' } : {}) }),
  });
  expect(response.status).toBe(200);
};
const patch = (room: any, game: unknown) => room.fetch('https://room.test/debug/patch', { method: 'POST', body: JSON.stringify(game) });
const royals = ['JC', 'JD', 'JH', 'JS', 'QC', 'QD', 'QH', 'QS', 'KC', 'KD', 'KH', 'KS'];

describe('Regicide authoritative state and durable rating outbox (live workerd)', () => {
  it('persists overlapping group joins before membership I/O and preserves later start/disconnect', async () => {
    const started = new Set<number>();
    const gates = new Map([[1, deferred()], [2, deferred()]]);
    const worker = await createRegicideHarness(async (request) => {
      if (new URL(request.url).pathname.endsWith('/getChatMember')) {
        const { user_id } = await request.json() as { user_id: number };
        started.add(user_id);
        await gates.get(user_id)!.promise;
      }
      return Response.json({ ok: true, result: { status: 'member' } });
    });
    const sockets: any[] = [];
    try {
      const room = await worker.room('joins');
      await create(room, true);
      const a = await connect(room, 1), b = await connect(room, 2);
      sockets.push(a, b);
      a.send(JSON.stringify({ type: 'join', name: 'One' }));
      await expect.poll(() => started.size).toBe(1);
      expect((await readRoom(room)).state.players.map((p: any) => p.id)).toEqual(['tg_1']);
      b.send(JSON.stringify({ type: 'join', name: 'Two' }));
      await expect.poll(() => started.size).toBe(2);
      const joined = (await readRoom(room)).state;
      expect(joined.players.map((p: any) => p.id)).toEqual(['tg_1', 'tg_2']);
      expect(joined.hostId).toBe('tg_1');
      a.send(JSON.stringify({ type: 'start' }));
      await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
      b.close(1000);
      await expect.poll(async () => (await readRoom(room)).state.players[1].connected).toBe(false);
      // Complete callbacks in reverse order after the newer transitions.
      gates.get(2)!.resolve();
      await expect.poll(async () => (await readRoom(room)).state.players[1].isGroupMember).toBe(true);
      gates.get(1)!.resolve();
      await expect.poll(async () => (await readRoom(room)).state.players[0].isGroupMember).toBe(true);
      const final = (await readRoom(room)).state;
      expect(final.players.map((p: any) => p.id)).toEqual(['tg_1', 'tg_2']);
      expect(final.hostId).toBe('tg_1');
      expect(final.game.numPlayers).toBe(2);
      expect(final.gameNo).toBe(1);
      expect(final.players[1].connected).toBe(false);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      for (const ws of sockets) { try { ws.close(1000); } catch {} }
      await worker.stop();
    }
  }, 30000);

  it('merges a delayed rating acknowledgement into the latest game and connection state', async () => {
    const entered = deferred(), release = deferred();
    const worker = await createRegicideHarness(async (request) => {
      if (new URL(request.url).hostname === 'regicide.test') {
        entered.resolve();
        await release.promise;
      }
      return Response.json({ ok: true, result: { status: 'member' } });
    }, true);
    const sockets: any[] = [];
    try {
      const room = await worker.room('rating-race');
      await create(room);
      const a = await connect(room, 1), b = await connect(room, 2);
      sockets.push(a, b);
      a.send(JSON.stringify({ type: 'join', name: 'One' }));
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
      b.send(JSON.stringify({ type: 'join', name: 'Two' }));
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      a.send(JSON.stringify({ type: 'start' }));
      await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
      const firstGame = (await readRoom(room)).state.gameId;
      await patch(room, { phase: 'won', defeated: royals });
      a.send(JSON.stringify({ type: 'join', name: 'One' }));
      await entered.promise;
      const waiting = await readRoom(room);
      expect(waiting.state.pendingRatings).toHaveLength(1);
      expect(waiting.state.ratedGameId).toBeNull();
      expect(waiting.alarm).toBeGreaterThan(Date.now());
      a.send(JSON.stringify({ type: 'backToLobby' }));
      await expect.poll(async () => (await readRoom(room)).state.game).toBeNull();
      a.send(JSON.stringify({ type: 'start' }));
      await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(2);
      const secondGame = (await readRoom(room)).state.gameId;
      b.close(1000);
      await expect.poll(async () => (await readRoom(room)).state.players[1].connected).toBe(false);
      release.resolve();
      await expect.poll(async () => (await readRoom(room)).state.ratedGameId).toBe(firstGame);
      const final = (await readRoom(room)).state;
      expect(final.pendingRatings).toEqual([]);
      expect(final.gameId).toBe(secondGame);
      expect(final.gameNo).toBe(2);
      expect(final.game.phase).not.toBe('won');
      expect(final.players[1].connected).toBe(false);
      expect(final.lastRating.changes).toHaveLength(2);
      expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_games').first('n')).toBe(1);
    } finally {
      release.resolve();
      for (const ws of sockets) { try { ws.close(1000); } catch {} }
      await worker.stop();
    }
  }, 30000);

  it('retains abandoned results across D1 failure/restart, retries via alarm, and recovers a lost acknowledgement', async () => {
    const worker = await createRegicideHarness();
    let socket: any;
    try {
      let room = await worker.room('retry');
      await create(room, true);
      socket = await connect(room, 1);
      socket.send(JSON.stringify({ type: 'join', name: 'One' }));
      await expect.poll(async () => (await readRoom(room)).state.players[0]?.isGroupMember).toBe(true);
      socket.send(JSON.stringify({ type: 'start' }));
      await expect.poll(async () => (await readRoom(room)).state.gameNo).toBe(1);
      await patch(room, { defeated: ['JC'] });
      await worker.db.prepare(`CREATE TRIGGER fail_rating BEFORE INSERT ON regicide_rating_history
        BEGIN SELECT RAISE(ABORT, 'injected room rating failure'); END`).run();
      socket.send(JSON.stringify({ type: 'backToLobby' }));
      await expect.poll(async () => (await readRoom(room)).state.pendingRatings?.length).toBe(1);
      socket.close(1000);
      await expect.poll(async () => (await readRoom(room)).state.players[0].connected).toBe(false);
      const queued = (await readRoom(room)).state;
      expect(queued.game).toBeNull();
      expect(queued.ratedGameId).toBeNull();
      expect(queued.pendingRatings[0].outcome).toBe('abandoned');
      expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_games').first('n')).toBe(0);
      await worker.restart();
      room = await worker.room('retry');
      expect((await readRoom(room)).state.pendingRatings).toEqual(queued.pendingRatings);
      expect((await readRoom(room)).alarm).not.toBeNull();
      // Even an expired idle room must keep failed pending work.
      const expired = { ...queued, idleSince: Date.now() - 31 * 60 * 1000 };
      await room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(expired) });
      await room.fetch('https://room.test/__retry');
      expect((await readRoom(room)).state.pendingRatings).toHaveLength(1);
      expect((await readRoom(room)).alarm).toBeGreaterThan(Date.now());
      await worker.db.prepare('DROP TRIGGER fail_rating').run();
      // Restore a recent idle timestamp to inspect the successful ack before cleanup.
      await room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(queued) });
      await room.fetch('https://room.test/__retry');
      const completed = (await readRoom(room)).state;
      expect(completed.pendingRatings).toEqual([]);
      expect(completed.ratedGameId).toBe(queued.pendingRatings[0].gameId);
      expect(completed.lastRating.changes).toHaveLength(1);
      expect(await worker.db.prepare('SELECT games_played FROM regicide_ratings').first('games_played')).toBe(1);
      expect(await worker.db.prepare('SELECT games_played FROM regicide_group_stats').first('games_played')).toBe(1);
      // Model an eviction after D1 committed but before the local outbox ack.
      await room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(queued) });
      await worker.restart();
      room = await worker.room('retry');
      await room.fetch('https://room.test/__retry');
      const recovered = (await readRoom(room)).state;
      expect(recovered.pendingRatings).toEqual([]);
      expect(recovered.lastRating).toEqual(completed.lastRating);
      expect(await worker.db.prepare('SELECT games_played FROM regicide_ratings').first('games_played')).toBe(1);
      expect(await worker.db.prepare('SELECT games_played FROM regicide_group_stats').first('games_played')).toBe(1);
      expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM regicide_rating_history').first('n')).toBe(1);
    } finally {
      try { socket?.close(1000); } catch {}
      await worker.stop();
    }
  }, 30000);
});
