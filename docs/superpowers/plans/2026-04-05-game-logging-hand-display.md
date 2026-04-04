# Game Logging & End-Game Hand Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every game's hands, tricks, and metadata to D1, and show all players' initial hands (with played cards dimmed) on the gameover screen.

**Architecture:** Three new D1 tables (`game_hands`, `game_tricks`, `game_metadata`) written via a new `src/game-logging.ts` module. Initial hands are captured at game start; trick plays accumulate in `state.trickLog` during the game; everything is flushed to D1 at game end via `ctx.waitUntil`. `GameState` also stores `initialHands` so `buildStateMessage` can expose all 4 hands to the frontend synchronously at gameover. Frontend renders 13 mini cards per player in a new row under each name.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, D1 (SQLite), Vanilla JS

---

## File Map

| File | Change |
|------|--------|
| `migrations/0008_game_logging.sql` | Create `game_hands`, `game_tricks`, `game_metadata` tables |
| `src/types.ts` | Add `TrickLogEntry` interface; add `trickLog` and `initialHands` to `GameState`; add `allInitialHands` and `allFinalHands` to `PlayerGameView` |
| `src/game-logging.ts` | New file: `insertGameHands`, `updateGameFinalHands`, `insertGameTricks`, `insertGameMetadata` |
| `tests/game-logging.test.ts` | New file: tests for all four logging functions |
| `src/game-room.ts` | Initialize new fields; append to `trickLog` on every card play; call logging functions at game start and game end |
| `static/index.html` | Add `#gameover-hands` div to gameover screen |
| `static/app.js` | Add `renderGameoverHands` helper; call it from `renderGameOver` |
| `static/style.css` | Add `.gameover-hands`, `.gameover-hand-row`, `.gameover-hand-cards`, overrides for mini cards |

---

### Task 1: DB migration — create game logging tables

**Files:**
- Create: `migrations/0008_game_logging.sql`

- [ ] **Step 1: Create migration file**

Create `migrations/0008_game_logging.sql` with this content:

```sql
-- Game logging tables for hand display and future replay

CREATE TABLE IF NOT EXISTS game_hands (
  game_id      TEXT    NOT NULL,
  seat         INTEGER NOT NULL,
  player_name  TEXT    NOT NULL,
  initial_hand TEXT    NOT NULL,  -- JSON array of card strings e.g. ["A ♠","K ♥"]
  final_hand   TEXT,              -- JSON array of remaining cards; NULL until game ends
  played_at    INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);

CREATE TABLE IF NOT EXISTS game_tricks (
  game_id    TEXT    NOT NULL,
  trick_num  INTEGER NOT NULL,  -- 1-based trick number
  play_order INTEGER NOT NULL,  -- 1 = lead, 4 = last card in trick
  seat       INTEGER NOT NULL,
  card       TEXT    NOT NULL,  -- e.g. "A ♠"
  PRIMARY KEY (game_id, trick_num, play_order)
);

CREATE TABLE IF NOT EXISTS game_metadata (
  game_id      TEXT    NOT NULL PRIMARY KEY,
  bidder_seat  INTEGER NOT NULL,
  bid_num      INTEGER NOT NULL,
  trump_suit   TEXT,             -- NULL for no-trump
  partner_card TEXT    NOT NULL,
  bid_history  TEXT    NOT NULL, -- JSON array of BidHistoryEntry
  seat_map     TEXT    NOT NULL, -- JSON array [{seat, name}]
  tricks_won   TEXT    NOT NULL, -- JSON array [n0,n1,n2,n3] indexed by seat
  winning_team TEXT    NOT NULL, -- 'bidder' | 'opponents'
  played_at    INTEGER NOT NULL
);
```

- [ ] **Step 2: Run typecheck**

```bash
cd G:/sg_bridge_game && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 28 tests pass.

- [ ] **Step 4: Commit**

```bash
cd G:/sg_bridge_game && git add migrations/0008_game_logging.sql && git commit -m "feat: add game_hands, game_tricks, game_metadata migration"
```

---

### Task 2: Add types — TrickLogEntry, trickLog, initialHands, allInitialHands, allFinalHands

**Files:**
- Modify: `src/types.ts`
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `TrickLogEntry` interface to `src/types.ts`**

Read `src/types.ts`. Find the `BidHistoryEntry` interface (around line 36):

```typescript
export interface BidHistoryEntry {
  seat: number;
  name: string;
  bidNum: number | null; // null = pass
}
```

Add after it:

```typescript
export interface BidHistoryEntry {
  seat: number;
  name: string;
  bidNum: number | null; // null = pass
}

