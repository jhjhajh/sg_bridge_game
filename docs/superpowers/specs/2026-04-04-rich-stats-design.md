# Rich Stats & Stats Page — Design Spec

**Date:** 2026-04-04
**Branch:** new-feature

---

## Overview

Extend the game's stat tracking from simple win/loss counters to a full per-game event log, and add a public `/stats` page with role-based breakdowns, pair chemistry, and per-group filtering.

Stats are tracked **going forward from deployment only** — historical games are not backfilled.

---

## Goals

- Track every player's performance broken down by role: bidder, partner, opposition
- Track pair chemistry: win rate for any two players who were on the same team
- Surface all stats on a dedicated `/stats` page (sortable, filterable)
- Support per-group filtering alongside global stats
- Keep the existing home-screen leaderboard fast and unchanged

---

## Data Layer

### New table: `game_records`

```sql
-- migrations/0004_game_records.sql
CREATE TABLE IF NOT EXISTS game_records (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id              TEXT    NOT NULL,
  group_id             TEXT,
  played_at            INTEGER NOT NULL,
  telegram_id          INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK(role IN ('bidder','partner','opposition')),
  won                  INTEGER NOT NULL CHECK(won IN (0,1)),
  bid_level            INTEGER NOT NULL,
  bid_suit             TEXT    NOT NULL,
  tricks_won           INTEGER NOT NULL,
  partner_telegram_id  INTEGER,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_game_records_telegram ON game_records(telegram_id);
CREATE INDEX IF NOT EXISTS idx_game_records_group    ON game_records(group_id);
CREATE INDEX IF NOT EXISTS idx_game_records_game     ON game_records(game_id);
```

**Field notes:**
- `game_id` — the room code; uniquely identifies a game instance
- `group_id` — null for open games, Telegram chat ID for group-linked games
- `role` — `'bidder'` (won the bid), `'partner'` (called as partner card), `'opposition'` (other two)
- `won` — 1 if this player's team won, 0 if lost
- `bid_level` — the bid that was made (1–7), same value for all 4 rows of a game
- `bid_suit` — `♣` `♦` `♥` `♠` `🚫`, same for all 4 rows of a game
- `tricks_won` — tricks won by this player's team (bidder team or opposition team)
- `partner_telegram_id` — the other player on this player's team; null if the bidder called their own card (solo bidder, no partner)

**Pair detection logic:** Two players are teammates if they share the same `game_id` and the same `won` value. Since exactly one team wins per game, `won=1` means both players won → same team; `won=0` → same team. Pairs query uses a self-join with `gr1.telegram_id < gr2.telegram_id` to avoid duplicates.

The existing `users.wins` and `users.games_played` counters are **retained** for the fast home-screen leaderboard. Both `game_records` and the counters are written together on game end.

---

## Stats Derived from `game_records`

| Stat | Derivation |
|---|---|
| Overall win % | `SUM(won) / COUNT(*)` |
| Bidder win % | `SUM(won) WHERE role='bidder'` / `COUNT(*) WHERE role='bidder'` |
| Partner win % | Same, `role='partner'` |
| Opposition win % | Same, `role='opposition'` |
| Favourite bid suit | `WHERE role='bidder' GROUP BY bid_suit ORDER BY COUNT(*) DESC LIMIT 1` |
| Pair win % | Self-join on `game_id` WHERE `won` values match; `SUM(won) / COUNT(*)` |

All stats support an optional `WHERE group_id = ?` clause for group-scoped results.

---

## Backend

### New file: `src/stats-db.ts`

A new module alongside the existing `src/stats.ts` (which stays unchanged). Exports:

```typescript
recordGameStats(db, gameId, groupId, players, winnerSeats, bid, trumpSuit, sets): Promise<void>
getPlayerStats(db, groupId?): Promise<PlayerStatRow[]>
getPairStats(db, groupId?): Promise<PairStatRow[]>
```

**`recordGameStats`** — called from `game-room.ts` at game end (alongside existing `recordGameResult`). Inserts one `game_records` row per eligible player (skips guests, i.e. non-`tg_` IDs).

Role assignment:
- `bidder` → `state.bidder` seat
- `partner` → `state.partner` seat (if `partner !== bidder`)
- `opposition` → remaining seats

