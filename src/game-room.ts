import { DurableObject } from 'cloudflare:workers';
import type { GameState, PlayerGameView, Suit, Hand, Env, TrickRecord, BidHistoryEntry, Spectator } from './types';
import { NUM_PLAYERS, MAX_BID, CARD_SUITS } from './types';
import { generateHands, getBidFromNum, getNumFromBid, getValidSuits, compareCards, getNumFromValue } from './bridge';
import type { ClientMessage, ServerMessage } from './protocol';
import { recordGameResult, getWinnerSeats } from './stats';
import { getUser } from './db';

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
      const { roomCode } = (await request.json()) as { roomCode: string };
      const state = this.createInitialState(roomCode);
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
    if (!anyConnected) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected) {
      await this.ctx.storage.deleteAll();
    }
  }

  // --- State helpers ---

  private createInitialState(roomCode: string): GameState {
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
    } else {
      player.wins = undefined;
      player.gamesPlayed = undefined;
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
    state.players.push(newPlayer);

    this.broadcast({
      type: 'joined',
      playerName: name,
      seat,
      playerCount: state.players.length,
    });

    if (state.players.length === NUM_PLAYERS) {
      state.phase = 'bidding';
      state.hands = generateHands();
      state.turn = state.firstBidder;
      state.bidder = -1;
      state.bid = -1;
      state.passCount = 0;
      await this.saveState(state);

      this.broadcast({ type: 'gameStart', turn: state.firstBidder });
      this.broadcastFullState(state);
      this.ctx.waitUntil(this.scheduleBotAction());
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
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

    const otherSeats = [0, 1, 2, 3].filter((s) => s !== state.firstBidder);
    const nextFirstBidder = otherSeats[Math.floor(Math.random() * otherSeats.length)];

    state.phase = 'bidding';
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
    state.passCount = 0;
    state.lastTrick = null;
    state.trickComplete = false;
    state.bidHistory = [];

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
      await this.handlePass(state, current.id);
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

    // If trick is complete or no cards played yet, bot leads with its lowest card
    const trickInProgress = !state.trickComplete && state.playedCards.some((c) => c !== null);
    if (!trickInProgress) {
      return this.lowestCard(validCards);
    }

    // Build ordered cards played so far (from firstPlayer)
    const orderedSoFar: string[] = [];
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const idx = (state.firstPlayer + i) % NUM_PLAYERS;
      if (state.playedCards[idx] !== null) {
        orderedSoFar.push(state.playedCards[idx]!);
      }
    }

    // Find cards that would win
    const winningCards: string[] = [];
    for (const card of validCards) {
      const testCards = [...orderedSoFar, card];
      const winnerOffset = compareCards(testCards, state.currentSuit!, state.trumpSuit);
      if (winnerOffset === testCards.length - 1) {
        winningCards.push(card);
      }
    }

    return winningCards.length > 0 ? this.lowestCard(winningCards) : this.lowestCard(validCards);
  }

  private lowestCard(cards: string[]): string {
    return cards.reduce((best, card) => {
      const bestNum = getNumFromValue(best.split(' ')[0]);
      const cardNum = getNumFromValue(card.split(' ')[0]);
      return cardNum < bestNum ? card : best;
    });
  }

  private getBotPartnerCard(state: GameState, bidderSeat: number): string {
    // Pick the highest card from another player's hand (strongest partner)
    for (const suit of ['♠', '♥', '♦', '♣'] as import('./types').Suit[]) {
      for (let s = 0; s < NUM_PLAYERS; s++) {
        if (s === bidderSeat) continue;
        const values = state.hands[s][suit];
        if (values.length > 0) return `${values[0]} ${suit}`;
      }
    }
    return 'A ♠';
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
      state.phase = 'bidding';
      state.hands = generateHands();
      state.turn = state.firstBidder;
      state.bidder = -1;
      state.bid = -1;
      state.passCount = 0;
      await this.saveState(state);
      this.broadcast({ type: 'gameStart', turn: state.firstBidder });
      this.broadcastFullState(state);
      this.ctx.waitUntil(this.scheduleBotAction());
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
    }
  }

  private async handleRemoveBot(state: GameState, playerId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === playerId);
    if (!requestor || requestor.seat !== 0) return;

    // Only remove the last player if it's a bot
    const lastPlayer = state.players[state.players.length - 1];
    if (!lastPlayer?.isBot) return;

    state.players.pop();
    await this.saveState(state);
    this.broadcastFullState(state);
  }
}