export interface TrickLogEntry {
  trickNum: number;   // 1-based
  playOrder: number;  // 1 = lead, 4 = last
  seat: number;
  card: string;       // e.g. "A ♠"
}
```

- [ ] **Step 2: Add `trickLog` and `initialHands` to `GameState` in `src/types.ts`**

The `GameState` interface currently ends with `readySeats: number[];`. Add two fields after it:

```typescript
  readySeats: number[];
  trickLog: TrickLogEntry[];
  initialHands: Hand[];
```

- [ ] **Step 3: Add `allInitialHands` and `allFinalHands` to `PlayerGameView` in `src/types.ts`**

The `PlayerGameView` interface currently ends with `readySeats: number[];`. Add after it:

```typescript
  readySeats: number[];
  allInitialHands: Hand[] | null;
  allFinalHands: Hand[] | null;
```

- [ ] **Step 4: Initialize new fields in `createInitialState` in `src/game-room.ts`**

Read `src/game-room.ts`. Find `createInitialState`. It currently ends with:

```typescript
      gameId: crypto.randomUUID(),
      readySeats: [],
    };
```

Replace with:

```typescript
      gameId: crypto.randomUUID(),
      readySeats: [],
      trickLog: [],
      initialHands: [],
    };
```

- [ ] **Step 5: Reset `trickLog` and set `initialHands` in `startGameFromLobby` in `src/game-room.ts`**

Find `startGameFromLobby`. It contains:

```typescript
    state.bidHistory = [];
    await this.saveState(state);
```

Replace with:

```typescript
    state.bidHistory = [];
    state.trickLog = [];
    state.initialHands = state.hands.map((h) => ({
      '♣': [...h['♣']],
      '♦': [...h['♦']],
      '♥': [...h['♥']],
      '♠': [...h['♠']],
    }));
    await this.saveState(state);
```

- [ ] **Step 6: Expose `allInitialHands` and `allFinalHands` in `buildStateMessage` in `src/game-room.ts`**

Find `buildStateMessage`. It currently ends with:

```typescript
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
      readySeats: state.readySeats,
    };
```

Replace with:

```typescript
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
      readySeats: state.readySeats,
      allInitialHands: state.phase === 'gameover' && state.initialHands.length > 0
        ? state.initialHands
        : null,
      allFinalHands: state.phase === 'gameover' && state.initialHands.length > 0
        ? state.hands
        : null,
    };
```

- [ ] **Step 7: Update import line in `src/game-room.ts` to include `TrickLogEntry`**

Find the import line at the top of `src/game-room.ts`:

```typescript
import type { GameState, PlayerGameView, Suit, Hand, Env, TrickRecord, BidHistoryEntry, Spectator } from './types';
```

Replace with:

```typescript
import type { GameState, PlayerGameView, Suit, Hand, Env, TrickRecord, BidHistoryEntry, Spectator, TrickLogEntry } from './types';
```

(Note: `TrickLogEntry` is imported but not used yet — that's fine for this task; it will be used in Task 4.)

- [ ] **Step 8: Run typecheck**

```bash
cd G:/sg_bridge_game && npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Run tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 28 tests pass.

- [ ] **Step 10: Commit**

```bash
cd G:/sg_bridge_game && git add src/types.ts src/game-room.ts && git commit -m "feat: add trickLog and initialHands to GameState; expose allInitialHands/allFinalHands at gameover"
```

---

### Task 3: Create src/game-logging.ts and tests

**Files:**
- Create: `src/game-logging.ts`
- Create: `tests/game-logging.test.ts`

- [ ] **Step 1: Write failing tests in `tests/game-logging.test.ts`**

Create `tests/game-logging.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd G:/sg_bridge_game && npm test tests/game-logging.test.ts
```

Expected: FAIL — `Cannot find module '../src/game-logging'`

- [ ] **Step 3: Create `src/game-logging.ts`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import type { Player, Hand, TrickLogEntry, BidHistoryEntry } from './types';
import { CARD_SUITS } from './types';

function handToCards(hand: Hand): string[] {
  return CARD_SUITS.flatMap((suit) => hand[suit].map((v) => `${v} ${suit}`));
}

