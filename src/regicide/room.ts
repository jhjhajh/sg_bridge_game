import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { normalizePlayerName } from '../player-name';
import {
  newGame, playCards, yieldTurn, discardCards, chooseNextPlayer, flipSoloJester,
  enemyStats, shieldValue, currentAttack, canYield, cardSuit, cardRank, soloTier,
  type RegicideGame, type Rng,
} from './engine';
import { recordRegicideGame, type RegicideOutcome, type RatingChange } from './db';
import { sendMessage, isChatMember, escapeHtml } from '../telegram';

export const MAX_PLAYERS = 4;
const INACTIVITY_MS = 30 * 60 * 1000;
const RATING_RETRY_MS = 60 * 1000;
const VIEW_LOG = 30;

interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  /** Verified Telegram id (the Worker only issues `tg_<id>` player ids after checking the JWT). */
  telegramId: number | null;
  /** Set when the room belongs to a Telegram group: verified members count toward that group's board. */
  isGroupMember?: boolean;
}

interface SeatRating { seat: number; name: string; before: number; after: number; delta: number }

interface PendingRating {
  outcome: RegicideOutcome;
  gameId: string;
  numPlayers: number;
  defeated: number;
  jestersUsed: number;
  seats: RoomPlayer[];
}

interface RoomState {
  roomCode: string;
  players: RoomPlayer[]; // seat order
  hostId: string | null;
  game: RegicideGame | null;
  gameNo: number;
  gameId: string | null;
  /** Seeded PRNG state, so shuffles are reproducible from a seed (dev/test can pin it at create). */
  rngState: number;
  /** Rating result of the most recent rated game. */
  lastRating: { gameId: string; outcome: RegicideOutcome; defeated: number; changes: SeatRating[] } | null;
  ratedGameId: string | null;
  /** Durable outbox: retained across failures, new games, and object eviction. */
  pendingRatings?: PendingRating[];
  idleSince?: number | null;
  /** Telegram group this room was started from (/newregicide), if any. */
  groupId?: string | null;
  groupName?: string | null;
  origin?: string | null;
}

interface Session {
  playerId: string;
  /** Display name from the verified JWT, if any. */
  name: string | null;
}

