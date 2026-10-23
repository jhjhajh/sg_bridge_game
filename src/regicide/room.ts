import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { normalizePlayerName } from '../player-name';
import {
  newGame, playCards, yieldTurn, discardCards, chooseNextPlayer, flipSoloJester,
  enemyStats, shieldValue, currentAttack, canYield, cardSuit, cardRank, soloTier,
  type RegicideGame,
} from './engine';

export const MAX_PLAYERS = 4;
const INACTIVITY_MS = 30 * 60 * 1000;
const VIEW_LOG = 30;

interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
}

interface RoomState {
  roomCode: string;
  players: RoomPlayer[]; // seat order
  hostId: string | null;
  game: RegicideGame | null;
  gameNo: number;
}

interface Session {
  playerId: string;
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
      const { roomCode } = (await request.json()) as { roomCode: string };
      const state: RoomState = { roomCode, players: [], hostId: null, game: null, gameNo: 0 };
      await this.ctx.storage.put('state', state);
      await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    const playerId = url.searchParams.get('playerId');
    if (!playerId) return new Response('Missing playerId', { status: 400 });

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
    const session: Session = { playerId };
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    await this.ctx.storage.deleteAlarm();

    const player = state.players.find((p) => p.id === playerId);
    if (player && !player.connected) {
      player.connected = true;
      await this.save(state);
      this.broadcast(state);
    } else {
      this.sendState(server, state, playerId);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session || typeof message !== 'string') return;
    let msg: RegicideClientMessage;
    try { msg = JSON.parse(message); } catch { return; }
    const state = await this.getState();
    if (!state) return;

    const error = this.handle(state, session.playerId, msg);
    if (error) {
      ws.send(JSON.stringify({ type: 'error', message: error }));
      return;
    }
    await this.save(state);
    this.broadcast(state);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code); } catch { /* already closed */ }
    await this.disconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws);
  }

  async alarm(): Promise<void> {
    if (this.sessions.size === 0) await this.ctx.storage.deleteAll();
  }

  private async disconnect(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;
    const state = await this.getState();
    if (!state) return;
    if ([...this.sessions.values()].some((s) => s.playerId === session.playerId)) return;
    const player = state.players.find((p) => p.id === session.playerId);
    if (player) {
      player.connected = false;
      await this.save(state);
      this.broadcast(state);
    }
    if (this.sessions.size === 0) await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);
  }

  /** Applies one client message to the room. Returns an error string for the sender, or null. */
  private handle(state: RoomState, playerId: string, msg: RegicideClientMessage): string | null {
    const seat = state.players.findIndex((p) => p.id === playerId);
    const isHost = state.hostId === playerId;
    const game = state.game;

    switch (msg.type) {
      case 'join': {
        const name = normalizePlayerName(msg.name);
        if (seat >= 0) {
          if (name) state.players[seat].name = name;
          state.players[seat].connected = true;
          return null;
        }
        if (game) return 'This game has already started — you can watch until it ends';
        if (state.players.length >= MAX_PLAYERS) return 'This room is full (4 players)';
        state.players.push({ id: playerId, name: name || `Player ${state.players.length + 1}`, connected: true });
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
        state.game = null;
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
        state.game = newGame(state.players.length);
        state.gameNo++;
        return null;
      }
      case 'backToLobby': {
        if (!game) return null;
        const over = game.phase === 'won' || game.phase === 'lost';
        if (!over && !isHost) return 'Only the host can end the game early';
        if (seat < 0) return null;
        state.game = null;
        return null;
      }
    }

    if (!game) return 'The game has not started';
    if (seat < 0) return "You're watching this game";
    switch (msg.type) {
      case 'play': return playCards(game, seat, asCards(msg.cards));
      case 'yield': return yieldTurn(game, seat);
      case 'discard': return discardCards(game, seat, asCards(msg.cards));
      case 'chooseNext': return chooseNextPlayer(game, seat, Number(msg.seat));
      case 'flip': return flipSoloJester(game, seat);
    }
    return 'Unknown action';
  }

  private removePlayer(state: RoomState, seat: number): void {
    const [removed] = state.players.splice(seat, 1);
    if (state.hostId === removed.id) state.hostId = state.players[0]?.id ?? null;
  }

  private async getState(): Promise<RoomState | null> {
    return (await this.ctx.storage.get<RoomState>('state')) ?? null;
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put('state', state);
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
    players: state.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.id === state.hostId })),
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
