# Game Logging & End-Game Hand Display Design

**Date:** 2026-04-05

---

## Goal

Log complete game data to D1 for every game (partial or complete), and display all players' initial hands on the gameover screen — mini cards per player, with played cards dimmed.

---

## Scope

**In scope:**
- A) Game logging: 3 new D1 tables capturing initial/final hands, every trick played, and game metadata (bids, partner card, seat map, outcome)
- B) Gameover display: per-player rows of 13 mini cards, greyed-out for played cards

**Out of scope (future):**
- Full game replay viewer (step through tricks one by one)
- Historical game browser

---

## Database Schema

### `game_hands`
One row per player per game. Written in two passes.

```sql
CREATE TABLE game_hands (
  game_id     TEXT    NOT NULL,
  seat        INTEGER NOT NULL,
  player_name TEXT    NOT NULL,
  initial_hand TEXT   NOT NULL,  -- JSON array e.g. ["AS","KH","7D"]
  final_hand  TEXT,              -- JSON array of remaining cards at game end; NULL until game ends
  played_at   INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);
```

### `game_tricks`
One row per card played. Batch-inserted at game end.

```sql
CREATE TABLE game_tricks (
  game_id    TEXT    NOT NULL,
  trick_num  INTEGER NOT NULL,  -- 1-based
  play_order INTEGER NOT NULL,  -- 1-4 within the trick
  seat       INTEGER NOT NULL,
  card       TEXT    NOT NULL,
  PRIMARY KEY (game_id, trick_num, play_order)
);
```

### `game_metadata`
One row per game. Written at game end.

```sql
CREATE TABLE game_metadata (
  game_id      TEXT    NOT NULL PRIMARY KEY,
  bidder_seat  INTEGER NOT NULL,
  bid_num      INTEGER NOT NULL,
  trump_suit   TEXT,             -- null for no-trump
  partner_card TEXT    NOT NULL,
  bid_history  TEXT    NOT NULL, -- JSON array of BidHistoryEntry
  seat_map     TEXT    NOT NULL, -- JSON array [{seat, name}]
  tricks_won   TEXT    NOT NULL, -- JSON array [n0,n1,n2,n3] indexed by seat
  winning_team TEXT    NOT NULL, -- 'bidder' | 'opponents'
  played_at    INTEGER NOT NULL
);
```

---

## Backend Logic

### New `GameState` field

Add `trickLog` to accumulate trick records in DO storage during play:

```typescript
trickLog: { trickNum: number; playOrder: number; seat: number; card: string }[];
```

Initialized to `[]` in `createInitialState` and reset to `[]` in `startGameFromLobby`.

### Game start — `startGameFromLobby`

After `generateHands()`, INSERT 4 rows into `game_hands` (one per seat):

```typescript
await env.DB.prepare(
  `INSERT INTO game_hands (game_id, seat, player_name, initial_hand, played_at)
   VALUES (?, ?, ?, ?, ?)`
).bind(state.gameId, seat, player.name, JSON.stringify(hand), Date.now()).run();
```

Run all 4 as a batch. DB write failure must not block game start — wrap in try/catch and log the error; the game proceeds regardless.

### Each card play — `handlePlayCard`

After the card is removed from the player's hand, append to `state.trickLog`:

```typescript
state.trickLog.push({
  trickNum: state.tricks.length + 1,  // trick currently in progress (tricks[] grows after completion)
  playOrder: state.playedCards.filter(c => c !== null).length + 1,  // 1 = lead, 4 = last
  seat: player.seat,
  card: cardPlayed,
});
```

No D1 write here.

### Game end — `handlePlayCard` (both gameover paths)

When `state.phase = 'gameover'` is set, immediately after, fire three D1 writes:

1. **Batch INSERT `game_tricks`** — one row per entry in `state.trickLog`
2. **Batch UPDATE `game_hands`** — set `final_hand` for all 4 seats (current `state.hands[seat]`, which may be non-empty if game ended early)
3. **INSERT `game_metadata`** — bidder_seat, bid_num, trump_suit, partner_card, bid_history, seat_map, tricks_won (`state.sets`), winning_team, played_at

All three writes are `ctx.waitUntil`-wrapped so they don't block the state broadcast.

### `PlayerGameView` — new fields

```typescript
allInitialHands: (string[] | null)[] | null;  // indexed by seat; null if not yet available
allFinalHands:   (string[] | null)[] | null;
```

Both are `null` when `phase !== 'gameover'`.

### `buildStateMessage` at gameover

Query D1 for `game_hands` where `game_id = state.gameId`. Map results to two seat-indexed arrays (`allInitialHands`, `allFinalHands`) and include in the view. If the query fails or returns no rows, both fields are `null` (frontend handles gracefully).

---

## Frontend Display

### `renderGameOver` — new hand display section

Below the existing score section, add a `div.gameover-hands` containing four `.gameover-hand-row` blocks (one per player, in seat order).

Each row:
- Small label: player name
- 13 `.card-mini` elements, sorted by suit (♠ ♥ ♦ ♣, then rank within suit)
- Cards in `allInitialHands[seat]` but NOT in `allFinalHands[seat]` → add class `.played` (dimmed)
- Cards still in `allFinalHands[seat]` → full opacity (remained in hand when game ended)
- If `allInitialHands` is null → skip the entire section (no error shown)

### HTML additions

```html
<div id="gameover-hands" class="gameover-hands"></div>
```

Added to `screen-gameover` before the ready list.

### CSS

```css
.gameover-hands {
  width: 100%;
  margin: 1rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.gameover-hand-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
}
.gameover-hand-row .hand-label {
  font-size: 0.75rem;
  color: var(--text-dimmer);
}
.gameover-hand-row .hand-cards {
  display: flex;
  flex-wrap: nowrap;
  gap: 2px;
  width: 100%;
}
.gameover-hand-row .card-mini.played {
  opacity: 0.35;
}
```

---

## Migration

New migration file: `migrations/0008_game_logging.sql` — creates the three new tables.

---

## Out of Scope

- Leftover `trickLog` in DO if a game is abandoned mid-play (DO purge will clean it up)
- Querying `game_tricks` or `game_metadata` in the frontend (reserved for future replay viewer)
- Showing trick order in the gameover hand display