/** mulberry32: small, fast, good enough for card shuffles. Advances state.rngState in place. */
function roomRng(state: RoomState): Rng {
  return () => {
    state.rngState = (state.rngState + 0x6d2b79f5) | 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROYAL_NAMES: Record<string, string> = { J: 'Jack', Q: 'Queen', K: 'King' };
const SUIT_NAMES: Record<string, string> = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
const royalName = (card: string) => `${ROYAL_NAMES[cardRank(card)] ?? cardRank(card)} of ${SUIT_NAMES[cardSuit(card) ?? ''] ?? ''}`;

function telegramIdOf(playerId: string): number | null {
  const id = /^tg_(\d+)$/.exec(playerId)?.[1];
  return id ? Number(id) : null;
}

export type RegicideClientMessage =
  | { type: 'join'; name: string }
  | { type: 'start' }
  | { type: 'play'; cards: string[] }
  | { type: 'yield' }
  | { type: 'discard'; cards: string[] }
  | { type: 'chooseNext'; seat: number }
  | { type: 'flip' }
  | { type: 'backToLobby' }
  | { type: 'kick'; playerId: string }
  | { type: 'leave' };

export class RegicideRoom extends DurableObject {
  private sessions = new Map<WebSocket, Session>();
  private ratingWork: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Session | null;
      if (attachment) this.sessions.set(ws, attachment);
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      if (await this.getState()) return Response.json({ ok: false }, { status: 409 });
      const { roomCode, seed, groupId, groupName, origin } = (await request.json()) as {
        roomCode: string; seed?: number; groupId?: string | null; groupName?: string | null; origin?: string | null;
      };
      const rngState = Number.isInteger(seed) ? Number(seed) : crypto.getRandomValues(new Uint32Array(1))[0] | 0;
      const state: RoomState = {
        roomCode, players: [], hostId: null, game: null, gameNo: 0, gameId: null, rngState, lastRating: null, ratedGameId: null,
        groupId: groupId ?? null, groupName: groupName ?? null, origin: origin ?? null, idleSince: Date.now(),
      };
      await this.save(state);
      return Response.json({ ok: true });
    }

    // Dev/test only (the Worker gates this route on ALLOW_DEV_LOGIN): patch the live game to set up a scenario.
    if (url.pathname === '/debug/patch' && request.method === 'POST') {
      if ((this.env as Env).ALLOW_DEV_LOGIN !== '1') return new Response('Not found', { status: 404 });
      const state = await this.getState();
      if (!state?.game) return Response.json({ ok: false, error: 'No game in progress' }, { status: 409 });
      Object.assign(state.game, (await request.json()) as Partial<RegicideGame>);
      await this.save(state);
      this.broadcast(state);
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    const playerId = url.searchParams.get('playerId');
    if (!playerId) return new Response('Missing playerId', { status: 400 });
    const verifiedName = normalizePlayerName(url.searchParams.get('name')) || null;

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const state = await this.getState();
    if (!state) {
      server.send(JSON.stringify({ type: 'error', code: 'notFound', message: 'Room not found' }));
      server.close(4404, 'Room not found');
      return new Response(null, { status: 101, webSocket: client });
    }

    // One live socket per player (e.g. switching from Telegram's browser to the system one).
    for (const [ws, info] of this.sessions) {
      if (info.playerId === playerId) {
        try { ws.close(1000, 'Replaced by new connection'); } catch { /* already closed */ }
        this.sessions.delete(ws);
      }
    }
    const session: Session = { playerId, name: verifiedName };
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    state.idleSince = null;

    const player = state.players.find((p) => p.id === playerId);
    const reconnected = player && !player.connected;
    if (player) player.connected = true;
    await this.save(state);
    if (reconnected) this.broadcast(state);
    else this.sendState(server, state, playerId);
    this.ctx.waitUntil(this.rateFinishedGame());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session || typeof message !== 'string') return;
    let msg: RegicideClientMessage;
    try { msg = JSON.parse(message); } catch { return; }
    const state = await this.getState();
    if (!state) return;

    const before = { players: state.players.length, gameNo: state.gameNo, ended: state.ratedGameId };
    const error = this.handle(state, session, msg);
    if (error) {
      ws.send(JSON.stringify({ type: 'error', message: error }));
      return;
    }
    if (state.game && (state.game.phase === 'won' || state.game.phase === 'lost')) {
      this.queueRating(state, state.game.phase);
    }
    // Storage input gates protect this read/modify/write, but NOT Telegram/D1
    // awaits. Commit the authoritative transition before starting external I/O.
    await this.save(state);
    this.broadcast(state);
    this.ctx.waitUntil(this.rateFinishedGame());
    if (state.groupId) this.ctx.waitUntil(this.notifyGroup(state, before));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code); } catch { /* already closed */ }
    await this.disconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws);
  }

  async alarm(): Promise<void> {
    await this.rateFinishedGame();
    const state = await this.getState();
    if (!state) return;
    if (state.pendingRatings?.length) {
      await this.ctx.storage.setAlarm(Date.now() + RATING_RETRY_MS);
    } else if (this.sessions.size === 0 && Date.now() >= (state.idleSince ?? 0) + INACTIVITY_MS) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.save(state);
    }
  }

  private async disconnect(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;
    const state = await this.getState();
    if (!state) return;
    if ([...this.sessions.values()].some((s) => s.playerId === session.playerId)) return;
    const player = state.players.find((p) => p.id === session.playerId);
    if (player) player.connected = false;
    if (this.sessions.size === 0) state.idleSince = Date.now();
    await this.save(state);
    this.broadcast(state);
  }

  /** Applies one client message to the room. Returns an error string for the sender, or null. */
  private handle(state: RoomState, session: Session, msg: RegicideClientMessage): string | null {
    const playerId = session.playerId;
    const seat = state.players.findIndex((p) => p.id === playerId);
    const isHost = state.hostId === playerId;
    const game = state.game;

    switch (msg.type) {
      case 'join': {
        const telegramId = telegramIdOf(playerId);
        if (telegramId === null) return 'Sign in with Telegram to play';
        const name = session.name ?? normalizePlayerName(msg.name);
        if (seat >= 0) {
          if (name) state.players[seat].name = name;
          state.players[seat].connected = true;
          return null;
        }
        if (game) return 'This game has already started — you can watch until it ends';
        if (state.players.length >= MAX_PLAYERS) return 'This room is full (4 players)';
        state.players.push({ id: playerId, name: name || `Player ${state.players.length + 1}`, connected: true, telegramId });
        state.hostId ??= playerId;
        return null;
      }
      case 'leave': {
        if (seat < 0) return null;
        if (game && game.phase !== 'won' && game.phase !== 'lost') {
          state.players[seat].connected = false;
          return null;
        }
        // Leaving a finished game also returns everyone to the lobby with the new roster.
        this.endGame(state);
        this.removePlayer(state, seat);
        return null;
      }
      case 'kick': {
        if (!isHost) return 'Only the host can remove players';
        if (game) return 'Players can only be removed in the lobby';
        const target = state.players.findIndex((p) => p.id === msg.playerId);
        if (target < 0 || msg.playerId === playerId) return null;
        this.removePlayer(state, target);
        return null;
      }
      case 'start': {
        if (!isHost) return 'Only the host can start the game';
        if (game) return 'The game has already started';
        if (state.players.length < 1) return 'Need at least one player';
        state.game = newGame(state.players.length, roomRng(state));
        state.gameNo++;
        state.gameId = `${state.roomCode}-${Date.now().toString(36)}-${state.gameNo}`;
        return null;
      }
      case 'backToLobby': {
        if (!game) return null;
        const over = game.phase === 'won' || game.phase === 'lost';
        if (!over && !isHost) return 'Only the host can end the game early';
        if (seat < 0) return null;
        this.endGame(state);
        return null;
      }
    }

    if (!game) return 'The game has not started';
    if (seat < 0) return "You're watching this game";
    switch (msg.type) {
      case 'play': return playCards(game, seat, asCards(msg.cards), roomRng(state));
      case 'yield': return yieldTurn(game, seat);
      case 'discard': return discardCards(game, seat, asCards(msg.cards));
      case 'chooseNext': return chooseNextPlayer(game, seat, Number(msg.seat));
      case 'flip': return flipSoloJester(game, seat);
    }
    return 'Unknown action';
  }

  /** Back to the lobby. A game ended early still counts once a royal has fallen (no dodging a bad run). */
  private endGame(state: RoomState): void {
    const game = state.game;
    if (game) {
      if (game.phase === 'won' || game.phase === 'lost') this.queueRating(state, game.phase);
      else if (game.defeated.length > 0) this.queueRating(state, 'abandoned');
    }
    state.game = null;
  }

  private queueRating(state: RoomState, outcome: RegicideOutcome): void {
    if (!state.gameId || state.ratedGameId === state.gameId) return;
    const pending = state.pendingRatings ??= [];
    if (!pending.some((p) => p.gameId === state.gameId)) pending.push(this.ratingInput(state, outcome));
  }

  private ratingInput(state: RoomState, outcome: RegicideOutcome): PendingRating {
    const game = state.game!;
    return {
      outcome, gameId: state.gameId!, numPlayers: game.numPlayers, defeated: game.defeated.length,
      jestersUsed: game.numPlayers === 1 ? 2 - game.soloJestersLeft : 0, seats: state.players.map((p) => ({ ...p })),
    };
  }

  /** Writes ratings once per game, when it is won/lost (or was abandoned mid-run). */
  private async rateFinishedGame(): Promise<void> {
    // Only coalesce external work; gameplay never waits on this promise.
    if (this.ratingWork) return this.ratingWork;
    this.ratingWork = this.drainRatings();
    try { await this.ratingWork; } finally { this.ratingWork = null; }
  }

  private async drainRatings(): Promise<void> {
    const env = this.env as Env;
    try {
      for (;;) {
        const state = await this.getState();
        const pending = state?.pendingRatings?.[0];
        if (!state || !pending) return;
        // A quick game can finish before the join's membership lookup returns.
        if (state.groupId) {
          for (const p of pending.seats) {
            if (p.telegramId !== null && p.isGroupMember === undefined) {
              p.isGroupMember = await isChatMember(env.TELEGRAM_BOT_TOKEN, state.groupId, p.telegramId);
            }
          }
        }
        let changes = await recordRegicideGame(env.DB, {
          gameId: pending.gameId, roomCode: state.roomCode, numPlayers: pending.numPlayers, defeated: pending.defeated,
          outcome: pending.outcome, jestersUsed: pending.jestersUsed,
          telegramIds: pending.seats.filter((p) => p.telegramId !== null).map((p) => p.telegramId!),
          groupId: state.groupId,
          memberIds: pending.seats.filter((p) => p.isGroupMember && p.telegramId !== null).map((p) => p.telegramId!),
        });
        if (!changes.length) {
          // The batch may have committed before an eviction/failed local save.
          const history = await env.DB.prepare(
            `SELECT telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta
             FROM regicide_rating_history WHERE game_id = ?`,
          ).bind(pending.gameId).all<RatingChange>();
          changes = history.results ?? [];
        }
        // Never save the pre-I/O snapshot: joins, starts, and disconnects may
        // have committed while D1 or Telegram was outstanding.
        const current = await this.getState();
        if (!current?.pendingRatings?.some((p) => p.gameId === pending.gameId)) continue;
        const before = { players: current.players.length, gameNo: current.gameNo, ended: current.ratedGameId };
        current.pendingRatings = current.pendingRatings.filter((p) => p.gameId !== pending.gameId);
        current.ratedGameId = pending.gameId;
        current.lastRating = {
          gameId: pending.gameId, outcome: pending.outcome, defeated: pending.defeated,
          changes: changes.map((c) => {
            const seat = pending.seats.findIndex((p) => p.telegramId === c.telegramId);
            return { seat, name: pending.seats[seat]?.name ?? '', before: c.before, after: c.after, delta: c.delta };
          }),
        };
        await this.save(current);
        this.broadcast(current);
        if (current.groupId) this.ctx.waitUntil(this.notifyGroup(current, before));
      }
    } catch (err) {
      // The durable outbox and its alarm remain intact until all writes succeed.
      console.error('Regicide rating failed; will retry', err);
    }
  }

  /** Group-chat updates for rooms started from Telegram, like Bridge's (lobby joins, start, result). */
  private async notifyGroup(state: RoomState, before: { players: number; gameNo: number; ended: string | null }): Promise<void> {
    const env = this.env as Env;
    const groupId = state.groupId!;
    const post = (text: string) => this.ctx.waitUntil(sendMessage(env.TELEGRAM_BOT_TOKEN, groupId, text));
    const names = (list: RoomPlayer[]) => list.map((p) => escapeHtml(p.name)).join(', ');
    const link = state.origin ? `${state.origin}/regicide/#${state.roomCode}` : null;

    // New seat: verify membership first, so the group board only counts the group.
    if (state.players.length > before.players) {
      const joined = state.players[state.players.length - 1];
      const isGroupMember = joined.telegramId !== null && await isChatMember(env.TELEGRAM_BOT_TOKEN, groupId, joined.telegramId);
      const current = await this.getState();
      const player = current?.players.find((p) => p.id === joined.id);
      if (current && player) {
        player.isGroupMember = isGroupMember;
        await this.save(current);
        this.broadcast(current);
      }
      const n = state.players.length;
      post(`👤 <b>${escapeHtml(joined.name)}</b> joined the Regicide lobby (${n}/4)\nPlayers: ${names(state.players)}${link && n < 4 ? `\n♛ Join → ${link}` : ''}`);
    }
    if (state.gameNo > before.gameNo && state.game) {
      const n = state.game.numPlayers;
      post(`♛ Regicide started — ${n === 1 ? 'solo run' : `${n} players`}: ${names(state.players)}`);
    }
    // A game was just rated (won, lost, or ended early after a royal fell).
    const rating = state.lastRating;
    if (rating && state.ratedGameId !== before.ended && rating.gameId === state.ratedGameId) {
      const game = state.game;
      const defeated = rating.defeated;
      const lines = rating.changes.map((c) => `  ${escapeHtml(c.name)}: ${c.delta >= 0 ? '+' : ''}${c.delta} → ${c.after}`).join('\n');
      const head = rating.outcome === 'won'
        ? `👑 <b>Victory!</b> ${names(state.players)} stormed the castle — all 12 royals defeated!`
        : rating.outcome === 'lost'
          ? `💀 The castle held. ${names(state.players)} defeated ${defeated}/12 royals${game?.enemy ? ` before falling to the ${royalName(game.enemy)}` : ''}.`
          : `🏳️ Regicide game ended early at ${defeated}/12 royals.`;
      post(`${head}${lines ? `\n${lines}` : ''}`);
    }
  }

  private removePlayer(state: RoomState, seat: number): void {
    const [removed] = state.players.splice(seat, 1);
    if (state.hostId === removed.id) state.hostId = state.players[0]?.id ?? null;
  }

  private async getState(): Promise<RoomState | null> {
    const state = (await this.ctx.storage.get<RoomState>('state')) ?? null;
    if (state) state.rngState ??= crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    return state;
  }

  private async save(state: RoomState): Promise<void> {
    // Issue together: the outbox and wakeup are committed under storage gates.
    const write = this.ctx.storage.put('state', state);
    const alarm = state.pendingRatings?.length
      ? this.ctx.storage.setAlarm(Date.now() + RATING_RETRY_MS)
      : this.sessions.size === 0
        ? this.ctx.storage.setAlarm((state.idleSince ?? Date.now()) + INACTIVITY_MS)
        : this.ctx.storage.deleteAlarm();
    await Promise.all([write, alarm]);
  }

  private broadcast(state: RoomState): void {
    for (const [ws, session] of this.sessions) this.sendState(ws, state, session.playerId);
  }

  private sendState(ws: WebSocket, state: RoomState, playerId: string): void {
    try { ws.send(JSON.stringify(buildView(state, playerId))); } catch { /* closing */ }
  }
}

