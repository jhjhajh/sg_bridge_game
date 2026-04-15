import { DurableObject } from 'cloudflare:workers';
import type { GameState, PlayerGameView, Suit, Hand, Env, TrickRecord, BidHistoryEntry, Spectator, TrickLogEntry } from './types';
import { NUM_PLAYERS, MAX_BID, CARD_SUITS, BID_SUITS } from './types';
import { generateHands, getBidFromNum, getNumFromBid, getValidSuits, compareCards, getNumFromValue } from './bridge';
import type { ClientMessage, ServerMessage } from './protocol';
import { recordGameResult, getWinnerSeats } from './stats';
import { getUser, recordGroupResult } from './db';
import { sendMessage, isChatMember } from './telegram';
import { recordGameStats, recordEloUpdate, type EloResult } from './stats-db';
import { insertGameHands, updateGameFinalHands, insertGameTricks, insertGameMetadata } from './game-logging';
import { settleBetsAndUpdateElo } from './betting-db';

interface SessionInfo {
  playerId: string;
}

export class GameRoom extends DurableObject {
  sessions: Map<WebSocket, SessionInfo>;
  private botActionRunning = false;
  private gameEndProcessed = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as SessionInfo | null;
      if (attachment) {
        this.sessions.set(ws, { ...attachment });
      }
    });
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { roomCode, groupId, groupName, origin } = (await request.json()) as { roomCode: string; groupId?: string | null; groupName?: string | null; origin?: string | null };
      const state = this.createInitialState(roomCode, groupId ?? null, groupName ?? null, origin ?? null);
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/send-group-invite' && request.method === 'POST') {
      const { origin } = (await request.json()) as { origin: string };
      const state = await this.getState();
      if (state?.groupId) {
        sendMessage(
          (this.env as Env).TELEGRAM_BOT_TOKEN,
          state.groupId,
          `🃏 Join the game → ${origin}/#${state.roomCode}`,
        ).catch(() => {});
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === '/phase') {
      const state = await this.getState();
      return Response.json({ phase: state?.phase ?? null, gameId: state?.gameId ?? null });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const playerId = url.searchParams.get('playerId');
      if (!playerId) {
        return new Response('Missing playerId', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Close any existing WebSocket for this playerId (prevents duplicate sessions
      // when switching between Telegram browser and system browser)
      for (const [existingWs, existingInfo] of this.sessions) {
        if (existingInfo.playerId === playerId) {
          try { existingWs.close(1000, 'Replaced by new connection'); } catch { /* already closed */ }
          this.sessions.delete(existingWs);
        }
      }

      const info: SessionInfo = { playerId };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(info);
      this.sessions.set(server, info);

      const state = await this.getState();
      if (state) {
        const player = state.players.find((p) => p.id === playerId);
        if (player) {
          player.connected = true;
          await this.refreshPlayerStats(player, playerId);
          await this.saveState(state);
          this.broadcastExcept(
            { type: 'playerReconnected', seat: player.seat, name: player.name },
            playerId,
          );
        }
        server.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    const session = this.sessions.get(ws);
    if (!session) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const state = await this.getState();
    if (!state) {
      ws.send(JSON.stringify({ type: 'error', message: 'No game found' }));
      return;
    }

    switch (msg.type) {
      case 'join':
        await this.handleJoin(state, session.playerId, msg.name, msg.joinAs, ws);
        break;
      case 'bid':
        await this.handleBid(state, session.playerId, msg.bidNum);
        this.ctx.waitUntil(this.scheduleBotAction());
        break;
      case 'pass':
        await this.handlePass(state, session.playerId);
        this.ctx.waitUntil(this.scheduleBotAction());
        break;
      case 'selectPartner':
        await this.handleSelectPartner(state, session.playerId, msg.card);
        this.ctx.waitUntil(this.scheduleBotAction());
        break;
      case 'playCard':
        await this.handlePlayCard(state, session.playerId, msg.card);
        this.ctx.waitUntil(this.scheduleBotAction());
        break;
      case 'playAgain':
        await this.handlePlayAgain(state, session.playerId);
        this.ctx.waitUntil(this.scheduleBotAction());
        break;
      case 'leave':
        await this.handleLeave(state, session.playerId);
        break;
      case 'watchSeat':
        await this.handleWatchSeat(state, session.playerId, msg.seat, ws);
        break;
      case 'addBot':
        await this.handleAddBot(state, session.playerId, msg.level ?? 'intermediate');
        break;
      case 'removeBot':
        await this.handleRemoveBot(state, session.playerId);
        break;
      case 'kickPlayer':
        await this.handleKickPlayer(state, session.playerId, msg.seat);
        break;
      case 'startGame':
        await this.handleStartGame(state, session.playerId);
        break;
      case 'chat':
        this.handleChat(state, session.playerId, msg.text);
        break;
      case 'pingPlayer':
        await this.handlePingPlayer(state, session.playerId, msg.seat, ws);
        break;
      case 'initiateAbandon':
        await this.handleInitiateAbandon(state, session.playerId, ws);
        break;
      case 'respondAbandon':
        await this.handleRespondAbandon(state, session.playerId, msg.accept);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code); } catch { /* already closed */ }
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (!session) return;

    const state = await this.getState();
    if (!state) return;

    const player = state.players.find((p) => p.id === session.playerId);
    if (player) {
      player.connected = false;
      // Track disconnect time only during bidding or play
      if (state.phase === 'bidding' || state.phase === 'play') {
        state.disconnectTimers[player.seat] = Date.now();
        // Set alarm for bot replacement only if no sooner alarm is already scheduled
        const botAlarmAt = Date.now() + 180000;
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm || existingAlarm > botAlarmAt) {
          await this.ctx.storage.setAlarm(botAlarmAt);
        }
      }
      await this.saveState(state);
      this.broadcast({
        type: 'playerDisconnected',
        seat: player.seat,
        name: player.name,
      });
    }

    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected && !state.gameStartAt) {
      // Only override with inactivity alarm if no bot-replacement alarm is pending
      const existingAlarm = await this.ctx.storage.getAlarm();
      const inactivityAlarmAt = Date.now() + 5 * 60 * 1000;
      if (!existingAlarm || existingAlarm > inactivityAlarmAt) {
        await this.ctx.storage.setAlarm(inactivityAlarmAt);
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;

    // Countdown alarm — auto-start game when 5 seconds elapse
    if (state.gameStartAt !== null && Date.now() >= state.gameStartAt - 100) {
      if (state.phase === 'lobby' && state.players.length === NUM_PLAYERS) {
        const anyConnected = state.players.some((p) => p.connected);
        if (anyConnected) {
          await this.startGameFromLobby(state);
          return;
        }
      }
      // Countdown fired but couldn't start — schedule cleanup
      state.gameStartAt = null;
      await this.saveState(state);
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      return;
    }

    // Bot replacement alarm — check if any disconnected players need bot takeover
    if (state.phase === 'bidding' || state.phase === 'play') {
      const now = Date.now();
      const botReplacementThreshold = 180000; // 3 minutes in milliseconds
      let needsSave = false;

      for (const [seatStr, disconnectTime] of Object.entries(state.disconnectTimers)) {
        const seat = Number(seatStr);
        const player = state.players[seat];

        if (!player) continue;
        if (player.isBot) continue; // Already a bot
        if (player.connected) continue; // Reconnected

        // Check if 3 minutes have passed since disconnect
        if (now - disconnectTime >= botReplacementThreshold) {
          // Replace with sophisticated bot
          const originalPlayerId = player.id;
          player.id = `bot_replacement_${Date.now()}_${seat}`;
          player.isBot = true;
          player.botLevel = 'sophisticated';
          player.originalPlayerId = originalPlayerId;
          delete state.disconnectTimers[seat]; // Clean up timer
          needsSave = true;
        }
      }

      if (needsSave) {
        await this.saveState(state);
        // Push full state so clients see bot icons and names update
        this.broadcastFullState(state);
        // Trigger bot to act immediately if it's their turn
        this.ctx.waitUntil(this.scheduleBotAction());
      }

      // Re-schedule alarm for any remaining pending disconnect timers
      const pendingTimers = Object.values(state.disconnectTimers);
      if (pendingTimers.length > 0) {
        const nextAlarmAt = Math.min(...pendingTimers) + botReplacementThreshold;
        await this.ctx.storage.setAlarm(nextAlarmAt);
        return;
      }
    }

    // Abandon vote timeout — auto-accept after 1 minute
    if (state.abandonVote && Date.now() >= state.abandonVote.expiresAt) {
      const connectedHumans = state.players.filter((p) => p.connected && !p.isBot);

      // Auto-accept any unresponded votes
      connectedHumans.forEach((p) => {
        if (state.abandonVote!.votes[p.seat] === null) {
          state.abandonVote!.votes[p.seat] = true;
        }
      });

      // Check if all have voted and all accepted
      const allAccepted = connectedHumans.every((p) => state.abandonVote!.votes[p.seat] === true);

      if (allAccepted) {
        // Unanimous yes — end game
        state.abandonVote = undefined;
        await this.endGameWithAbandon(state);
        return;
      } else {
        // Some rejected or timed out as no — cancel vote
        state.abandonVote = undefined;
        await this.saveState(state);
        this.broadcast({
          type: 'abandonVoteFailed',
          rejectSeat: -1,
          rejectName: 'Timeout',
        });
      }

      // After handling the vote, re-schedule alarm for any pending bot-replacement timers
      const pendingTimers = Object.values(state.disconnectTimers);
      if (pendingTimers.length > 0 && (state.phase === 'bidding' || state.phase === 'play')) {
        const nextAlarmAt = Math.min(...pendingTimers) + 180000;
        await this.ctx.storage.setAlarm(nextAlarmAt);
        return;
      }
    }

    // Inactivity cleanup alarm
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected) {
      await this.ctx.storage.deleteAll();
    }
  }

  // --- State helpers ---

  private createInitialState(roomCode: string, groupId: string | null = null, groupName: string | null = null, origin: string | null = null): GameState {
    return {
      roomCode,
      phase: 'lobby',
      players: [],
      hands: [],
      turn: 0,
      bidder: -1,
      bid: -1,
      trumpSuit: null,
      setsNeeded: -1,
      sets: [0, 0, 0, 0],
      trumpBroken: false,
      firstPlayer: 0,
      currentSuit: null,
      playedCards: [null, null, null, null],
      partner: -1,
      partnerCard: null,
      passCount: 0,
      lastTrick: null,
      trickComplete: false,
      bidHistory: [],
      spectators: [],
      firstBidder: 0,
      groupId,
      groupName,
      gameStartAt: null,
      partnerRevealed: false,
      gameId: crypto.randomUUID(),
      readySeats: [],
      trickLog: [],
      trickWinners: [],
      initialHands: [],
      origin,
      pingCooldowns: {},
      disconnectTimers: {},
    };
  }

  private async getState(): Promise<GameState | null> {
    return (await this.ctx.storage.get<GameState>('state')) ?? null;
  }

  private async saveState(state: GameState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  /** Returns true if game_records already has rows for this gameId (idempotency guard). */
  private async isGameAlreadyRecorded(gameId: string): Promise<boolean> {
    const row = await (this.env as Env).DB
      .prepare('SELECT 1 FROM game_records WHERE game_id = ? LIMIT 1')
      .bind(gameId)
      .first();
    return !!row;
  }

  private buildStateMessage(state: GameState, playerId: string): ServerMessage {
    const player = state.players.find((p) => p.id === playerId);
    const spectator = !player ? state.spectators.find((s) => s.id === playerId) : undefined;
    const isSpectator = !!spectator;
    const watchingSeat = spectator?.watchingSeat ?? -1;
    const isFullBoard = isSpectator && watchingSeat === -2;
    // For full board, anchor to seat 0 (north) for consistent orientation. For regular viewers, use the watched/played seat.
    const mySeat = player?.seat ?? (spectator ? (isFullBoard ? 0 : watchingSeat) : -1);

    const view: PlayerGameView = {
      roomCode: state.roomCode,
      phase: state.phase,
      players: state.players.map((p) => ({
        name: p.name,
        seat: p.seat,
        connected: p.connected,
        wins: p.wins,
        gamesPlayed: p.gamesPlayed,
        isBot: p.isBot,
        botLevel: p.botLevel,
        isGroupMember: p.isGroupMember,
        elo: p.elo,
        telegramId: p.id.startsWith('tg_') ? Number(p.id.slice(3)) : undefined,
      })),
      hand: !isFullBoard && mySeat >= 0 && state.hands.length > 0 ? state.hands[mySeat] : null,
      allHands: isFullBoard && state.hands.length > 0 ? state.hands : null,
      turn: state.turn,
      bidder: state.bidder,
      bid: state.bid,
      trumpSuit: state.trumpSuit,
      setsNeeded: state.setsNeeded,
      sets: state.sets,
      trumpBroken: state.trumpBroken,
      firstPlayer: state.firstPlayer,
      currentSuit: state.currentSuit,
      playedCards: state.playedCards,
      partnerCard: state.partnerCard,
      isPartner: state.partner === mySeat,
      mySeat,
      lastTrick: state.lastTrick,
      trickComplete: state.trickComplete,
      bidHistory: state.bidHistory,
      isSpectator,
      watchingSeat,
      groupId: state.groupId,
      groupName: state.groupName,
      isGroupMember: player?.isGroupMember,
      gameStartAt: state.gameStartAt,
      partnerSeat: (state.partnerRevealed || state.phase === 'gameover') ? state.partner : -1,
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
      readySeats: state.readySeats,
      allInitialHands: state.phase === 'gameover' && state.initialHands.length > 0
        ? state.initialHands
        : null,
      allFinalHands: state.phase === 'gameover' && state.initialHands.length > 0
        ? state.hands
        : null,
      trickLog: state.phase === 'gameover' && state.trickLog.length > 0 ? state.trickLog : null,
      trickWinners: state.phase === 'gameover' && state.trickWinners.length > 0 ? state.trickWinners : null,
      gameId: state.gameId,
      isPractice: state.players.filter((p) => p.isBot).length >= 2,
    };
    return { type: 'state', state: view };
  }

  // --- Broadcast helpers ---

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.sessions) {
      try {
        ws.send(data);
      } catch {
        // stale connection
      }
    }
  }

  private broadcastExcept(msg: ServerMessage, excludePlayerId: string): void {
    const data = JSON.stringify(msg);
    for (const [ws, info] of this.sessions) {
      if (info.playerId === excludePlayerId) continue;
      try {
        ws.send(data);
      } catch {
        // stale connection
      }
    }
  }

  private sendToPlayer(playerId: string, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws, info] of this.sessions) {
      if (info.playerId === playerId) {
        try {
          ws.send(data);
        } catch {
          // stale connection
        }
        return;
      }
    }
  }

  private broadcastFullState(state: GameState): void {
    for (const [ws, info] of this.sessions) {
      try {
        ws.send(JSON.stringify(this.buildStateMessage(state, info.playerId)));
      } catch {
        // stale connection
      }
    }
  }

  private async refreshPlayerStats(player: import('./types').Player, playerId: string): Promise<void> {
    if (!playerId.startsWith('tg_')) return;
    const telegramId = Number(playerId.slice(3));
    const userRow = await getUser((this.env as Env).DB, telegramId).catch(() => null);
    if (userRow && userRow.games_played > 0) {
      player.wins = userRow.wins;
      player.gamesPlayed = userRow.games_played;
      player.elo = userRow.elo;
    } else {
      player.wins = undefined;
      player.gamesPlayed = undefined;
      player.elo = undefined;
    }
  }

  private getSeatPlayer(state: GameState, playerId: string): number {
    const p = state.players.find((pl) => pl.id === playerId);
    return p ? p.seat : -1;
  }

  // --- Action handlers ---

  private async handleJoin(
    state: GameState,
    playerId: string,
    name: string,
    joinAs: 'player' | 'spectator' | undefined,
    ws: WebSocket,
  ): Promise<void> {
    if (!playerId.startsWith('tg_')) {
      ws.send(JSON.stringify({ type: 'error', message: 'You must log in with Telegram to play.' }));
      return;
    }
    const existing = state.players.find((p) => p.id === playerId);
    if (existing) {
      existing.name = name;
      existing.connected = true;
      // Clear disconnect timer when player reconnects
      delete state.disconnectTimers[existing.seat];
      await this.refreshPlayerStats(existing, playerId);
      await this.saveState(state);
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      this.broadcastExcept(
        { type: 'playerReconnected', seat: existing.seat, name: existing.name },
        playerId,
      );
      return;
    }

    // Check if a bot is currently replacing this player (they're rejoining mid-game)
    const botReplacement = state.players.find((p) => p.originalPlayerId === playerId);
    if (botReplacement && (state.phase === 'bidding' || state.phase === 'play')) {
      // Player rejoins and takes over from bot — update bot's originalPlayerId and mark as not-bot
      botReplacement.id = playerId;
      botReplacement.isBot = false;
      botReplacement.botLevel = undefined;
      botReplacement.originalPlayerId = undefined;
      botReplacement.connected = true;
      // Clear disconnect timer
      delete state.disconnectTimers[botReplacement.seat];
      await this.refreshPlayerStats(botReplacement, playerId);
      await this.saveState(state);
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      this.broadcastExcept(
        { type: 'playerReconnected', seat: botReplacement.seat, name: botReplacement.name },
        playerId,
      );
      return;
    }

    // Check if already a spectator (reconnect)
    const existingSpectator = state.spectators.find((s) => s.id === playerId);
    if (existingSpectator) {
      existingSpectator.name = name;
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      return;
    }

    if (state.phase !== 'lobby') {
      // Game in progress — join as spectator
      state.spectators.push({ id: playerId, name, watchingSeat: -1 });
      await this.saveState(state);
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      return;
    }

    // If explicitly joining as spectator, or all seats full, join as spectator
    if (joinAs === 'spectator' || state.players.length >= NUM_PLAYERS) {
      state.spectators.push({ id: playerId, name, watchingSeat: -1 });
      await this.saveState(state);
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      return;
    }

    const seat = state.players.length;
    const newPlayer = { id: playerId, name, seat, connected: true } as import('./types').Player;
    await this.refreshPlayerStats(newPlayer, playerId);

    // Group membership check
    if (state.groupId && playerId.startsWith('tg_')) {
      const telegramId = Number(playerId.slice(3));
      newPlayer.isGroupMember = await isChatMember(
        (this.env as Env).TELEGRAM_BOT_TOKEN,
        state.groupId,
        telegramId,
      );
    } else if (state.groupId) {
      // Guest in a group-linked room — not a member
      newPlayer.isGroupMember = false;
    }

    state.players.push(newPlayer);

    this.broadcast({
      type: 'joined',
      playerName: name,
      seat,
      playerCount: state.players.length,
    });

    if (state.players.length === NUM_PLAYERS) {
      state.gameStartAt = Date.now() + 5000;
      await this.ctx.storage.setAlarm(state.gameStartAt);
    }
    await this.saveState(state);
    this.broadcastFullState(state);

    // Notify Telegram group on each new join
    if (state.groupId && state.origin) {
      const playerNames = state.players.map((p) => p.name).join(', ');
      const n = state.players.length;
      const joinLink = `${state.origin}/#${state.roomCode}`;
      sendMessage(
        (this.env as Env).TELEGRAM_BOT_TOKEN,
        state.groupId,
        `👤 <b>${name}</b> joined the lobby! (${n}/4)\nPlayers: ${playerNames}\n🃏 Join → ${joinLink}`,
      ).catch(() => {});
    }
  }

  private async handleBid(
    state: GameState,
    playerId: string,
    bidNum: number,
  ): Promise<void> {
    if (state.phase !== 'bidding') return;

    const seat = this.getSeatPlayer(state, playerId);
    if (seat !== state.turn) return;
    if (bidNum <= state.bid || bidNum > MAX_BID) return;

    const bidStr = getBidFromNum(bidNum);
    const parts = bidStr.split(' ');

    state.bid = bidNum;
    state.trumpSuit = parts[1] as typeof state.trumpSuit;
    state.setsNeeded = parseInt(parts[0], 10) + 6;
    state.bidder = seat;
    state.passCount = 0;
    state.bidHistory.push({ seat, name: state.players[seat].name, bidNum });

    this.broadcast({
      type: 'bidMade',
      seat,
      bidNum,
      name: state.players[seat].name,
    });

    state.turn = (state.turn + 1) % NUM_PLAYERS;

    if (state.bidder === state.turn || state.bid === MAX_BID) {
      await this.finalizeBidding(state);
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
    }
  }

  private async handlePass(state: GameState, playerId: string): Promise<void> {
    if (state.phase !== 'bidding') return;

    const seat = this.getSeatPlayer(state, playerId);
    if (seat !== state.turn) return;

    state.passCount++;
    state.bidHistory.push({ seat, name: state.players[seat].name, bidNum: null });

    this.broadcast({
      type: 'passed',
      seat,
      name: state.players[seat].name,
    });

    state.turn = (state.turn + 1) % NUM_PLAYERS;

    if (state.passCount === NUM_PLAYERS && state.bidder < 0) {
      // All passed without any bid -- redeal
      state.hands = generateHands();
      state.turn = state.firstBidder;
      state.bid = -1;
      state.bidder = -1;
      state.passCount = 0;
      state.bidHistory = [];
      await this.saveState(state);

      this.broadcast({ type: 'allPassed' });
      this.broadcastFullState(state);
      return;
    }

    if (state.bidder >= 0 && state.bidder === state.turn) {
      await this.finalizeBidding(state);
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
    }
  }

  private async finalizeBidding(state: GameState): Promise<void> {
    if (state.bidder < 0) {
      // Everyone passed with no bid -- redeal
      state.hands = generateHands();
      state.turn = state.firstBidder;
      state.bid = -1;
      state.bidder = -1;
      state.passCount = 0;
      state.bidHistory = [];
      await this.saveState(state);

      this.broadcast({ type: 'allPassed' });
      this.broadcastFullState(state);
      return;
    }

    state.phase = 'partner';
    state.turn = state.bidder;

    this.broadcast({
      type: 'bidWon',
      seat: state.bidder,
      bidNum: state.bid,
      setsNeeded: state.setsNeeded,
      name: state.players[state.bidder].name,
    });

    if (state.groupId) {
      sendMessage(
        (this.env as Env).TELEGRAM_BOT_TOKEN,
        state.groupId,
        `🔨 ${state.players[state.bidder].name} bid ${getBidFromNum(state.bid)}`,
      ).catch(() => {});
    }

    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleSelectPartner(
    state: GameState,
    playerId: string,
    card: string,
  ): Promise<void> {
    if (state.phase !== 'partner') return;

    const seat = this.getSeatPlayer(state, playerId);
    if (seat !== state.bidder) return;

    const cardParts = card.split(' ');
    if (cardParts.length !== 2) return;
    const [cardValue, cardSuit] = cardParts;

    state.partnerCard = card;
    state.partner = -1;

    for (let i = 0; i < NUM_PLAYERS; i++) {
      if (state.hands[i][cardSuit as Suit]?.includes(cardValue)) {
        state.partner = i;
        break;
      }
    }

    if (state.partner < 0) {
      state.partner = state.bidder;
    }

    this.broadcast({ type: 'partnerSelected', card });

    if (state.partner !== state.bidder) {
      this.sendToPlayer(state.players[state.partner].id, {
        type: 'youArePartner',
        bidderName: state.players[state.bidder].name,
      });
    }

    state.phase = 'play';
    state.playedCards = [null, null, null, null];
    state.currentSuit = null;

    if (state.trumpSuit === '🚫') {
      state.firstPlayer = state.bidder;
      state.turn = state.bidder;
    } else {
      state.turn = (state.bidder + 1) % NUM_PLAYERS;
      state.firstPlayer = state.turn;
    }

    this.broadcast({
      type: 'playPhaseStart',
      turn: state.turn,
      firstPlayerName: state.players[state.turn].name,
    });

    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handlePlayCard(
    state: GameState,
    playerId: string,
    card: string,
  ): Promise<void> {
    if (state.phase !== 'play') return;

    const seat = this.getSeatPlayer(state, playerId);
    if (seat !== state.turn) return;

    const cardParts = card.split(' ');
    if (cardParts.length !== 2) return;
    const [cardValue, cardSuit] = cardParts;
    const suit = cardSuit as Suit;

    const hand = state.hands[seat];
    const validSuits = getValidSuits(
      hand,
      state.trumpSuit,
      state.currentSuit,
      state.trumpBroken,
    );

    if (!validSuits.includes(suit) || !hand[suit].includes(cardValue)) {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: 'Invalid card',
      });
      return;
    }

    hand[suit] = hand[suit].filter((v) => v !== cardValue);

    if (state.trickComplete) {
      state.playedCards = [null, null, null, null];
      state.trickComplete = false;
    }

    const trickNum = state.sets.reduce((s, v) => s + v, 0) + 1;
    const playOrder = state.playedCards.filter((c) => c !== null).length + 1;
    state.trickLog.push({ trickNum, playOrder, seat, card });

    state.playedCards[seat] = card;

    if (card === state.partnerCard && !state.partnerRevealed) {
      state.partnerRevealed = true;
    }

    if (state.firstPlayer === seat) {
      state.currentSuit = suit;
    }

    if (suit === state.trumpSuit) {
      state.trumpBroken = true;
    }

    state.turn = (state.turn + 1) % NUM_PLAYERS;

    this.broadcast({
      type: 'cardPlayed',
      seat,
      card,
      nextTurn: state.turn,
    });

    if (state.turn === state.firstPlayer) {
      const cardsPlayed = state.playedCards.map((c, i) => {
        const offset = (i - state.firstPlayer + NUM_PLAYERS) % NUM_PLAYERS;
        return { card: c!, offset };
      });
      cardsPlayed.sort((a, b) => a.offset - b.offset);
      const orderedCards = cardsPlayed.map((c) => c.card);

      const winnerOffset = compareCards(orderedCards, state.currentSuit!, state.trumpSuit);
      const winner = (state.firstPlayer + winnerOffset) % NUM_PLAYERS;

      state.sets[winner]++;
      state.trickWinners.push(winner);
      state.lastTrick = {
        cards: [...state.playedCards],
        winner,
      };

      state.turn = winner;
      state.firstPlayer = winner;
      state.currentSuit = null;
      state.trickComplete = true;

      const bidder = state.bidder;
      const partner = state.partner;
      const bidderSets =
        partner === bidder
          ? state.sets[bidder]
          : state.sets[bidder] + state.sets[partner];

      const opponentSets = state.sets.reduce((s, v) => s + v, 0) - bidderSets;

      this.broadcast({
        type: 'trickWon',
        winnerSeat: winner,
        sets: [...state.sets],
        nextTurn: winner,
        winnerName: state.players[winner].name,
        trickCards: [...state.lastTrick.cards],
      });

      const isPracticeGame = state.players.filter((p) => p.isBot).length >= 2;

      if (bidderSets >= state.setsNeeded) {
        state.phase = 'gameover';
        state.readySeats = [];
        const winnerNames =
          partner === bidder
            ? [state.players[bidder].name]
            : [state.players[bidder].name, state.players[partner].name];

        this.broadcast({
          type: 'gameOver',
          bidderWon: true,
          winnerNames,
        });

        // Idempotency guard: in-memory Set prevents same-instance races (synchronous, no TOCTOU),
        // D1 check prevents duplicate processing across DO eviction/wake cycles
        if (!this.gameEndProcessed.has(state.gameId)) {
          this.gameEndProcessed.add(state.gameId);
          const alreadyRecorded = await this.isGameAlreadyRecorded(state.gameId);
          if (!alreadyRecorded) {
            if (!isPracticeGame) await recordGameResult(
              (this.env as Env).DB,
              state.players,
              getWinnerSeats(bidder, partner, true),
            );

            let eloResults: EloResult[] = [];
            if (!isPracticeGame) {
              await recordGameStats(
                (this.env as Env).DB,
                state.gameId,
                state.groupId,
                state.players,
                bidder,
                partner,
                state.bid,
                state.sets,
                getWinnerSeats(bidder, partner, true),
              );

              eloResults = await recordEloUpdate(
                (this.env as Env).DB,
                state.gameId,
                state.players,
                bidder,
                partner,
                getWinnerSeats(bidder, partner, true),
              );
            }

            if (state.groupId) {
              const bidStr = getBidFromNum(state.bid);
              const eloLines = eloResults.length > 0
                ? '\n' + eloResults.map((r) => `  ${r.name}: ${r.delta >= 0 ? '+' : ''}${r.delta} → ${r.eloAfter}`).join('\n')
                : '';
              sendMessage(
                (this.env as Env).TELEGRAM_BOT_TOKEN,
                state.groupId,
                `🏆 ${winnerNames.join(' & ')} won!\nBid ${bidStr}, made ${bidderSets}/${state.setsNeeded} tricks${isPracticeGame ? '\n(practice — unrated)' : eloLines}`,
              ).catch(() => {});
              if (!isPracticeGame) await recordGroupResult(
                (this.env as Env).DB,
                state.groupId,
                state.players,
                getWinnerSeats(bidder, partner, true),
              );
            }

            this.ctx.waitUntil(
              Promise.all([
                updateGameFinalHands((this.env as Env).DB, state.gameId, state.players, state.hands),
                insertGameTricks((this.env as Env).DB, state.gameId, state.trickLog),
                insertGameMetadata(
                  (this.env as Env).DB,
                  state.gameId,
                  bidder,
                  state.bid,
                  state.trumpSuit,
                  state.partnerCard ?? '',
                  state.bidHistory,
                  state.players,
                  state.sets,
                  'bidder',
                ),
                settleBetsAndUpdateElo((this.env as Env).DB, state.gameId, true),
              ]).catch(() => {}),
            );
          }
        }

        await this.saveState(state);
        this.broadcastFullState(state);
        return;
      }

      if (opponentSets >= 14 - state.setsNeeded) {
        state.phase = 'gameover';
        state.readySeats = [];
        const winnerNames = state.players
          .filter((_, i) => i !== bidder && i !== partner)
          .map((p) => p.name);

        this.broadcast({
          type: 'gameOver',
          bidderWon: false,
          winnerNames,
        });

        // Idempotency guard (same as bidder-win block above)
        if (!this.gameEndProcessed.has(state.gameId)) {
          this.gameEndProcessed.add(state.gameId);
          const alreadyRecorded = await this.isGameAlreadyRecorded(state.gameId);
          if (!alreadyRecorded) {
            if (!isPracticeGame) await recordGameResult(
              (this.env as Env).DB,
              state.players,
              getWinnerSeats(bidder, partner, false),
            );

            let eloResults: EloResult[] = [];
            if (!isPracticeGame) {
              await recordGameStats(
                (this.env as Env).DB,
                state.gameId,
                state.groupId,
                state.players,
                bidder,
                partner,
                state.bid,
                state.sets,
                getWinnerSeats(bidder, partner, false),
              );

              eloResults = await recordEloUpdate(
                (this.env as Env).DB,
                state.gameId,
                state.players,
                bidder,
                partner,
                getWinnerSeats(bidder, partner, false),
              );
            }

            if (state.groupId) {
              const bidStr = getBidFromNum(state.bid);
              const eloLines = eloResults.length > 0
                ? '\n' + eloResults.map((r) => `  ${r.name}: ${r.delta >= 0 ? '+' : ''}${r.delta} → ${r.eloAfter}`).join('\n')
                : '';
              sendMessage(
                (this.env as Env).TELEGRAM_BOT_TOKEN,
                state.groupId,
                `🛡️ ${winnerNames.join(' & ')} defended!\n${state.players[bidder].name}'s ${bidStr} bid failed${isPracticeGame ? '\n(practice — unrated)' : eloLines}`,
              ).catch(() => {});
              if (!isPracticeGame) await recordGroupResult(
                (this.env as Env).DB,
                state.groupId,
                state.players,
                getWinnerSeats(bidder, partner, false),
              );
            }

            this.ctx.waitUntil(
              Promise.all([
                updateGameFinalHands((this.env as Env).DB, state.gameId, state.players, state.hands),
                insertGameTricks((this.env as Env).DB, state.gameId, state.trickLog),
                insertGameMetadata(
                  (this.env as Env).DB,
                  state.gameId,
                  bidder,
                  state.bid,
                  state.trumpSuit,
                  state.partnerCard ?? '',
                  state.bidHistory,
                  state.players,
                  state.sets,
                  'opponents',
                ),
                settleBetsAndUpdateElo((this.env as Env).DB, state.gameId, false),
              ]).catch(() => {}),
            );
          }
        }

        await this.saveState(state);
        this.broadcastFullState(state);
        return;
      }

      await this.saveState(state);
      this.broadcastFullState(state);
      return;
    }

    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleWatchSeat(
    state: GameState,
    playerId: string,
    seat: number,
    ws: WebSocket,
  ): Promise<void> {
    const spectator = state.spectators.find((s) => s.id === playerId);
    if (!spectator) return;
    if (seat < -2 || seat >= NUM_PLAYERS) return; // -2 = full board, -1 = unset, 0-3 = specific seat
    spectator.watchingSeat = seat;
    await this.saveState(state);
    ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
  }

  private async handlePlayAgain(
    state: GameState,
    playerId: string,
  ): Promise<void> {
    if (state.phase !== 'gameover') return;

    const player = state.players.find((p) => p.id === playerId);
    if (!player) return; // spectator or unknown — ignore

    if (state.readySeats.includes(player.seat)) return; // already ready

    state.readySeats = [...state.readySeats, player.seat];

    if (state.readySeats.length < NUM_PLAYERS) {
      await this.saveState(state);
      this.broadcastFullState(state);
      return;
    }

    // All players ready — transition to lobby with countdown
    state.readySeats = [];
    state.phase = 'lobby';
    state.gameStartAt = Date.now() + 5000;
    await this.ctx.storage.setAlarm(state.gameStartAt);
    await this.saveState(state);
    this.broadcastFullState(state);
  }

  // --- Bot support ---

  private async scheduleBotAction(): Promise<void> {
    await Promise.resolve(); // micro-yield so any pending finally blocks run first
    if (this.botActionRunning) return;
    this.botActionRunning = true;
    try {
      while (true) {
        await new Promise<void>((r) => setTimeout(r, 700));
        const state = await this.getState();
        if (!state) break;
        const acted = await this.triggerBotAction(state);
        if (!acted) break;
      }
    } finally {
      this.botActionRunning = false;
    }
  }

  private async triggerBotAction(state: GameState): Promise<boolean> {
    if (state.phase === 'gameover') {
      const unreadyBot = state.players.find((p) => p.isBot && !state.readySeats.includes(p.seat));
      if (unreadyBot) {
        await this.handlePlayAgain(state, unreadyBot.id);
        return true;
      }
      return false;
    }
    if (state.phase === 'bidding') {
      const current = state.players[state.turn];
      if (!current?.isBot) return false;
      const bidNum = (current.botLevel === 'advanced' || current.botLevel === 'sophisticated')
        ? this.getBotBidAdvanced(state, state.turn)
        : this.getBotBid(state, state.turn); // basic and intermediate use same bidding
      if (bidNum !== null) {
        await this.handleBid(state, current.id, bidNum);
      } else {
        await this.handlePass(state, current.id);
      }
      return true;
    }
    if (state.phase === 'partner') {
      const bidder = state.players[state.bidder];
      if (!bidder?.isBot) return false;
      const card = this.getBotPartnerCard(state, state.bidder);
      await this.handleSelectPartner(state, bidder.id, card);
      return true;
    }
    if (state.phase === 'play') {
      const current = state.players[state.turn];
      if (!current?.isBot) return false;
      const card = current.botLevel === 'sophisticated'
        ? this.getBotCardSophisticated(state, state.turn)
        : current.botLevel === 'advanced'
        ? this.getBotCardAdvanced(state, state.turn)
        : current.botLevel === 'basic'
        ? this.getBotCardBasic(state, state.turn)
        : this.getBotCard(state, state.turn);
      if (!card) return false;
      await this.handlePlayCard(state, current.id, card);
      return true;
    }
    return false;
  }

  // --- Basic bot card play ---
  // Greedy: always try to win the current trick with the lowest winning card.
  // If can't win, play the lowest card. Uses same bidding as intermediate.

  private getBotCardBasic(state: GameState, seat: number): string {
    const hand = state.hands[seat];
    const validSuits = getValidSuits(hand, state.trumpSuit, state.currentSuit, state.trumpBroken);
    if (validSuits.length === 0) return '';

    const validCards: string[] = [];
    for (const suit of validSuits) {
      for (const value of hand[suit]) {
        validCards.push(`${value} ${suit}`);
      }
    }
    if (validCards.length === 0) return '';

    const trickInProgress = !state.trickComplete && state.playedCards.some((c) => c !== null);

    if (!trickInProgress) {
      // Lead: play lowest card in longest non-trump suit; fallback to lowest overall
      const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
      const pool = nonTrump.length > 0 ? nonTrump : validCards;
      return pool.reduce((a, b) => getNumFromValue(a.split(' ')[0]) < getNumFromValue(b.split(' ')[0]) ? a : b);
    }

    // Try to win: find lowest card that wins when added to the current trick
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (winning.length > 0) {
      return winning.reduce((a, b) => getNumFromValue(a.split(' ')[0]) < getNumFromValue(b.split(' ')[0]) ? a : b);
    }

    // Can't win — play lowest card
    return validCards.reduce((a, b) => getNumFromValue(a.split(' ')[0]) < getNumFromValue(b.split(' ')[0]) ? a : b);
  }

  // --- Intermediate bot card play ---
  // Confidence model: before partner card revealed = 0.65, after = 0.85.
  // Each decision point rolls Math.random() against confidence; failures fall back to basic logic.
  // Bidder team: don't steal partner's win, cover partner when losing.
  // Opposition: don't waste trump on lost tricks, prioritise blocking the bidder, avoid leading trump.
  // Leading: bidder team prefers suits partner bid (bid history signal); opposition avoids bidder's suits.

  private getBotCard(state: GameState, seat: number): string {
    const hand = state.hands[seat];
    const validSuits = getValidSuits(hand, state.trumpSuit, state.currentSuit, state.trumpBroken);
    if (validSuits.length === 0) return '';

    const validCards: string[] = [];
    for (const suit of validSuits) {
      for (const value of hand[suit]) {
        validCards.push(`${value} ${suit}`);
      }
    }
    if (validCards.length === 0) return '';

    const trickInProgress = !state.trickComplete && state.playedCards.some((c) => c !== null);
    const onBidderTeam = this.isOnBidderTeam(state, seat);
    const confidence = this.isPartnerCardRevealed(state) ? 0.85 : 0.65;
    const useTeamLogic = state.partner >= 0 && Math.random() < confidence;

    if (!trickInProgress) {
      return useTeamLogic
        ? this.getBotLeadCard(state, seat, validCards, onBidderTeam)
        : this.lowestCard(validCards);
    }

    if (useTeamLogic) {
      return onBidderTeam
        ? this.getBotCardAsBidderTeam(state, seat, validCards)
        : this.getBotCardAsOpposition(state, seat, validCards);
    }

    // Basic fallback: win if possible, else smartDump (avoids trump + prefers shortest side suit)
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winningCards = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    return winningCards.length > 0 ? this.lowestCard(winningCards) : this.smartDump(state, seat, validCards);
  }

  private getBotCardAsBidderTeam(state: GameState, seat: number, validCards: string[]): string {
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);

    // Teammate already winning — don't steal the trick
    if (currentWinnerSeat !== null && this.isOnBidderTeam(state, currentWinnerSeat)) {
      return this.smartDump(state, seat, validCards);
    }

    // Boss card that would actually win this trick — always play it.
    // Must verify with compareCards: a boss card in a non-led, non-trump suit (e.g. A♣ when void
    // in the led suit) is NOT a trick winner and must not be played as a discard.
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const bossCard = validCards.find((c) => {
      if (!this.isBossCard(state, c)) return false;
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (bossCard) return bossCard;

    const afterUs = this.getPlayersAfter(state, seat);
    const teammateIsLast = afterUs.length > 0 && this.isOnBidderTeam(state, afterUs[afterUs.length - 1]);
    const partnerBidSuits = this.getPartnerBidSuits(state);

    // Teammate plays last — they have best information; dump unless led suit is not their strength
    if (teammateIsLast) {
      const ledSuitIsPartnerStrength = state.currentSuit && partnerBidSuits.has(state.currentSuit);
      if (!ledSuitIsPartnerStrength) return this.smartDump(state, seat, validCards);
      // Partner is strong in this suit but we might be able to save their card — fall through to win
    }

    // Opposition winning — try to win
    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });

    if (winning.length === 0) return this.smartDump(state, seat, validCards);

    // If an opponent plays after us, commit highest winning card to guard against being overtaken
    const opponentAfter = afterUs.some((s) => !this.isOnBidderTeam(state, s));
    return opponentAfter ? this.highestCard(winning) : this.lowestCard(winning);
  }

  private getBotCardAsOpposition(state: GameState, seat: number, validCards: string[]): string {
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);

    // Opposition teammate already winning — don't steal the trick
    if (currentWinnerSeat !== null && !this.isOnBidderTeam(state, currentWinnerSeat)) {
      return this.smartDump(state, seat, validCards);
    }

    // Boss card that would actually win this trick (same void-in-led-suit guard as bidder team).
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const bossCard = validCards.find((c) => {
      if (!this.isBossCard(state, c)) return false;
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (bossCard) return bossCard;

    const afterUs = this.getPlayersAfter(state, seat);
    const oppTeammateIsLast = afterUs.length > 0 && !this.isOnBidderTeam(state, afterUs[afterUs.length - 1]);
    const bidderBidSuits = this.getBidderBidSuits(state);

    // Opposition teammate plays last — let them decide with most information
    if (oppTeammateIsLast) {
      // If led suit is safe (not bidder's strength), trust teammate to handle it
      const ledSuitIsBidderStrength = state.currentSuit && bidderBidSuits.has(state.currentSuit);
      if (!ledSuitIsBidderStrength) return this.smartDump(state, seat, validCards);
      // Bidder's strong suit — teammate may not be able to beat it; try ourselves
    }

    // Bidder team winning — try to beat them
    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });

    if (winning.length === 0) return this.smartDump(state, seat, validCards);

    // If a bidder-team player plays after us, commit highest winning card to guard against re-overtake
    const bidderTeamAfter = afterUs.some((s) => this.isOnBidderTeam(state, s));
    return bidderTeamAfter ? this.highestCard(winning) : this.lowestCard(winning);
  }

  private getBotLeadCard(
    state: GameState,
    seat: number,
    validCards: string[],
    onBidderTeam: boolean,
  ): string {
    const partnerBidSuits = this.getPartnerBidSuits(state);
    const bidderBidSuits = this.getBidderBidSuits(state);
    const voids = this.getVoids(state);

    if (onBidderTeam) {
      // Prefer leading a suit the partner bid (they likely have more) — lead high to establish
      const partnerSuitCards = validCards.filter(
        (c) => partnerBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
      );
      if (partnerSuitCards.length > 0) return this.highestCard(partnerSuitCards);

      // Avoid suits where an opponent is void (they would ruff)
      const oppSeats = [0, 1, 2, 3].filter((s) => s !== seat && !this.isOnBidderTeam(state, s));
      const nonRuffable = validCards.filter((c) => {
        const suit = c.split(' ')[1] as Suit;
        if (suit === state.trumpSuit) return false;
        return !oppSeats.some((s) => voids.get(s)?.has(suit));
      });
      return this.leadLongestNonTrump(state, seat, nonRuffable.length > 0 ? nonRuffable : validCards);
    } else {
      // Opposition: never lead trump; avoid bidder's bid suits and suits where bidder team is void
      const bidderTeamSeats = [0, 1, 2, 3].filter((s) => this.isOnBidderTeam(state, s));
      const safe = validCards.filter((c) => {
        const suit = c.split(' ')[1];
        if (suit === state.trumpSuit) return false;
        if (bidderBidSuits.has(suit) || partnerBidSuits.has(suit)) return false;
        return !bidderTeamSeats.some((s) => voids.get(s)?.has(suit as Suit));
      });
      if (safe.length > 0) return this.lowestCard(safe);
      // Fallback: at least avoid trump
      const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
      return this.lowestCard(nonTrump.length > 0 ? nonTrump : validCards);
    }
  }

  private leadLongestNonTrump(state: GameState, seat: number, validCards: string[]): string {
    const hand = state.hands[seat];
    // Only consider suits available in the provided pool (may be a filtered subset)
    const availableSuits = new Set(validCards.map((c) => c.split(' ')[1]));
    let bestSuit: Suit | null = null;
    let bestLen = 0;
    for (const suit of CARD_SUITS) {
      if (suit === state.trumpSuit) continue;
      if (!availableSuits.has(suit)) continue;
      if (hand[suit].length > bestLen) { bestLen = hand[suit].length; bestSuit = suit; }
    }
    if (bestSuit) {
      const cards = validCards.filter((c) => c.split(' ')[1] === bestSuit);
      if (cards.length > 0) {
        // Long suits (5+): lead high to drive out opponents' honours
        // Short suits: lead low (info lead, keeps options open)
        return bestLen >= 5 ? this.highestCard(cards) : this.lowestCard(cards);
      }
    }
    return this.lowestCard(validCards);
  }

  // --- Positional / memory helpers ---

  /** True if `card` is the highest unplayed card in its suit (a guaranteed winner). */
  private isBossCard(state: GameState, card: string): boolean {
    const [value, suit] = card.split(' ');
    const played = this.getAllPlayedCards(state);
    const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const myRank = RANKS.indexOf(value);
    for (let i = myRank + 1; i < RANKS.length; i++) {
      if (!played.has(`${RANKS[i]} ${suit}`)) return false; // a higher card is still out
    }
    return true;
  }

  /** All cards played across completed tricks and the current trick. */
  private getAllPlayedCards(state: GameState): Set<string> {
    const played = new Set<string>();
    for (const entry of state.trickLog) played.add(entry.card);
    for (const c of state.playedCards) { if (c !== null) played.add(c); }
    return played;
  }

  /**
   * Infer void suits per seat from the trick log.
   * When a player plays off the led suit, they are void in that suit.
   */
  private getVoids(state: GameState): Map<number, Set<Suit>> {
    const voids = new Map<number, Set<Suit>>();
    for (let i = 0; i < NUM_PLAYERS; i++) voids.set(i, new Set());
    const byTrick = new Map<number, TrickLogEntry[]>();
    for (const entry of state.trickLog) {
      if (!byTrick.has(entry.trickNum)) byTrick.set(entry.trickNum, []);
      byTrick.get(entry.trickNum)!.push(entry);
    }
    for (const entries of byTrick.values()) {
      const lead = entries.find((e) => e.playOrder === 1);
      if (!lead) continue;
      const ledSuit = lead.card.split(' ')[1] as Suit;
      for (const e of entries) {
        if (e.card.split(' ')[1] !== ledSuit) voids.get(e.seat)!.add(ledSuit);
      }
    }
    return voids;
  }

  /** Seats that still have to play AFTER `seat` in the current trick (in play order). */
  private getPlayersAfter(state: GameState, seat: number): number[] {
    const myPos = ((seat - state.firstPlayer) + NUM_PLAYERS) % NUM_PLAYERS;
    const after: number[] = [];
    for (let i = myPos + 1; i < NUM_PLAYERS; i++) {
      const s = (state.firstPlayer + i) % NUM_PLAYERS;
      if (state.playedCards[s] === null) after.push(s);
    }
    return after;
  }

  /** Suits bid by the partner (non-trump). */
  private getPartnerBidSuits(state: GameState): Set<string> {
    const suits = new Set<string>();
    for (const entry of state.bidHistory) {
      if (entry.bidNum === null || entry.seat !== state.partner) continue;
      const suit = getBidFromNum(entry.bidNum).split(' ')[1];
      if (suit !== '🚫') suits.add(suit);
    }
    return suits;
  }

  /** Suits bid by the bidder (non-trump). */
  private getBidderBidSuits(state: GameState): Set<string> {
    const suits = new Set<string>();
    for (const entry of state.bidHistory) {
      if (entry.bidNum === null || entry.seat !== state.bidder) continue;
      const suit = getBidFromNum(entry.bidNum).split(' ')[1];
      if (suit !== '🚫') suits.add(suit);
    }
    return suits;
  }

  private isOnBidderTeam(state: GameState, seat: number): boolean {
    return seat === state.bidder || seat === state.partner;
  }

  private isPartnerCardRevealed(state: GameState): boolean {
    if (!state.partnerCard || state.partner < 0) return false;
    const [value, suit] = state.partnerCard.split(' ');
    for (let s = 0; s < NUM_PLAYERS; s++) {
      if (state.hands[s][suit as import('./types').Suit]?.includes(value)) return false;
    }
    return true; // no longer in any hand → has been played
  }

  private getOrderedCardsPlayed(state: GameState): string[] {
    const result: string[] = [];
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const idx = (state.firstPlayer + i) % NUM_PLAYERS;
      if (state.playedCards[idx] !== null) result.push(state.playedCards[idx]!);
    }
    return result;
  }

  private getCurrentTrickWinnerSeat(state: GameState): number | null {
    if (!state.currentSuit) return null;
    const ordered: string[] = [];
    const seats: number[] = [];
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const idx = (state.firstPlayer + i) % NUM_PLAYERS;
      if (state.playedCards[idx] !== null) { ordered.push(state.playedCards[idx]!); seats.push(idx); }
    }
    if (ordered.length === 0) return null;
    return seats[compareCards(ordered, state.currentSuit, state.trumpSuit)];
  }

  private lowestCard(cards: string[]): string {
    return cards.reduce((best, card) => {
      const bestNum = getNumFromValue(best.split(' ')[0]);
      const cardNum = getNumFromValue(card.split(' ')[0]);
      return cardNum < bestNum ? card : best;
    });
  }

  private highestCard(cards: string[]): string {
    return cards.reduce((best, card) => {
      const bestNum = getNumFromValue(best.split(' ')[0]);
      const cardNum = getNumFromValue(card.split(' ')[0]);
      return cardNum > bestNum ? card : best;
    });
  }

  /** Discard the lowest card from the shortest non-trump side suit. */
  private smartDump(state: GameState, seat: number, validCards: string[]): string {
    const hand = state.hands[seat];
    const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
    const pool = nonTrump.length > 0 ? nonTrump : validCards;
    // Find the suit with fewest cards (to burn a suit we can't establish)
    let shortestSuit: string | null = null;
    let shortestLen = Infinity;
    for (const c of pool) {
      const suit = c.split(' ')[1] as import('./types').Suit;
      if (hand[suit].length < shortestLen) {
        shortestLen = hand[suit].length;
        shortestSuit = suit;
      }
    }
    const suitCards = shortestSuit ? pool.filter((c) => c.split(' ')[1] === shortestSuit) : pool;
    return this.lowestCard(suitCards.length > 0 ? suitCards : pool);
  }

  private getBotHandPoints(hand: import('./types').Hand): number {
    let points = 0;
    for (const suit of CARD_SUITS) {
      const values = hand[suit];
      for (const value of values) {
        if (value === 'A') points += 4;
        else if (value === 'K') points += 3;
        else if (value === 'Q') points += 2;
        else if (value === 'J') points += 1;
      }
      if (values.length >= 5) points += values.length - 4;
    }
    return points;
  }

  private getBotBid(state: GameState, seat: number): number | null {
    const hand = state.hands[seat];
    const points = this.getBotHandPoints(hand);

    // Determine desired bid level based on hand strength.
    // Modest hands (9-11) enter the auction at level 1 with moderate probability
    // to compete more often. Level 1 is preferred up to 15 pts (first-level bias).
    let desiredLevel: number;
    if (points < 9) return null;
    if (points < 12) {
      // Compete with ~60% probability on modest hands
      if (Math.random() > 0.6) return null;
      desiredLevel = 1;
    } else if (points < 16) {
      desiredLevel = 1; // first-level bias — widened from 12-14 to 12-15
    } else if (points < 19) {
      desiredLevel = 2;
    } else {
      desiredLevel = 3;
    }

    // Find best trump suit: longest suit, tiebreak by HCP in that suit
    let bestSuitIdx = 4; // default: no-trump (index 4 in BID_SUITS)
    let bestLen = 0;
    let bestHCP = 0;
    for (let si = 0; si < CARD_SUITS.length; si++) {
      const suit = CARD_SUITS[si];
      const values = hand[suit];
      const hcp = values.reduce((s, v) => s + (v === 'A' ? 4 : v === 'K' ? 3 : v === 'Q' ? 2 : v === 'J' ? 1 : 0), 0);
      if (values.length > bestLen || (values.length === bestLen && hcp > bestHCP)) {
        bestLen = values.length;
        bestHCP = hcp;
        bestSuitIdx = si; // CARD_SUITS and BID_SUITS share the same 0-3 suit indices
      }
    }
    // Short suits (≤3 cards) don't make reliable trump — prefer no-trump
    if (bestLen <= 3) bestSuitIdx = 4;

    // Try preferred suit, then higher suits at same level, up to no-trump
    for (let si = bestSuitIdx; si <= 4; si++) {
      const bidNum = (desiredLevel - 1) * 5 + si;
      if (bidNum > state.bid && bidNum <= MAX_BID) return bidNum;
    }

    // Nothing valid at desired level — pass rather than overbid
    return null;
  }

  private getBotPartnerCard(state: GameState, bidderSeat: number): string {
    // Pick the highest card the bidder doesn't hold
    // Suits tried highest-first: ♠ ♥ ♦ ♣
    const VALUES = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    for (const suit of ['♠', '♥', '♦', '♣'] as import('./types').Suit[]) {
      const held = new Set(state.hands[bidderSeat][suit]);
      for (const value of VALUES) {
        if (!held.has(value)) return `${value} ${suit}`;
      }
    }
    return 'A ♠';
  }

  // --- Advanced bot (builds on intermediate as base) ---
  // Differences: VH bidding formula, competitive step-up, partner-lead priority,
  // second-hand-low, forced called-card reveal, active ruffing, smartDump partner constraint.

  private getBotBidAdvanced(state: GameState, seat: number): number | null {
    const hand = state.hands[seat];

    // HCP (wash check: raw HCP < 4 → pass regardless of length)
    let hcp = 0;
    for (const suit of CARD_SUITS) {
      for (const v of hand[suit]) {
        hcp += v === 'A' ? 4 : v === 'K' ? 3 : v === 'Q' ? 2 : v === 'J' ? 1 : 0;
      }
    }
    if (hcp < 4) return null;

    // Length points: 5th card = +1, each beyond = +1
    let lengthPts = 0;
    for (const suit of CARD_SUITS) {
      if (hand[suit].length >= 5) lengthPts += hand[suit].length - 4;
    }

    // Best trump suit: longest, tiebreak by HCP in suit
    let bestSuitIdx = 4; // default NT
    let bestLen = 0;
    let bestSuitHCP = 0;
    for (let si = 0; si < CARD_SUITS.length; si++) {
      const suit = CARD_SUITS[si];
      const sHCP = hand[suit].reduce((s, v) => s + (v === 'A' ? 4 : v === 'K' ? 3 : v === 'Q' ? 2 : v === 'J' ? 1 : 0), 0);
      if (hand[suit].length > bestLen || (hand[suit].length === bestLen && sHCP > bestSuitHCP)) {
        bestLen = hand[suit].length;
        bestSuitHCP = sHCP;
        bestSuitIdx = si;
      }
    }

    // NT priority: balanced + stoppers in ≥3 suits + base HCP ≥ 15
    const balanced = CARD_SUITS.every((s) => hand[s].length <= 4);
    const stoppedSuits = CARD_SUITS.filter((s) => hand[s].includes('A') || hand[s].includes('K')).length;
    if (balanced && stoppedSuits >= 3 && hcp >= 15) {
      bestSuitIdx = 4;
    } else if (bestLen <= 3) {
      bestSuitIdx = 4; // no reliable trump suit
    }

    // Virtual honor: highest missing honor in trump suit
    let vh = 0;
    if (bestSuitIdx < 4) {
      const trumpSuit = CARD_SUITS[bestSuitIdx];
      const held = new Set(hand[trumpSuit]);
      if (!held.has('A')) vh = 4;
      else if (!held.has('K')) vh = 3;
      else if (!held.has('Q')) vh = 2;
    }

    const S = hcp + lengthPts + vh;

    // Max level from total strength S
    let myMaxLevel: number;
    if (S < 13) return null; // pass
    else if (S < 20) myMaxLevel = 1;
    else if (S < 24) myMaxLevel = 2;
    else myMaxLevel = 3;

    // Competitive suit adjustment: modify willingness to bid (myMaxLevel ± 1) based on how
    // our hand relates to the current bid suit. Only applies when there is a bid to overcall.
    //   Current bid == our best suit → opponent bid our strain; reduce aggression (-1 level)
    //   Current bid is our weak suit → fight harder for a better contract (+1 level per tier)
    if (state.bid >= 0) {
      const currentBidSuitIdx = state.bid % 5;
      if (currentBidSuitIdx < 4) { // NT bids have no suit to compare
        const currentBidSuit = CARD_SUITS[currentBidSuitIdx];
        const holding = hand[currentBidSuit].length;
        if (currentBidSuitIdx === bestSuitIdx) {
          myMaxLevel = Math.max(0, myMaxLevel - 1); // opponent bid our best strain — trap-pass
        } else if (holding === 0) {
          myMaxLevel = Math.min(3, myMaxLevel + 2); // void in their suit — fight very hard
        } else if (holding <= 3) {
          myMaxLevel = Math.min(3, myMaxLevel + 1); // short holding — willing to stretch one level
        }
        // 4+ cards and not our best suit → neutral (no adjustment)
      }
    }

    // Competitive step-up: find minimum level needed to overcall
    let proposedLevel: number;
    if (state.bid < 0) {
      proposedLevel = 1; // opening bid — minimum level 1
    } else {
      const currentBidLevel = Math.floor(state.bid / 5) + 1;
      const currentSuitIdx = state.bid % 5;
      // Higher suit index = higher bid rank (♣=0 < ♦=1 < ♥=2 < ♠=3 < NT=4)
      proposedLevel = bestSuitIdx > currentSuitIdx ? currentBidLevel : currentBidLevel + 1;
    }

    if (proposedLevel > myMaxLevel || proposedLevel > 3) return null; // pass

    const bidNum = (proposedLevel - 1) * 5 + bestSuitIdx;
    if (bidNum > state.bid && bidNum <= MAX_BID) return bidNum;
    return null;
  }

  private getBotCardAdvanced(state: GameState, seat: number): string {
    const hand = state.hands[seat];
    const validSuits = getValidSuits(hand, state.trumpSuit, state.currentSuit, state.trumpBroken);
    if (validSuits.length === 0) return '';

    const validCards: string[] = [];
    for (const suit of validSuits) {
      for (const value of hand[suit]) {
        validCards.push(`${value} ${suit}`);
      }
    }
    if (validCards.length === 0) return '';

    const trickInProgress = !state.trickComplete && state.playedCards.some((c) => c !== null);
    const onBidderTeam = this.isOnBidderTeam(state, seat);
    const confidence = this.isPartnerCardRevealed(state) ? 0.85 : 0.65;
    const useTeamLogic = state.partner >= 0 && Math.random() < confidence;

    if (!trickInProgress) {
      return useTeamLogic
        ? this.getBotLeadCardAdvanced(state, seat, validCards, onBidderTeam)
        : this.lowestCard(validCards);
    }

    if (useTeamLogic) {
      return onBidderTeam
        ? this.getBotCardAsBidderTeamAdvanced(state, seat, validCards)
        : this.getBotCardAsOppositionAdvanced(state, seat, validCards);
    }

    // Basic fallback
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winningCards = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    return winningCards.length > 0 ? this.lowestCard(winningCards) : this.smartDumpAdvanced(state, seat, validCards);
  }

  private getBotLeadCardAdvanced(
    state: GameState,
    seat: number,
    validCards: string[],
    onBidderTeam: boolean,
  ): string {
    const partnerBidSuits = this.getPartnerBidSuits(state);
    const bidderBidSuits = this.getBidderBidSuits(state);
    const voids = this.getVoids(state);
    const calledSuit = this.getCalledSuit(state);

    if (onBidderTeam) {
      // Partner leading: priority 1 = lead low in called suit; priority 2 = bidder's bid suit
      if (seat === state.partner && calledSuit) {
        const calledSuitCards = validCards.filter((c) => c.split(' ')[1] === calledSuit);
        if (calledSuitCards.length > 0) return this.lowestCard(calledSuitCards);
        const bidderSuitCards = validCards.filter(
          (c) => bidderBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
        );
        if (bidderSuitCards.length > 0) return this.highestCard(bidderSuitCards);
      }

      // Prefer leading a suit the partner bid (established length signal)
      const partnerSuitCards = validCards.filter(
        (c) => partnerBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
      );
      if (partnerSuitCards.length > 0) return this.highestCard(partnerSuitCards);

      // Bidder void in a side suit: 50% force trump lead (draw out opponent trumps)
      if (seat === state.bidder && state.trumpSuit && state.trumpSuit !== '🚫') {
        const hasVoidInSideSuit = CARD_SUITS.some(
          (s) => s !== state.trumpSuit && state.hands[seat][s].length === 0,
        );
        if (hasVoidInSideSuit && Math.random() < 0.5) {
          const trumpCards = validCards.filter((c) => c.split(' ')[1] === state.trumpSuit);
          if (trumpCards.length > 0) return this.highestCard(trumpCards);
        }
      }

      // Avoid suits where an opponent is void (would ruff)
      const oppSeats = [0, 1, 2, 3].filter((s) => s !== seat && !this.isOnBidderTeam(state, s));
      const nonRuffable = validCards.filter((c) => {
        const suit = c.split(' ')[1] as Suit;
        if (suit === state.trumpSuit) return false;
        return !oppSeats.some((s) => voids.get(s)?.has(suit));
      });
      return this.leadLongestNonTrump(state, seat, nonRuffable.length > 0 ? nonRuffable : validCards);
    } else {
      // Opposition: K or Q in called suit → 70% lead high (reveal test), 30% normal
      if (calledSuit) {
        const calledSuitCards = validCards.filter((c) => c.split(' ')[1] === calledSuit);
        const hasRevealHonor = calledSuitCards.some((c) => ['K', 'Q'].includes(c.split(' ')[0]));
        if (hasRevealHonor && Math.random() < 0.7) {
          return this.highestCard(calledSuitCards);
        }
      }

      // Avoid bidder/partner bid suits and ruffable suits
      const bidderTeamSeats = [0, 1, 2, 3].filter((s) => this.isOnBidderTeam(state, s));
      const safe = validCards.filter((c) => {
        const suit = c.split(' ')[1];
        if (suit === state.trumpSuit) return false;
        if (bidderBidSuits.has(suit) || partnerBidSuits.has(suit)) return false;
        return !bidderTeamSeats.some((s) => voids.get(s)?.has(suit as Suit));
      });
      if (safe.length > 0) return this.lowestCard(safe);
      const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
      return this.lowestCard(nonTrump.length > 0 ? nonTrump : validCards);
    }
  }

  private getBotCardAsBidderTeamAdvanced(state: GameState, seat: number, validCards: string[]): string {
    const hand = state.hands[seat];
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);
    const afterUs = this.getPlayersAfter(state, seat);
    const calledSuit = this.getCalledSuit(state);

    // §4.2 Partner reveal: forced play of called card when opp winning + void risk low
    if (seat === state.partner && state.partnerCard && state.currentSuit && calledSuit) {
      const holdsCalledCard = validCards.includes(state.partnerCard);
      const bidderLedCalledSuit = state.currentSuit === calledSuit;
      const oppWinning = currentWinnerSeat !== null && !this.isOnBidderTeam(state, currentWinnerSeat);
      const fewInSuit = hand[calledSuit].length < 4;
      if (holdsCalledCard && bidderLedCalledSuit && oppWinning && fewInSuit) {
        return state.partnerCard;
      }
    }

    // Teammate already winning — don't steal the trick
    if (currentWinnerSeat !== null && this.isOnBidderTeam(state, currentWinnerSeat)) {
      return this.smartDumpAdvanced(state, seat, validCards);
    }

    // §4.1 Second-hand-low: playing 2nd, teammate still to play, holding K/Q/J → 70% play low
    if (orderedSoFar.length === 1 && afterUs.some((s) => this.isOnBidderTeam(state, s))) {
      const hasHonor = validCards.some((c) => ['K', 'Q', 'J'].includes(c.split(' ')[0]));
      if (hasHonor && Math.random() < 0.7) {
        const nonHonors = validCards.filter((c) => !['A', 'K', 'Q', 'J'].includes(c.split(' ')[0]));
        return nonHonors.length > 0 ? this.lowestCard(nonHonors) : this.lowestCard(validCards);
      }
    }

    // Boss card that would actually win this trick
    const bossCard = validCards.find((c) => {
      if (!this.isBossCard(state, c)) return false;
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (bossCard) return bossCard;

    // §4.3 Void management (partner): ruff if opp winning and trump wins
    const isVoidInLedSuit = !!(state.currentSuit && hand[state.currentSuit as import('./types').Suit]?.length === 0);
    const oppWinningNow = currentWinnerSeat !== null && !this.isOnBidderTeam(state, currentWinnerSeat);
    if (isVoidInLedSuit && oppWinningNow && state.trumpSuit && state.trumpSuit !== '🚫') {
      const trumpCards = validCards.filter((c) => c.split(' ')[1] === state.trumpSuit);
      const winningTrump = trumpCards.filter((c) => {
        const test = [...orderedSoFar, c];
        return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
      });
      if (winningTrump.length > 0) return this.lowestCard(winningTrump);
    }

    const partnerBidSuits = this.getPartnerBidSuits(state);
    const teammateIsLast = afterUs.length > 0 && this.isOnBidderTeam(state, afterUs[afterUs.length - 1]);

    if (teammateIsLast) {
      const ledSuitIsPartnerStrength = state.currentSuit && partnerBidSuits.has(state.currentSuit);
      if (!ledSuitIsPartnerStrength) return this.smartDumpAdvanced(state, seat, validCards);
    }

    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (winning.length === 0) return this.smartDumpAdvanced(state, seat, validCards);

    const opponentAfter = afterUs.some((s) => !this.isOnBidderTeam(state, s));
    return opponentAfter ? this.highestCard(winning) : this.lowestCard(winning);
  }

  private getBotCardAsOppositionAdvanced(state: GameState, seat: number, validCards: string[]): string {
    const hand = state.hands[seat];
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);
    const afterUs = this.getPlayersAfter(state, seat);

    // Opposition teammate already winning — don't steal
    if (currentWinnerSeat !== null && !this.isOnBidderTeam(state, currentWinnerSeat)) {
      return this.smartDumpAdvanced(state, seat, validCards);
    }

    // §4.1 Second-hand-low: playing 2nd, opp teammate still to play, holding K/Q/J → 70% play low
    if (orderedSoFar.length === 1 && afterUs.some((s) => !this.isOnBidderTeam(state, s))) {
      const hasHonor = validCards.some((c) => ['K', 'Q', 'J'].includes(c.split(' ')[0]));
      if (hasHonor && Math.random() < 0.7) {
        const nonHonors = validCards.filter((c) => !['A', 'K', 'Q', 'J'].includes(c.split(' ')[0]));
        return nonHonors.length > 0 ? this.lowestCard(nonHonors) : this.lowestCard(validCards);
      }
    }

    // Boss card that would actually win this trick
    const bossCard = validCards.find((c) => {
      if (!this.isBossCard(state, c)) return false;
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (bossCard) return bossCard;

    // §4.3 Void management (opposition)
    const isVoidInLedSuit = !!(state.currentSuit && hand[state.currentSuit as import('./types').Suit]?.length === 0);
    if (isVoidInLedSuit && state.trumpSuit && state.trumpSuit !== '🚫') {
      // Opp teammate winning with trump → no-stack rule: smartDump
      const currentWinnerCard = currentWinnerSeat !== null ? state.playedCards[currentWinnerSeat] : null;
      const teammateWinningWithTrump =
        currentWinnerSeat !== null &&
        !this.isOnBidderTeam(state, currentWinnerSeat) &&
        currentWinnerCard?.split(' ')[1] === state.trumpSuit;
      if (teammateWinningWithTrump) return this.smartDumpAdvanced(state, seat, validCards);

      // Bidder team winning → ruff if possible
      const bidderTeamWinning = currentWinnerSeat !== null && this.isOnBidderTeam(state, currentWinnerSeat);
      if (bidderTeamWinning) {
        const trumpCards = validCards.filter((c) => c.split(' ')[1] === state.trumpSuit);
        const winningTrump = trumpCards.filter((c) => {
          const test = [...orderedSoFar, c];
          return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
        });
        if (winningTrump.length > 0) return this.lowestCard(winningTrump);
      }
    }

    const bidderBidSuits = this.getBidderBidSuits(state);
    const oppTeammateIsLast = afterUs.length > 0 && !this.isOnBidderTeam(state, afterUs[afterUs.length - 1]);

    if (oppTeammateIsLast) {
      const ledSuitIsBidderStrength = state.currentSuit && bidderBidSuits.has(state.currentSuit);
      if (!ledSuitIsBidderStrength) return this.smartDumpAdvanced(state, seat, validCards);
    }

    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (winning.length === 0) return this.smartDumpAdvanced(state, seat, validCards);

    const bidderTeamAfter = afterUs.some((s) => this.isOnBidderTeam(state, s));
    return bidderTeamAfter ? this.highestCard(winning) : this.lowestCard(winning);
  }

  /**
   * Advanced smartDump — discard priority (lowest cost first):
   *   1. non-trump non-honors  (dump these first)
   *   2. non-trump honors      (only if no option 1 remains)
   *   3. trump                 (last resort)
   * Partner constraint: never discard the called card unless it is the only card.
   */
  private smartDumpAdvanced(state: GameState, seat: number, validCards: string[]): string {
    let pool = validCards;
    // Partner: never dump the called card unless it is the only card left
    if (seat === state.partner && state.partnerCard && pool.length > 1) {
      const filtered = pool.filter((c) => c !== state.partnerCard);
      if (filtered.length > 0) pool = filtered;
    }
    // Tier 1: non-trump non-honors
    const tier1 = pool.filter(
      (c) => c.split(' ')[1] !== state.trumpSuit && !['A', 'K', 'Q', 'J'].includes(c.split(' ')[0]),
    );
    if (tier1.length > 0) return this.smartDump(state, seat, tier1);
    // Tier 2: non-trump (honors included)
    const tier2 = pool.filter((c) => c.split(' ')[1] !== state.trumpSuit);
    if (tier2.length > 0) return this.smartDump(state, seat, tier2);
    // Tier 3: trump only — no choice
    return this.smartDump(state, seat, pool);
  }

  /** Returns the suit of the called partner card, or null if not set. */
  private getCalledSuit(state: GameState): Suit | null {
    if (!state.partnerCard) return null;
    return state.partnerCard.split(' ')[1] as Suit;
  }

  // --- Sophisticated bot (builds on advanced, adds PPM-based probabilistic inference) ---
  // Pre-reveal: uses Partner Probability Matrix to identify assumed teammate without using state.partner.
  // Post-reveal: retains sophisticated behaviours (High-Low Peter, unblocking, coordination)
  //              and delegates base logic to advanced methods.

  /**
   * Determine the bot's role without using state.partner (pre-reveal safe).
   * Post-reveal falls back to state.partner for the partner seat.
   */
  private getBotSophisticatedRole(state: GameState, seat: number): 'bidder' | 'partner' | 'opposition' {
    if (seat === state.bidder) return 'bidder';
    if (this.isPartnerCardRevealed(state) && seat === state.partner) return 'partner';
    if (!this.isPartnerCardRevealed(state) && state.partnerCard) {
      const [val, suit] = state.partnerCard.split(' ');
      if (state.hands[seat][suit as Suit]?.includes(val)) return 'partner';
    }
    return 'opposition';
  }

  /**
   * Compute the Partner Probability Matrix for all other seats relative to `seat`.
   * Scores are raw (not normalised). Higher = more likely to be the assumed teammate.
   */
  private computePPM(state: GameState, seat: number): Map<number, number> {
    const others = [0, 1, 2, 3].filter((s) => s !== seat);
    const ppm = new Map<number, number>();
    const role = this.getBotSophisticatedRole(state, seat);

    // Initial priors
    for (const s of others) {
      if (role === 'bidder') ppm.set(s, 33);                                    // equal prior
      else if (role === 'partner') ppm.set(s, s === state.bidder ? 100 : 0);    // partner knows bidder
      else ppm.set(s, s === state.bidder ? 0 : 50);                             // opp: 50/50 for non-bidders
    }

    const calledCard = state.partnerCard;
    const calledSuit = this.getCalledSuit(state);
    const bidderBidSuits = this.getBidderBidSuits(state);

    // Bidding swing: non-bidder who bid → competed against bidder → -25 (unlikely partner)
    for (const entry of state.bidHistory) {
      if (!others.includes(entry.seat) || entry.seat === state.bidder) continue;
      if (entry.bidNum !== null) {
        ppm.set(entry.seat, Math.max(0, (ppm.get(entry.seat) ?? 0) - 25));
      }
    }

    // Trick log swings
    const trickMap = new Map<number, TrickLogEntry[]>();
    for (const entry of state.trickLog) {
      if (!trickMap.has(entry.trickNum)) trickMap.set(entry.trickNum, []);
      trickMap.get(entry.trickNum)!.push(entry);
    }

    for (const [trickNum, entries] of trickMap) {
      const lead = entries.find((e) => e.playOrder === 1);
      const ledSuit = lead?.card.split(' ')[1];
      const winner = state.trickWinners[trickNum - 1] ?? -1;
      const bidderEntry = entries.find((e) => e.seat === state.bidder);
      const bidderPlayedHonor = bidderEntry && ['A', 'K'].includes(bidderEntry.card.split(' ')[0]);

      for (const entry of entries) {
        if (!others.includes(entry.seat)) continue;
        const [val, suit] = entry.card.split(' ');
        let curr = ppm.get(entry.seat) ?? 0;

        // Called card played → absolute reveal (+100, zero all others)
        if (calledCard && entry.card === calledCard) {
          ppm.set(entry.seat, 100);
          for (const o of others) if (o !== entry.seat) ppm.set(o, 0);
          continue;
        }

        // Opening lead signals
        if (entry.playOrder === 1) {
          if (bidderBidSuits.has(suit)) curr = Math.min(100, curr + 30);                              // leads bidder suit → partner signal
          if (suit === calledSuit && ['K', 'Q', 'J'].includes(val)) curr = Math.max(0, curr - 25);   // interrogation lead → opp signal
        }
        // Second-hand-low (non-honor when playing 2nd) → cooperative → +10
        if (entry.playOrder === 2 && !['A', 'K', 'Q', 'J'].includes(val)) curr = Math.min(100, curr + 10);
        // High discard (off-suit honor) → strength signal to partner → +15
        if (ledSuit && suit !== ledSuit && ['J', 'Q', 'K', 'A'].includes(val)) curr = Math.min(100, curr + 15);

        // Savior / Friendly Fire based on trick winner
        if (entry.seat === winner && winner !== state.bidder) {
          if (bidderPlayedHonor) curr = Math.max(0, curr - 40); // beat bidder's honor → friendly fire
          else curr = Math.min(100, curr + 25);                  // won when bidder didn't dominate → savior
        }

        ppm.set(entry.seat, curr);
      }
    }

    // Current in-progress trick partial signals
    for (const s of others) {
      const card = state.playedCards[s];
      if (!card) continue;
      const [val, suit] = card.split(' ');
      let curr = ppm.get(s) ?? 0;
      if (calledCard && card === calledCard) {
        ppm.set(s, 100);
        for (const o of others) if (o !== s) ppm.set(o, 0);
        continue;
      }
      if (state.currentSuit && suit !== state.currentSuit && ['J', 'Q', 'K', 'A'].includes(val)) {
        curr = Math.min(100, curr + 15); // high discard in current trick
      }
      ppm.set(s, curr);
    }

    return ppm;
  }

  /** Argmax of PPM — the seat most likely to be the bot's teammate. Post-reveal returns actual partner. */
  private getAssumedTeammate(state: GameState, seat: number, ppm: Map<number, number>): number {
    if (this.isPartnerCardRevealed(state)) return state.partner;
    let best = -1;
    let bestScore = -Infinity;
    for (const [s, score] of ppm) {
      if (s !== seat && score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /**
   * Reveal Urgency Score (0–100) for the partner bot.
   * High RUS → reveal the called card (come out of hiding).
   */
  private computeRUS(state: GameState, seat: number): number {
    let rus = 0;
    const calledSuit = this.getCalledSuit(state);
    const hand = state.hands[seat];

    // Bidder's current-trick card is in the called suit → bidder is probing
    const bidderCurrentCard = state.playedCards[state.bidder];
    if (bidderCurrentCard && calledSuit && bidderCurrentCard.split(' ')[1] === calledSuit) rus += 30;

    // Bidder lost the last 2 tricks → needs help
    const last2 = state.trickWinners.slice(-2);
    if (last2.length >= 2 && last2.every((w) => w !== state.bidder)) rus += 20;

    // Partner is void in led suit and can ruff → high-value reveal opportunity
    if (state.currentSuit && state.trumpSuit && state.trumpSuit !== '🚫') {
      const isVoid = (hand[state.currentSuit as Suit]?.length ?? 0) === 0;
      const hasTrump = (hand[state.trumpSuit as Suit]?.length ?? 0) > 0;
      if (isVoid && hasTrump) rus += 50;
    }

    return rus;
  }

  /**
   * Detect High-Low Peter signals from the trick log.
   * Returns a map of seat → set of suits in which that seat played high-then-low (peter signal).
   */
  private detectHighLowPeter(state: GameState): Map<number, Set<Suit>> {
    const peters = new Map<number, Set<Suit>>();
    for (let s = 0; s < NUM_PLAYERS; s++) peters.set(s, new Set());

    // Chronological plays per seat per suit
    const sorted = [...state.trickLog].sort((a, b) =>
      a.trickNum !== b.trickNum ? a.trickNum - b.trickNum : a.playOrder - b.playOrder,
    );
    const seatSuitPlays = new Map<number, Map<string, string[]>>();
    for (let s = 0; s < NUM_PLAYERS; s++) seatSuitPlays.set(s, new Map());
    for (const entry of sorted) {
      const [val, suit] = entry.card.split(' ');
      const m = seatSuitPlays.get(entry.seat)!;
      if (!m.has(suit)) m.set(suit, []);
      m.get(suit)!.push(val);
    }

    for (const [s, suitMap] of seatSuitPlays) {
      for (const [suit, vals] of suitMap) {
        if (vals.length >= 2) {
          const r1 = getNumFromValue(vals[0]);
          const r2 = getNumFromValue(vals[1]);
          // High (≥6) then low → peter signal
          if (r1 > r2 && r1 >= getNumFromValue('6')) {
            peters.get(s)!.add(suit as Suit);
          }
        }
      }
    }
    return peters;
  }

  /**
   * Try to send a High-Low Peter signal when leading.
   * First play in a suit with 3+ cards: lead second-lowest (high) so next play can be lowest (low).
   * Returns the chosen card or null if no suitable suit found.
   */
  private tryHighLowPeter(state: GameState, seat: number, validCards: string[]): string | null {
    const hand = state.hands[seat];
    const alreadyPlayedSuits = new Set(
      state.trickLog.filter((e) => e.seat === seat).map((e) => e.card.split(' ')[1]),
    );
    for (const suit of CARD_SUITS) {
      if (suit === state.trumpSuit) continue;
      if (alreadyPlayedSuits.has(suit)) continue; // already played → too late to start a peter
      if (hand[suit].length < 3) continue;
      const suitCards = validCards.filter((c) => c.split(' ')[1] === suit);
      if (suitCards.length < 2) continue;
      const sorted = [...suitCards].sort(
        (a, b) => getNumFromValue(a.split(' ')[0]) - getNumFromValue(b.split(' ')[0]),
      );
      return sorted[1]; // second-lowest = the "high" card of the peter
    }
    return null;
  }

  // --- Sophisticated entry point ---

  private getBotCardSophisticated(state: GameState, seat: number): string {
    const hand = state.hands[seat];
    const validSuits = getValidSuits(hand, state.trumpSuit, state.currentSuit, state.trumpBroken);
    if (validSuits.length === 0) return '';
    const validCards: string[] = [];
    for (const suit of validSuits) for (const value of hand[suit]) validCards.push(`${value} ${suit}`);
    if (validCards.length === 0) return '';

    const trickInProgress = !state.trickComplete && state.playedCards.some((c) => c !== null);
    const confidence = this.isPartnerCardRevealed(state) ? 0.85 : 0.65;
    const useTeamLogic = state.partner >= 0 && Math.random() < confidence;
    const ppm = this.computePPM(state, seat);
    const role = this.getBotSophisticatedRole(state, seat);

    if (!trickInProgress) {
      return useTeamLogic
        ? this.getBotLeadCardSophisticated(state, seat, validCards, ppm, role)
        : this.lowestCard(validCards);
    }
    if (useTeamLogic) {
      return this.getBotFollowCardSophisticated(state, seat, validCards, ppm, role);
    }
    // Basic fallback
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winning = validCards.filter((c) => {
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    return winning.length > 0 ? this.lowestCard(winning) : this.smartDumpAdvanced(state, seat, validCards);
  }

  private getBotLeadCardSophisticated(
    state: GameState,
    seat: number,
    validCards: string[],
    ppm: Map<number, number>,
    role: 'bidder' | 'partner' | 'opposition',
  ): string {
    const revealed = this.isPartnerCardRevealed(state);
    const calledSuit = this.getCalledSuit(state);
    const trickNum = state.trickWinners.length + 1; // 1-based current trick

    if (role === 'bidder') {
      // Probing (tricks 1–3, pre-reveal): lead low in called suit to flush partner, else low trump
      if (!revealed && trickNum <= 3) {
        if (calledSuit) {
          const calledCards = validCards.filter((c) => c.split(' ')[1] === calledSuit);
          if (calledCards.length > 0) return this.lowestCard(calledCards);
        }
        if (state.trumpSuit && state.trumpSuit !== '🚫') {
          const trumpCards = validCards.filter((c) => c.split(' ')[1] === state.trumpSuit);
          if (trumpCards.length > 0) return this.lowestCard(trumpCards);
        }
      }
      // Commitment: feed lead to assumed/actual teammate if PPM > 45%
      const target = this.getAssumedTeammate(state, seat, ppm);
      const targetScore = revealed ? 100 : (ppm.get(target) ?? 0);
      if (target >= 0 && targetScore > 45) {
        const targetBidSuits = new Set<string>();
        for (const entry of state.bidHistory) {
          if (entry.seat === target && entry.bidNum !== null) {
            const s = getBidFromNum(entry.bidNum).split(' ')[1];
            if (s !== '🚫') targetBidSuits.add(s);
          }
        }
        const feedCards = validCards.filter(
          (c) => targetBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
        );
        if (feedCards.length > 0) return this.lowestCard(feedCards); // low → gives teammate the lead
      }
      return this.getBotLeadCardAdvanced(state, seat, validCards, true);
    }

    if (role === 'partner') {
      // High-Low Peter (both pre and post reveal): signal length to bidder
      if (Math.random() < 0.3) {
        const peter = this.tryHighLowPeter(state, seat, validCards);
        if (peter) return peter;
      }
      // Pre-reveal stealth: if RUS < 70, avoid leading called suit (hide identity)
      if (!revealed && calledSuit) {
        if (this.computeRUS(state, seat) < 70) {
          const nonCalled = validCards.filter((c) => c.split(' ')[1] !== calledSuit);
          if (nonCalled.length > 0) return this.getBotLeadCardAdvanced(state, seat, nonCalled, true);
        }
      }
      return this.getBotLeadCardAdvanced(state, seat, validCards, true);
    }

    // Opposition
    // Mimicry (pre-reveal, 15%): fake partner signal to mislead bidder
    if (!revealed && Math.random() < 0.15) {
      const bidderBidSuits = this.getBidderBidSuits(state);
      const fakeCards = validCards.filter(
        (c) => bidderBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
      );
      if (fakeCards.length > 0) return this.highestCard(fakeCards);
    }
    // Interrogation (pre-reveal): lead high in called suit to force partner to reveal
    if (!revealed && calledSuit) {
      const calledCards = validCards.filter((c) => c.split(' ')[1] === calledSuit);
      if (calledCards.some((c) => ['K', 'Q', 'J'].includes(c.split(' ')[0]))) {
        return this.highestCard(calledCards);
      }
    }
    // Shortening bidder: lead suits where bidder is known void (forces trump expenditure)
    const voids = this.getVoids(state);
    const bidderVoids = voids.get(state.bidder) ?? new Set<Suit>();
    const shorteningCards = validCards.filter(
      (c) => (c.split(' ')[1] as Suit) !== state.trumpSuit && bidderVoids.has(c.split(' ')[1] as Suit),
    );
    if (shorteningCards.length > 0) return this.lowestCard(shorteningCards);
    // Post-reveal: lead through strength (lead bidder's suit → forces them to play before partner)
    if (revealed) {
      const bidderBidSuits = this.getBidderBidSuits(state);
      const throughStrength = validCards.filter(
        (c) => bidderBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
      );
      if (throughStrength.length > 0) return this.lowestCard(throughStrength);
    }
    return this.getBotLeadCardAdvanced(state, seat, validCards, false);
  }

  private getBotFollowCardSophisticated(
    state: GameState,
    seat: number,
    validCards: string[],
    ppm: Map<number, number>,
    role: 'bidder' | 'partner' | 'opposition',
  ): string {
    const revealed = this.isPartnerCardRevealed(state);
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);
    const afterUs = this.getPlayersAfter(state, seat);
    const assumedTeammate = this.getAssumedTeammate(state, seat, ppm);

    // Sophisticated partner behaviours apply both pre and post reveal
    if (role === 'partner') {
      // Unblocking: bidder leads K → partner plays Q to clear the suit
      if (state.currentSuit && state.firstPlayer === state.bidder) {
        const bidderCard = state.playedCards[state.bidder];
        if (bidderCard?.split(' ')[0] === 'K' && bidderCard.split(' ')[1] === state.currentSuit) {
          const queenCard = `Q ${state.currentSuit}`;
          if (validCards.includes(queenCard)) return queenCard;
        }
      }
      // Human Shield: random chance to sacrifice a mid-range card (6–J)
      if (Math.random() < 0.25) {
        const midRange = validCards.filter((c) => {
          const r = getNumFromValue(c.split(' ')[0]);
          return r >= getNumFromValue('6') && r <= getNumFromValue('J');
        });
        if (midRange.length > 0) return midRange[Math.floor(Math.random() * midRange.length)];
      }
    }

    // Post-reveal: delegate to advanced (uses full team knowledge)
    if (revealed) {
      return this.isOnBidderTeam(state, seat)
        ? this.getBotCardAsBidderTeamAdvanced(state, seat, validCards)
        : this.getBotCardAsOppositionAdvanced(state, seat, validCards);
    }

    // Pre-reveal: PPM-based follow (no state.partner access)

    // Partner: bidder winning → don't steal
    if (role === 'partner' && currentWinnerSeat === state.bidder) {
      return this.smartDumpAdvanced(state, seat, validCards);
    }

    // Assumed teammate winning → don't steal
    if (currentWinnerSeat !== null && currentWinnerSeat === assumedTeammate) {
      return this.smartDumpAdvanced(state, seat, validCards);
    }

    // Boss card that would actually win
    const bossCard = validCards.find((c) => {
      if (!this.isBossCard(state, c)) return false;
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (bossCard) return bossCard;

    // Void management (pre-reveal simplified)
    const hand = state.hands[seat];
    const isVoid = !!(state.currentSuit && (hand[state.currentSuit as Suit]?.length ?? 0) === 0);
    if (isVoid && state.trumpSuit && state.trumpSuit !== '🚫') {
      const currentWinnerCard = currentWinnerSeat !== null ? state.playedCards[currentWinnerSeat] : null;
      const teammateWinningWithTrump =
        currentWinnerSeat === assumedTeammate && currentWinnerCard?.split(' ')[1] === state.trumpSuit;
      if (!teammateWinningWithTrump) {
        const trumpCards = validCards.filter((c) => c.split(' ')[1] === state.trumpSuit);
        const winningTrump = trumpCards.filter((c) => {
          const test = [...orderedSoFar, c];
          return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
        });
        if (winningTrump.length > 0) return this.lowestCard(winningTrump);
      }
    }

    // Try to win; position-aware
    const winning = validCards.filter((c) => {
      const test = [...orderedSoFar, c];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (winning.length === 0) return this.smartDumpAdvanced(state, seat, validCards);

    const assumedEnemies = [0, 1, 2, 3].filter((s) => s !== seat && s !== assumedTeammate);
    const enemyAfter = afterUs.some((s) => assumedEnemies.includes(s));
    return enemyAfter ? this.highestCard(winning) : this.lowestCard(winning);
  }

  private shufflePlayerSeats(state: GameState): void {
    const players = state.players;
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    players.forEach((p, i) => { p.seat = i; });
  }

  private async startGameFromLobby(state: GameState): Promise<void> {
    // Capture who was first bidder before seats are reshuffled
    const prevFirstBidderPlayer = state.players.find((p) => p.seat === state.firstBidder);

    this.shufflePlayerSeats(state);

    // Find their new seat after shuffle (so the same player doesn't go first twice)
    const prevFirstBidderNewSeat = prevFirstBidderPlayer
      ? (state.players.find((p) => p.id === prevFirstBidderPlayer.id)?.seat ?? -1)
      : -1;

    const otherSeats = [0, 1, 2, 3].filter((s) => s !== prevFirstBidderNewSeat);
    const nextFirstBidder = otherSeats[Math.floor(Math.random() * otherSeats.length)];
    state.firstBidder = nextFirstBidder;

    state.gameStartAt = null;
    state.gameId = crypto.randomUUID();
    state.phase = 'bidding';
    state.hands = generateHands();
    state.turn = state.firstBidder;
    state.bidder = -1;
    state.bid = -1;
    state.passCount = 0;
    state.trumpSuit = null;
    state.setsNeeded = -1;
    state.sets = [0, 0, 0, 0];
    state.trumpBroken = false;
    state.firstPlayer = 0;
    state.currentSuit = null;
    state.playedCards = [null, null, null, null];
    state.partner = -1;
    state.partnerCard = null;
    state.partnerRevealed = false;
    state.lastTrick = null;
    state.trickComplete = false;
    state.bidHistory = [];
    state.trickLog = [];
    state.trickWinners = [];
    state.initialHands = state.hands.map((h) => ({
      '♣': [...h['♣']],
      '♦': [...h['♦']],
      '♥': [...h['♥']],
      '♠': [...h['♠']],
    }));
    await this.saveState(state);
    this.ctx.waitUntil(
      insertGameHands((this.env as Env).DB, state.gameId, state.players, state.hands)
        .catch(() => {}),
    );
    this.broadcast({ type: 'gameStart', turn: state.firstBidder });
    this.broadcastFullState(state);
    if (state.groupId) {
      const names = state.players.map((p) => p.name).join(', ');
      const isPracticeStart = state.players.filter((p) => p.isBot).length >= 2;
      sendMessage(
        (this.env as Env).TELEGRAM_BOT_TOKEN,
        state.groupId,
        `🎮 Game started!\nPlayers: ${names}${isPracticeStart ? '\n(practice — unrated)' : ''}`,
      ).catch(() => {});
    }
    this.ctx.waitUntil(this.scheduleBotAction());
  }

  private async handleAddBot(state: GameState, playerId: string, level: 'basic' | 'intermediate' | 'advanced' | 'sophisticated' = 'intermediate'): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === playerId);
    if (!requestor || requestor.seat !== 0) return;
    if (state.players.length >= NUM_PLAYERS) return;

    const botSeat = state.players.length;
    const BOT_NAME_POOL = [
      'Ace', 'Bluff', 'Clover', 'Dealer', 'Echo',
      'Finesse', 'Goblin', 'Hoyle', 'Ivory', 'Jinx',
      'Knave', 'Lucky', 'Midas', 'Nova', 'Oracle',
      'Pepper', 'Quill', 'Rogue', 'Spade', 'Thorn',
    ];
    const prefix = level === 'sophisticated' ? '[S] ' : level === 'advanced' ? '[A] ' : level === 'basic' ? '[B] ' : '[I] ';
    const usedNames = new Set(state.players.map((p) => p.name));
    // Strip prefix when checking availability so all levels share the same name pool
    const available = BOT_NAME_POOL.filter((n) =>
      !usedNames.has(`[B] ${n}`) && !usedNames.has(`[I] ${n}`) && !usedNames.has(`[A] ${n}`) && !usedNames.has(`[S] ${n}`),
    );
    const picked = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : `Bot ${botSeat}`;
    const botName = `${prefix}${picked}`;
    const bot: import('./types').Player = {
      id: `bot_${botSeat}`,
      name: botName,
      seat: botSeat,
      connected: true,
      isBot: true,
      botLevel: level,
    };
    state.players.push(bot);

    this.broadcast({
      type: 'joined',
      playerName: botName,
      seat: botSeat,
      playerCount: state.players.length,
    });

    if (state.players.length === NUM_PLAYERS) {
      state.gameStartAt = Date.now() + 5000;
      await this.ctx.storage.setAlarm(state.gameStartAt);
    }
    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleRemoveBot(state: GameState, playerId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === playerId);
    if (!requestor || requestor.seat !== 0) return;

    // Only remove the last player if it's a bot
    const lastPlayer = state.players[state.players.length - 1];
    if (!lastPlayer?.isBot) return;

    state.players.pop();

    // Cancel countdown if active (dropping below 4 players)
    if (state.gameStartAt !== null) {
      state.gameStartAt = null;
      await this.ctx.storage.deleteAlarm();
    }

    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleKickPlayer(state: GameState, requestorId: string, targetSeat: number): Promise<void> {
    // Allow kicks in lobby or game-over (play-again waiting) phases
    if (state.phase !== 'lobby' && state.phase !== 'gameover') return;
    const requestor = state.players.find((p) => p.id === requestorId);
    if (!requestor || !requestor.connected) return;
    if (requestor.seat === targetSeat) return; // can't kick yourself
    const target = state.players.find((p) => p.seat === targetSeat);
    if (!target) return;

    // Notify and close the kicked player's WebSocket
    for (const [ws, info] of this.sessions) {
      if (info.playerId === target.id) {
        try {
          ws.send(JSON.stringify({ type: 'kicked', reason: 'You were removed from the lobby.' }));
          ws.close(1000, 'Kicked');
        } catch { /* already closed */ }
        this.sessions.delete(ws);
        break;
      }
    }

    const kickedName = target.name;
    const kickedSeat = target.seat;

    // Remove kicked player and re-index seats
    state.players = state.players.filter((p) => p.seat !== targetSeat);
    state.players.forEach((p, i) => { p.seat = i; });

    // Remove from readySeats if they were ready (for gameover phase)
    state.readySeats = state.readySeats.filter((seat) => seat !== targetSeat);

    // Cancel countdown if active
    if (state.gameStartAt !== null) {
      state.gameStartAt = null;
      await this.ctx.storage.deleteAlarm();
    }

    this.broadcast({ type: 'playerKicked', seat: kickedSeat, name: kickedName });
    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleLeave(state: GameState, playerId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const player = state.players.find((p) => p.id === playerId);
    if (!player || player.isBot) return;

    const leaverName = player.name;
    const leaverSeat = player.seat;

    // Remove player from session tracking (webSocketClose will still fire but player won't be in state)
    for (const [ws, info] of this.sessions) {
      if (info.playerId === playerId) {
        this.sessions.delete(ws);
        break;
      }
    }

    state.players = state.players.filter((p) => p.id !== playerId);
    state.players.forEach((p, i) => { p.seat = i; });

    if (state.gameStartAt !== null) {
      state.gameStartAt = null;
      await this.ctx.storage.deleteAlarm();
    }

    this.broadcast({ type: 'playerKicked', seat: leaverSeat, name: leaverName });
    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private handleChat(state: GameState, playerId: string, text: string): void {
    const player = state.players.find((p) => p.id === playerId);
    const spectator = !player ? state.spectators.find((s) => s.id === playerId) : undefined;
    const sender = player ?? spectator;
    if (!sender) return;
    const clean = String(text).trim().slice(0, 200);
    if (!clean) return;
    const isSpectator = !player;
    const displayName = isSpectator ? `Spectator: ${sender.name}` : sender.name;
    this.broadcast({ type: 'chat', name: displayName, seat: player?.seat ?? -1, text: clean });
  }

  private async handlePingPlayer(state: GameState, pingerId: string, targetSeat: number, senderWs: WebSocket): Promise<void> {
    // Only allow pings in lobby or bidding phases
    if (state.phase !== 'lobby' && state.phase !== 'bidding') {
      senderWs.send(JSON.stringify({ type: 'error', message: 'Can only ping during lobby or bidding phase.' }));
      return;
    }

    // Room must be linked to Telegram
    if (!state.groupId) {
      senderWs.send(JSON.stringify({ type: 'error', message: 'This room is not linked to Telegram.' }));
      return;
    }

    // Find pinger and target
    const pinger = state.players.find((p) => p.id === pingerId);
    if (!pinger) return;

    const target = state.players.find((p) => p.seat === targetSeat);
    if (!target) {
      senderWs.send(JSON.stringify({ type: 'error', message: 'Player not found.' }));
      return;
    }

    // Can't ping yourself
    if (pinger.seat === targetSeat) {
      senderWs.send(JSON.stringify({ type: 'error', message: 'Cannot ping yourself.' }));
      return;
    }

    // Check cooldown: target can't be pinged if they were pinged in the last 10 seconds
    const now = Date.now();
    const lastPingTime = state.pingCooldowns[targetSeat] ?? 0;
    const cooldownRemaining = Math.max(0, 10000 - (now - lastPingTime));

    if (cooldownRemaining > 0) {
      const secondsLeft = Math.ceil(cooldownRemaining / 1000);
      senderWs.send(JSON.stringify({
        type: 'error',
        message: `${target.name} was pinged recently. Please wait ${secondsLeft}s before pinging again.`
      }));
      return;
    }

    // Send Telegram ping message
    if (target.id.startsWith('tg_')) {
      const targetTgId = Number(target.id.slice(3));
      try {
        await sendMessage(
          (this.env as Env).TELEGRAM_BOT_TOKEN,
          state.groupId,
          `<a href="tg://user?id=${targetTgId}">${target.name}</a>, you're being pinged in the game! 🎴`,
        );
      } catch (err) {
        senderWs.send(JSON.stringify({ type: 'error', message: 'Failed to send ping.' }));
        return;
      }
    }

    // Update cooldown
    state.pingCooldowns[targetSeat] = now;
    await this.saveState(state);

    // Broadcast notification to all players
    this.broadcast({ type: 'playerPinged', pinger: pinger.name, seat: targetSeat });
  }

  private async handleInitiateAbandon(state: GameState, initiatorId: string, ws: WebSocket): Promise<void> {
    // Only allow in bidding or play phases
    if (state.phase !== 'bidding' && state.phase !== 'play') {
      ws.send(JSON.stringify({ type: 'error', message: 'Can only abandon during bidding or play.' }));
      return;
    }

    // Can't initiate if a vote is already in progress
    if (state.abandonVote) {
      ws.send(JSON.stringify({ type: 'error', message: 'An abandon vote is already in progress.' }));
      return;
    }

    const initiator = state.players.find((p) => p.id === initiatorId);
    if (!initiator) return;

    // Create vote state — only connected humans vote; initiator auto-votes yes
    const connectedHumans = state.players.filter((p) => p.connected && !p.isBot);
    const votes: { [seat: number]: boolean | null } = {};
    connectedHumans.forEach((p) => {
      votes[p.seat] = p.seat === initiator.seat ? true : null; // initiator auto-votes yes
    });

    // If initiator is the only connected human, abandon immediately
    const allAcceptedAlready = connectedHumans.every((p) => votes[p.seat] === true);
    if (allAcceptedAlready) {
      await this.endGameWithAbandon(state);
      return;
    }

    state.abandonVote = {
      initiatorSeat: initiator.seat,
      initiatorId: initiatorId,
      votes,
      expiresAt: Date.now() + 60000, // 1 minute timeout
    };

    await this.saveState(state);
    // Set vote timeout alarm only if no sooner alarm is already scheduled (don't stomp bot-replacement alarms)
    const voteAlarmAt = Date.now() + 60000;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm || existingAlarm > voteAlarmAt) {
      await this.ctx.storage.setAlarm(voteAlarmAt);
    }

    // Notify all players
    this.broadcast({
      type: 'abandonVoteStarted',
      initiatorSeat: initiator.seat,
      initiatorName: initiator.name,
    });

    // Send vote prompt to each connected human except the initiator (who already voted yes)
    connectedHumans.forEach((player) => {
      if (player.seat === initiator.seat) return;
      this.sessions.forEach((session, playerWs) => {
        if (session.playerId === player.id) {
          playerWs.send(JSON.stringify({ type: 'abandonVotePrompt', timeoutSeconds: 60 }));
        }
      });
    });
  }

  private async handleRespondAbandon(state: GameState, voterId: string, accept: boolean): Promise<void> {
    if (!state.abandonVote) return;

    const voter = state.players.find((p) => p.id === voterId);
    if (!voter || voter.isBot) return;

    // Record vote
    state.abandonVote.votes[voter.seat] = accept;

    // If any voter rejects, vote fails immediately
    if (!accept) {
      const rejector = voter;
      state.abandonVote = undefined;
      await this.saveState(state);
      this.broadcast({
        type: 'abandonVoteFailed',
        rejectSeat: rejector.seat,
        rejectName: rejector.name,
      });
      return;
    }

    // Check if all connected humans have voted
    const connectedHumans = state.players.filter((p) => p.connected && !p.isBot);
    const allVoted = connectedHumans.every((p) => state.abandonVote!.votes[p.seat] !== null);
    const allAccepted = connectedHumans.every((p) => state.abandonVote!.votes[p.seat] === true);

    if (allVoted && allAccepted) {
      // Unanimous yes — end game and return to lobby
      state.abandonVote = undefined;
      await this.endGameWithAbandon(state);
      return;
    }

    await this.saveState(state);
  }

  private async endGameWithAbandon(state: GameState): Promise<void> {
    // Hand is void — no Elo recorded, just return to lobby
    state.phase = 'lobby';
    state.readySeats = [];
    await this.saveState(state);

    this.broadcast({
      type: 'abandonVotePassed',
    });

    // Send updated state to all clients
    this.broadcastFullState(state);
  }

  private async handleStartGame(state: GameState, requestorId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === requestorId);
    if (!requestor || requestor.seat !== 0) return;
    if (state.players.length !== NUM_PLAYERS) return;

    // All 4 seated players must be connected before starting
    const allConnected = state.players.every((p) => p.connected);
    if (!allConnected) {
      requestor.connected && this.sessions.forEach((session, ws) => {
        if (session.playerId === requestorId) {
          const disconnectedSeats = state.players.filter((p) => !p.connected).map((p) => p.seat);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Waiting for players: Seats ${disconnectedSeats.join(', ')} still connecting...`
          }));
        }
      });
      return;
    }

    await this.ctx.storage.deleteAlarm();
    await this.startGameFromLobby(state);
  }
}