**`getPlayerStats`** — returns all players with ≥ 1 game, sorted by win % descending:
```typescript
interface PlayerStatRow {
  telegramId: number;
  displayName: string;
  games: number;
  wins: number;
  winPct: number;              // rounded to 1 decimal
  bidder: { games: number; wins: number; winPct: number };
  partner: { games: number; wins: number; winPct: number };
  opposition: { games: number; wins: number; winPct: number };
  favBidSuit: string | null;   // most frequent suit when bidding, null if never bid
}
```

**`getPairStats`** — returns all pairs with ≥ 2 games together, sorted by win % descending:
```typescript
interface PairStatRow {
  player1: string;   // display_name
  player2: string;
  games: number;
  wins: number;
  winPct: number;
}
```

### Modified: `src/index.ts`

Two new routes:

```
GET /api/stats          → getPlayerStats(db, groupId?)  → PlayerStatRow[]
GET /api/stats/pairs    → getPairStats(db, groupId?)    → PairStatRow[]
```

Both accept an optional `?groupId=` query parameter. Both are public (no auth required).

A third route is also added:

```
GET /api/groups   → [{ groupId, groupName }] from the groups table
```

The stats page fetches this on load to populate the group dropdown. Returns an empty array if no groups exist (dropdown is hidden in that case).

### Modified: `src/game-room.ts`

At game end (in `handlePlayCard`, both win branches), call `recordGameStats` in addition to the existing `recordGameResult` call.

---

## Frontend

### New screen: `static/index.html`

Add `<div id="screen-stats" class="screen hidden">` with:
- A top bar: "Bridge Stats" title, group dropdown, "← Home" link
- Two tabs: **Players** | **Pairs**
- Players tab: sortable table
- Pairs tab: sortable table
- Min-games filter pills: **3** / **10** / **20**
- Footer note: "Stats tracked from first deployment of this feature · Historical games not included"

### New functions: `static/app.js`

**`showStats()`** — fetches both endpoints in parallel, renders the stats screen.

**`renderPlayersTab(rows, minGames, sortCol, sortDir)`** — renders the players table. Columns:

| Column | Key | Default sort |
|---|---|---|
| Player | rank + displayName | — |
| G | games | — |
| Win% | winPct | ▼ default |
| Bid% | bidder.winPct | — |
| Ptnr% | partner.winPct | — |
| Def% | opposition.winPct | — |
| Suit | favBidSuit | — |

Clicking any column header toggles sort asc/desc. Win% is colour-coded:
- ≥ 60% → green (`#4ade80`)
- 50–59% → yellow (`#facc15`)
- < 50% → red-tinted (`#f87171`)

**`renderPairsTab(rows, minGames, sortCol, sortDir)`** — renders the pairs table. Columns: Teammates, G, Win%.

**Group filtering:** The group dropdown is populated from the stats response headers or a known list. Selecting a group re-fetches with `?groupId=`. "Global" clears the filter.

### Modified: `static/app.js`

Home screen leaderboard gets a **"Full stats →"** link that calls `showStats()`.

### New styles: `static/style.css`

- `.stats-container` — matches the existing glassmorphism card style
- `.stats-tabs` — tab bar styled to match bidding screen tabs
- `.stats-table` — full-width table, right-aligned numbers, sortable headers
- `.stats-table th.sorted` — active sort column highlight
- `.win-pct-high` / `.win-pct-mid` / `.win-pct-low` — colour classes
- `.min-games-filter` — pill button group

---

## Stats Page Navigation

The `/stats` route is handled by the existing Worker serving `index.html`. The frontend detects `window.location.pathname === '/stats'` on load and calls `showStats()` directly instead of showing the home screen.

Alternatively, the stats screen is reachable via `showScreen('screen-stats')` from the home screen "Full stats →" link — no hard navigation required. Both entry points work.

---

## Scope Boundaries

**In scope:**
- `game_records` migration and insertion
- `GET /api/stats` and `GET /api/stats/pairs`
- `/stats` page: Players tab, Pairs tab, group filter, min-games filter, sortable columns
- "Full stats →" link on home screen

**Out of scope:**
- Clickable player profile panels (possible future addition)
- Time-period filtering (all time only for now)
- Stats for bot players (skipped — no telegram_id)
- Backfilling historical games