function asCards(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string').slice(0, 8) : [];
}

export function buildView(state: RoomState, playerId: string) {
  const seat = state.players.findIndex((p) => p.id === playerId);
  const game = state.game;
  const stats = game ? enemyStats(game) : null;
  return {
    type: 'state' as const,
    roomCode: state.roomCode,
    gameNo: state.gameNo,
    you: { seat, isHost: state.hostId === playerId, id: playerId },
    players: state.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, isHost: p.id === state.hostId,
      // Only meaningful in group rooms: false = plays and is rated, but doesn't count for the group board.
      isGroupMember: state.groupId ? p.isGroupMember ?? null : null,
    })),
    groupName: state.groupName ?? null,
    gameId: state.gameId,
    lastRating: state.lastRating,
    game: game && {
      numPlayers: game.numPlayers,
      maxHand: game.maxHand,
      phase: game.phase,
      currentSeat: game.currentSeat,
      hand: seat >= 0 ? game.hands[seat] : null,
      handCounts: game.hands.map((h) => h.length),
      enemy: game.enemy,
      enemyDamage: game.enemyDamage,
      enemyHealth: stats?.health ?? 0,
      enemyAttack: stats?.attack ?? 0,
      shield: shieldValue(game),
      attack: currentAttack(game),
      jesterActive: game.jesterActive,
      immuneSuit: game.enemy && !game.jesterActive ? cardSuit(game.enemy) : null,
      played: game.played,
      tavernCount: game.tavern.length,
      discardCount: game.discard.length,
      castle: {
        remaining: game.castle.length,
        J: game.castle.filter((c) => cardRank(c) === 'J').length,
        Q: game.castle.filter((c) => cardRank(c) === 'Q').length,
        K: game.castle.filter((c) => cardRank(c) === 'K').length,
      },
      defeated: game.defeated,
      pendingDamage: game.pendingDamage,
      canYield: canYield(game),
      soloJestersLeft: game.soloJestersLeft,
      log: game.log.slice(-VIEW_LOG),
      loseReason: game.loseReason,
      tier: soloTier(game),
    },
  };
}