export async function insertGameHands(
  db: D1Database,
  gameId: string,
  players: Player[],
  hands: Hand[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stmts = players.map((p) =>
    db.prepare(
      `INSERT INTO game_hands (game_id, seat, player_name, initial_hand, played_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(gameId, p.seat, p.name, JSON.stringify(handToCards(hands[p.seat])), now),
  );
  await db.batch(stmts);
}

export async function updateGameFinalHands(
  db: D1Database,
  gameId: string,
  players: Player[],
  hands: Hand[],
): Promise<void> {
  const stmts = players.map((p) =>
    db.prepare(
      `UPDATE game_hands SET final_hand = ? WHERE game_id = ? AND seat = ?`,
    ).bind(JSON.stringify(handToCards(hands[p.seat])), gameId, p.seat),
  );
  await db.batch(stmts);
}

export async function insertGameTricks(
  db: D1Database,
  gameId: string,
  trickLog: TrickLogEntry[],
): Promise<void> {
  if (trickLog.length === 0) return;
  const stmts = trickLog.map((e) =>
    db.prepare(
      `INSERT INTO game_tricks (game_id, trick_num, play_order, seat, card)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(gameId, e.trickNum, e.playOrder, e.seat, e.card),
  );
  await db.batch(stmts);
}

export async function insertGameMetadata(
  db: D1Database,
  gameId: string,
  bidderSeat: number,
  bidNum: number,
  trumpSuit: string | null,
  partnerCard: string,
  bidHistory: BidHistoryEntry[],
  players: Player[],
  sets: number[],
  winningTeam: 'bidder' | 'opponents',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const seatMap = players.map((p) => ({ seat: p.seat, name: p.name }));
  await db
    .prepare(
      `INSERT INTO game_metadata
         (game_id, bidder_seat, bid_num, trump_suit, partner_card,
          bid_history, seat_map, tricks_won, winning_team, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      gameId,
      bidderSeat,
      bidNum,
      trumpSuit,
      partnerCard,
      JSON.stringify(bidHistory),
      JSON.stringify(seatMap),
      JSON.stringify(sets),
      winningTeam,
      now,
    )
    .run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd G:/sg_bridge_game && npm test tests/game-logging.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run all tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 34 tests pass (28 + 6 new).

- [ ] **Step 6: Run typecheck**

```bash
cd G:/sg_bridge_game && npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd G:/sg_bridge_game && git add src/game-logging.ts tests/game-logging.test.ts && git commit -m "feat: add game-logging module with insertGameHands, updateGameFinalHands, insertGameTricks, insertGameMetadata"
```

---

### Task 4: Wire game-logging into game-room.ts

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add import for game-logging functions**

Find the existing imports at the top of `src/game-room.ts`:

```typescript
import { recordGameStats, recordEloUpdate } from './stats-db';
```

Add after it:

```typescript
import { recordGameStats, recordEloUpdate } from './stats-db';
import { insertGameHands, updateGameFinalHands, insertGameTricks, insertGameMetadata } from './game-logging';
```

- [ ] **Step 2: Log initial hands at game start in `startGameFromLobby`**

Find in `startGameFromLobby`:

```typescript
    this.broadcast({ type: 'gameStart', turn: state.firstBidder });
    this.broadcastFullState(state);
```

Add before those two lines:

```typescript
    this.ctx.waitUntil(
      insertGameHands((this.env as Env).DB, state.gameId, state.players, state.hands)
        .catch(() => {}),
    );
    this.broadcast({ type: 'gameStart', turn: state.firstBidder });
    this.broadcastFullState(state);
```

- [ ] **Step 3: Append to trickLog on every card play in `handlePlayCard`**

Find in `handlePlayCard` (around line 659):

```typescript
    if (state.trickComplete) {
      state.playedCards = [null, null, null, null];
      state.trickComplete = false;
    }

    state.playedCards[seat] = card;
```

Replace with:

```typescript
    if (state.trickComplete) {
      state.playedCards = [null, null, null, null];
      state.trickComplete = false;
    }

    const trickNum = state.sets.reduce((s, v) => s + v, 0) + 1;
    const playOrder = state.playedCards.filter((c) => c !== null).length + 1;
    state.trickLog.push({ trickNum, playOrder, seat, card });

    state.playedCards[seat] = card;
```

- [ ] **Step 4: Flush logs at game end — bidder wins path**

Find in `handlePlayCard` the bidder-wins gameover path. It currently has:

```typescript
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
```

Replace `await this.saveState(state);` with:

```typescript
        await recordEloUpdate(
          (this.env as Env).DB,
          state.gameId,
          state.players,
          bidder,
          partner,
          getWinnerSeats(bidder, partner, true),
        );

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
          ]).catch(() => {}),
        );

        await this.saveState(state);
        this.broadcastFullState(state);
        return;
```

- [ ] **Step 5: Flush logs at game end — opponents win path**

Find the opponents-win gameover path. It currently has:

```typescript
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
```

Replace `await this.saveState(state);` with:

```typescript
        await recordEloUpdate(
          (this.env as Env).DB,
          state.gameId,
          state.players,
          bidder,
          partner,
          getWinnerSeats(bidder, partner, false),
        );

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
          ]).catch(() => {}),
        );

        await this.saveState(state);
        this.broadcastFullState(state);
        return;
```

- [ ] **Step 6: Run typecheck**

```bash
cd G:/sg_bridge_game && npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Run tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 34 tests pass.

- [ ] **Step 8: Commit**

```bash
cd G:/sg_bridge_game && git add src/game-room.ts && git commit -m "feat: log initial hands, trick plays, and metadata to D1 per game"
```

