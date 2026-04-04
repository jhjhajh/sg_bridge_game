import { DurableObject } from 'cloudflare:workers';
import type { GameState, PlayerGameView, Suit, Hand, Env, TrickRecord, BidHistoryEntry, Spectator } from './types';
import { NUM_PLAYERS, MAX_BID, CARD_SUITS, BID_SUITS } from './types';
import { generateHands, getBidFromNum, getNumFromBid, getValidSuits, compareCards, getNumFromValue } from './bridge';
import type { ClientMessage, ServerMessage } from './protocol';
import { recordGameResult, getWinnerSeats } from './stats';
import { getUser, recordGroupResult } from './db';
import { sendMessage, isChatMember } from './telegram';
import { recordGameStats, recordEloUpdate } from './stats-db';

interface SessionInfo {
  playerId: string;
}

export class GameRoom extends DurableObject {
  sessions: Map<WebSocket, SessionInfo>;
  private botActionRunning = false;

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
      const { roomCode, groupId } = (await request.json()) as { roomCode: string; groupId?: string | null };
      const state = this.createInitialState(roomCode, groupId ?? null);
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true });
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
        await this.handleJoin(state, session.playerId, msg.name, ws);
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
      case 'watchSeat':
        await this.handleWatchSeat(state, session.playerId, msg.seat, ws);
        break;
      case 'addBot':
        await this.handleAddBot(state, session.playerId);
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
      await this.saveState(state);
      this.broadcast({
        type: 'playerDisconnected',
        seat: player.seat,
        name: player.name,
      });
    }

    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected && !state.gameStartAt) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
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

    // Inactivity cleanup alarm
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected) {
      await this.ctx.storage.deleteAll();
    }
  }

  // --- State helpers ---

  private createInitialState(roomCode: string, groupId: string | null = null): GameState {
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
      gameStartAt: null,
      partnerRevealed: false,
      gameId: crypto.randomUUID(),
    };
  }

  private async getState(): Promise<GameState | null> {
    return (await this.ctx.storage.get<GameState>('state')) ?? null;
  }

  private async saveState(state: GameState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  private buildStateMessage(state: GameState, playerId: string): ServerMessage {
    const player = state.players.find((p) => p.id === playerId);
    const spectator = !player ? state.spectators.find((s) => s.id === playerId) : undefined;
    const isSpectator = !!spectator;
    const mySeat = player?.seat ?? (spectator ? spectator.watchingSeat : -1);
    const watchingSeat = spectator?.watchingSeat ?? -1;

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
        isGroupMember: p.isGroupMember,
        elo: p.elo,
      })),
      hand: mySeat >= 0 && state.hands.length > 0 ? state.hands[mySeat] : null,
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
      isGroupMember: player?.isGroupMember,
      gameStartAt: state.gameStartAt,
      partnerSeat: state.partnerRevealed ? state.partner : -1,
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
      await this.refreshPlayerStats(existing, playerId);
      await this.saveState(state);
      ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
      this.broadcastExcept(
        { type: 'playerReconnected', seat: existing.seat, name: existing.name },
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

    if (state.players.length >= NUM_PLAYERS) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
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

      if (bidderSets >= state.setsNeeded) {
        state.phase = 'gameover';
        const winnerNames =
          partner === bidder
            ? [state.players[bidder].name]
            : [state.players[bidder].name, state.players[partner].name];

        this.broadcast({
          type: 'gameOver',
          bidderWon: true,
          winnerNames,
        });
        await recordGameResult(
          (this.env as Env).DB,
          state.players,
          getWinnerSeats(bidder, partner, true),
        );

        if (state.groupId) {
          const bidStr = getBidFromNum(state.bid);
          sendMessage(
            (this.env as Env).TELEGRAM_BOT_TOKEN,
            state.groupId,
            `🏆 ${winnerNames.join(' & ')} won!\nBid ${bidStr}, made ${bidderSets}/${state.setsNeeded} tricks`,
          ).catch(() => {});
          await recordGroupResult(
            (this.env as Env).DB,
            state.groupId,
            state.players,
            getWinnerSeats(bidder, partner, true),
          );
        }

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

        await recordEloUpdate(
          (this.env as Env).DB,
          state.gameId,
          state.players,
          bidder,
          partner,
          getWinnerSeats(bidder, partner, true),
        );

        await this.saveState(state);
        this.broadcastFullState(state);
        return;
      }

      if (opponentSets >= 14 - state.setsNeeded) {
        state.phase = 'gameover';
        const winnerNames = state.players
          .filter((_, i) => i !== bidder && i !== partner)
          .map((p) => p.name);

        this.broadcast({
          type: 'gameOver',
          bidderWon: false,
          winnerNames,
        });
        await recordGameResult(
          (this.env as Env).DB,
          state.players,
          getWinnerSeats(bidder, partner, false),
        );

        if (state.groupId) {
          const bidStr = getBidFromNum(state.bid);
          sendMessage(
            (this.env as Env).TELEGRAM_BOT_TOKEN,
            state.groupId,
            `🛡️ ${winnerNames.join(' & ')} defended!\n${state.players[bidder].name}'s ${bidStr} bid failed`,
          ).catch(() => {});
          await recordGroupResult(
            (this.env as Env).DB,
            state.groupId,
            state.players,
            getWinnerSeats(bidder, partner, false),
          );
        }

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

        await recordEloUpdate(
          (this.env as Env).DB,
          state.gameId,
          state.players,
          bidder,
          partner,
          getWinnerSeats(bidder, partner, false),
        );

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
    if (spectator.watchingSeat >= 0) return; // locked — cannot change mid-game
    if (seat < 0 || seat >= NUM_PLAYERS) return;
    spectator.watchingSeat = seat;
    await this.saveState(state);
    ws.send(JSON.stringify(this.buildStateMessage(state, playerId)));
  }

  private async handlePlayAgain(
    state: GameState,
    _playerId: string,
  ): Promise<void> {
    if (state.phase !== 'gameover') return;

    // Capture who was first bidder before seats are reshuffled
    const prevFirstBidderPlayer = state.players.find((p) => p.seat === state.firstBidder);

    this.shufflePlayerSeats(state);

    // Find their new seat after shuffle (so the same player doesn't go first twice)
    const prevFirstBidderNewSeat = prevFirstBidderPlayer
      ? (state.players.find((p) => p.id === prevFirstBidderPlayer.id)?.seat ?? -1)
      : -1;

    const otherSeats = [0, 1, 2, 3].filter((s) => s !== prevFirstBidderNewSeat);
    const nextFirstBidder = otherSeats[Math.floor(Math.random() * otherSeats.length)];

    state.phase = 'bidding';
    state.gameId = crypto.randomUUID();
    state.hands = generateHands();
    state.turn = nextFirstBidder;
    state.firstBidder = nextFirstBidder;
    state.bidder = -1;
    state.bid = -1;
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
    state.passCount = 0;
    state.lastTrick = null;
    state.trickComplete = false;
    state.bidHistory = [];

    // Re-check group membership for the new round
    if (state.groupId) {
      await Promise.all(
        state.players.map(async (p) => {
          if (p.id.startsWith('tg_')) {
            p.isGroupMember = await isChatMember(
              (this.env as Env).TELEGRAM_BOT_TOKEN,
              state.groupId!,
              Number(p.id.slice(3)),
            );
          } else {
            p.isGroupMember = false;
          }
        }),
      );
    }

    await this.saveState(state);

    this.broadcast({ type: 'gameStart', turn: nextFirstBidder });
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
    if (state.phase === 'bidding') {
      const current = state.players[state.turn];
      if (!current?.isBot) return false;
      const bidNum = this.getBotBid(state, state.turn);
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
      const card = this.getBotCard(state, state.turn);
      if (!card) return false;
      await this.handlePlayCard(state, current.id, card);
      return true;
    }
    return false;
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
        ? this.getBotCardAsBidderTeam(state, validCards)
        : this.getBotCardAsOpposition(state, seat, validCards);
    }

    // Basic fallback: win if possible, else lowest
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winningCards = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    return winningCards.length > 0 ? this.lowestCard(winningCards) : this.lowestCard(validCards);
  }

  private getBotCardAsBidderTeam(state: GameState, validCards: string[]): string {
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);
    if (currentWinnerSeat !== null && this.isOnBidderTeam(state, currentWinnerSeat)) {
      // Teammate winning — dump lowest, don't steal
      return this.lowestCard(validCards);
    }
    // Opposition winning — play lowest card that takes the trick; else dump lowest
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    return winning.length > 0 ? this.lowestCard(winning) : this.lowestCard(validCards);
  }

  private getBotCardAsOpposition(state: GameState, seat: number, validCards: string[]): string {
    const currentWinnerSeat = this.getCurrentTrickWinnerSeat(state);
    // If an opposition teammate is already winning, dump lowest (no need to spend cards)
    if (currentWinnerSeat !== null && !this.isOnBidderTeam(state, currentWinnerSeat)) {
      return this.lowestCard(validCards);
    }

    // Bidder's team is winning — try to beat them (prioritise beating the bidder)
    const orderedSoFar = this.getOrderedCardsPlayed(state);
    const winning = validCards.filter((card) => {
      const test = [...orderedSoFar, card];
      return compareCards(test, state.currentSuit!, state.trumpSuit) === test.length - 1;
    });
    if (winning.length > 0) return this.lowestCard(winning);

    // Can't win — dump lowest non-trump to conserve trump for later
    const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
    return this.lowestCard(nonTrump.length > 0 ? nonTrump : validCards);
  }

  private getBotLeadCard(
    state: GameState,
    seat: number,
    validCards: string[],
    onBidderTeam: boolean,
  ): string {
    // Build suit sets from bid history
    const partnerBidSuits = new Set<string>();
    const bidderBidSuits = new Set<string>();
    for (const entry of state.bidHistory) {
      if (entry.bidNum === null) continue;
      const suit = getBidFromNum(entry.bidNum).split(' ')[1];
      if (suit === '🚫') continue;
      if (entry.seat === state.partner) partnerBidSuits.add(suit);
      if (entry.seat === state.bidder) bidderBidSuits.add(suit);
    }

    if (onBidderTeam) {
      // Prefer leading a suit the partner bid (they likely have more)
      const partnerSuitCards = validCards.filter(
        (c) => partnerBidSuits.has(c.split(' ')[1]) && c.split(' ')[1] !== state.trumpSuit,
      );
      if (partnerSuitCards.length > 0) return this.lowestCard(partnerSuitCards);
      // Else lead longest non-trump suit
      return this.leadLongestNonTrump(state, seat, validCards);
    } else {
      // Opposition: never lead trump; avoid suits the bidder bid (they're strong there)
      const safe = validCards.filter(
        (c) => c.split(' ')[1] !== state.trumpSuit && !bidderBidSuits.has(c.split(' ')[1]) && !partnerBidSuits.has(c.split(' ')[1]),
      );
      if (safe.length > 0) return this.lowestCard(safe);
      // Fallback: at least avoid trump
      const nonTrump = validCards.filter((c) => c.split(' ')[1] !== state.trumpSuit);
      return this.lowestCard(nonTrump.length > 0 ? nonTrump : validCards);
    }
  }

  private leadLongestNonTrump(state: GameState, seat: number, validCards: string[]): string {
    const hand = state.hands[seat];
    let bestSuit: import('./types').Suit | null = null;
    let bestLen = 0;
    for (const suit of CARD_SUITS) {
      if (suit === state.trumpSuit) continue;
      if (hand[suit].length > bestLen) { bestLen = hand[suit].length; bestSuit = suit; }
    }
    if (bestSuit) {
      const cards = validCards.filter((c) => c.split(' ')[1] === bestSuit);
      if (cards.length > 0) return this.lowestCard(cards);
    }
    return this.lowestCard(validCards);
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

    // Determine desired bid level based on hand strength
    let desiredLevel: number;
    if (points < 12) return null;
    else if (points < 15) desiredLevel = 1;
    else if (points < 18) desiredLevel = 2;
    else desiredLevel = 3;

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

  private shufflePlayerSeats(state: GameState): void {
    const players = state.players;
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    players.forEach((p, i) => { p.seat = i; });
  }

  private async startGameFromLobby(state: GameState): Promise<void> {
    this.shufflePlayerSeats(state);
    state.gameStartAt = null;
    state.gameId = crypto.randomUUID();
    state.phase = 'bidding';
    state.hands = generateHands();
    state.turn = state.firstBidder;
    state.bidder = -1;
    state.bid = -1;
    state.passCount = 0;
    await this.saveState(state);
    this.broadcast({ type: 'gameStart', turn: state.firstBidder });
    this.broadcastFullState(state);
    if (state.groupId) {
      const names = state.players.map((p) => p.name).join(', ');
      sendMessage(
        (this.env as Env).TELEGRAM_BOT_TOKEN,
        state.groupId,
        `🎮 Game started!\nPlayers: ${names}`,
      ).catch(() => {});
    }
    this.ctx.waitUntil(this.scheduleBotAction());
  }

  private async handleAddBot(state: GameState, playerId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === playerId);
    if (!requestor || requestor.seat !== 0) return;
    if (state.players.length >= NUM_PLAYERS) return;

    const botSeat = state.players.length;
    const botNames = ['Bot Alpha', 'Bot Beta', 'Bot Gamma'];
    const botName = botNames[botSeat - 1] ?? `Bot ${botSeat}`;
    const bot: import('./types').Player = {
      id: `bot_${botSeat}`,
      name: botName,
      seat: botSeat,
      connected: true,
      isBot: true,
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
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === requestorId);
    if (!requestor || requestor.seat !== 0) return;
    if (targetSeat === 0) return;
    const target = state.players.find((p) => p.seat === targetSeat);
    if (!target) return;

    // Notify and close the kicked player's WebSocket
    for (const [ws, info] of this.sessions) {
      if (info.playerId === target.id) {
        try {
          ws.send(JSON.stringify({ type: 'kicked', reason: 'You were removed by the host.' }));
          ws.close(1000, 'Kicked by host');
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

    // Cancel countdown if active
    if (state.gameStartAt !== null) {
      state.gameStartAt = null;
      await this.ctx.storage.deleteAlarm();
    }

    this.broadcast({ type: 'playerKicked', seat: kickedSeat, name: kickedName });
    await this.saveState(state);
    this.broadcastFullState(state);
  }

  private async handleStartGame(state: GameState, requestorId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === requestorId);
    if (!requestor || requestor.seat !== 0) return;
    if (state.players.length !== NUM_PLAYERS) return;

    await this.ctx.storage.deleteAlarm();
    await this.startGameFromLobby(state);
  }
}