---

### Task 5: Frontend — gameover hand display

**Files:**
- Modify: `static/index.html`
- Modify: `static/app.js`
- Modify: `static/style.css`

- [ ] **Step 1: Add `#gameover-hands` div to `static/index.html`**

Read `static/index.html`. Find the gameover screen:

```html
      <div id="gameover-group-lb"></div>
      <div id="gameover-ready-list" class="gameover-ready-list"></div>
```

Replace with:

```html
      <div id="gameover-group-lb"></div>
      <div id="gameover-hands" class="gameover-hands"></div>
      <div id="gameover-ready-list" class="gameover-ready-list"></div>
```

- [ ] **Step 2: Add `renderGameoverHands` helper to `static/app.js`**

Read `static/app.js`. Find the `renderGameOver` function. Just before it (immediately before `function renderGameOver(s) {`), add a new helper function:

```javascript
function renderGameoverHands(s) {
  const container = $('gameover-hands');
  if (!container) return;
  container.innerHTML = '';
  if (!s.allInitialHands || !s.allFinalHands) return;

  // Render one row per player in seat order (0–3)
  const sorted = [...s.players].sort((a, b) => a.seat - b.seat);
  for (const p of sorted) {
    const initial = s.allInitialHands[p.seat];
    const final = s.allFinalHands[p.seat];
    if (!initial) continue;

    const row = document.createElement('div');
    row.className = 'gameover-hand-row';

    const label = document.createElement('div');
    label.className = 'hand-label';
    label.textContent = p.name;
    row.appendChild(label);

    const cards = document.createElement('div');
    cards.className = 'gameover-hand-cards';

    for (const suit of ['♣', '♦', '♥', '♠']) {
      const initialValues = (initial[suit] || []);
      const finalValues = new Set(final ? (final[suit] || []) : []);
      for (const value of initialValues) {
        const played = !finalValues.has(value);
        const el = createCardEl(value, suit, { mini: true });
        if (played) el.classList.add('played');
        cards.appendChild(el);
      }
    }

    row.appendChild(cards);
    container.appendChild(row);
  }
}
```

- [ ] **Step 3: Call `renderGameoverHands` from `renderGameOver`**

Find the end of `renderGameOver`. It currently ends with:

```javascript
  const groupLbEl = $('gameover-group-lb');
  if (groupLbEl) groupLbEl.innerHTML = '';
  if (s.groupId) {
    renderGroupLeaderboard(s.groupId);
  }

  // Ready list
```

Add the call between the group leaderboard block and the ready list block:

```javascript
  const groupLbEl = $('gameover-group-lb');
  if (groupLbEl) groupLbEl.innerHTML = '';
  if (s.groupId) {
    renderGroupLeaderboard(s.groupId);
  }

  renderGameoverHands(s);

  // Ready list
```

- [ ] **Step 4: Add CSS to `static/style.css`**

Read `static/style.css`. Find the `.gameover-ready-list` block (around line 888):

```css
.gameover-ready-list {
```

Add the new rules immediately before it:

```css
.gameover-hands {
  width: 100%;
  margin: 1rem 0 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.gameover-hand-row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.gameover-hand-row .hand-label {
  font-size: 0.7rem;
  color: var(--text-dimmer);
  text-align: left;
}
.gameover-hand-cards {
  display: flex;
  flex-wrap: nowrap;
  gap: 2px;
  width: 100%;
}
.gameover-hand-cards .card-mini {
  flex: 1;
  min-width: 0;
  width: auto;
  font-size: clamp(0.5rem, 2.6vw, 0.75rem);
  padding: 0;
}
.gameover-hand-cards .card-mini.played {
  opacity: 0.3;
}
.gameover-ready-list {
```

- [ ] **Step 5: Syntax check**

```bash
cd G:/sg_bridge_game && node --check static/app.js
```

Expected: no output.

- [ ] **Step 6: Run tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 34 tests pass.

- [ ] **Step 7: Commit**

```bash
cd G:/sg_bridge_game && git add static/index.html static/app.js static/style.css && git commit -m "feat: show all players' initial hands on gameover screen with played cards dimmed"
```

---

## Manual Verification

Run `npm run dev`. Play a full game with 4 players (bots to fill).

- [ ] Game ends early (before trick 13) → gameover screen shows 4 rows of mini cards below player names
- [ ] Cards played before game ended are dimmed (opacity ~0.3)
- [ ] Cards remaining in hand at game end are full opacity
- [ ] All 13 cards visible per player row, fitting within the container width
- [ ] `game_hands` table has 4 rows for the game_id, with `initial_hand` and `final_hand` populated
- [ ] `game_tricks` table has rows for every card played
- [ ] `game_metadata` table has 1 row for the game_id
- [ ] Playing again creates new game_id and new logging rows; old rows remain
