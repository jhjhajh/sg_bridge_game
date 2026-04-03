# Rich Stats & Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-game role stats (bidder/partner/opposition) in a new `game_records` D1 table and expose them on a `/stats` screen with sortable player and pair leaderboards.

**Architecture:** A new `src/stats-db.ts` module handles all `game_records` reads/writes. `game-room.ts` calls `recordGameStats` at game end alongside the existing `recordGameResult`. Two new API routes (`GET /api/stats`, `GET /api/stats/pairs`) and one helper route (`GET /api/groups`) feed a new `#screen-stats` in the SPA frontend.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), TypeScript, Vanilla JS, Vitest

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `migrations/0004_game_records.sql` | Create | `game_records` table + indexes |
| `src/stats-db.ts` | Create | `recordGameStats`, `getPlayerStats`, `getPairStats`; `PlayerStatRow` and `PairStatRow` types |
| `src/index.ts` | Modify | `GET /api/stats`, `GET /api/stats/pairs`, `GET /api/groups` |
| `src/game-room.ts` | Modify | Call `recordGameStats` at both game-over branches |
| `tests/stats-db.test.ts` | Create | Tests for `recordGameStats` logic (mock D1) |
| `static/index.html` | Modify | Add `#screen-stats` div; add "Full stats →" link on home screen |
| `static/style.css` | Modify | Stats page styles |
| `static/app.js` | Modify | `showStats`, `loadStats`, `renderPlayersTab`, `renderPairsTab`, group dropdown, sort/filter |

---

### Task 1: D1 migration — game_records table

**Files:**
- Create: `migrations/0004_game_records.sql`

- [ ] **Step 1: Create the migration file**

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

- [ ] **Step 2: Apply migration locally**

```bash
npx wrangler d1 execute DB --local --file=migrations/0004_game_records.sql
```
Expected: no errors.

- [ ] **Step 3: Apply migration to production**

```bash
npx wrangler d1 execute DB --remote --file=migrations/0004_game_records.sql
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add migrations/0004_game_records.sql
git commit -m "feat: add game_records D1 table for rich stats tracking"
```

---

### Task 2: src/stats-db.ts — recordGameStats + tests

**Files:**
- Create: `src/stats-db.ts`
- Create: `tests/stats-db.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/stats-db.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { recordGameStats } from '../src/stats-db';
import type { Player } from '../src/types';

// Minimal D1 mock that captures batch() calls
function makeMockDb() {
  const inserted: Array<{ sql: string; args: unknown[] }> = [];
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          // Return an object that batch() can receive
          return { _sql: sql, _args: args };
        },
      };
    },
    async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
      for (const s of stmts) inserted.push({ sql: s._sql, args: s._args });
      return stmts.map(() => ({ success: true, results: [], meta: {} }));
    },
    _inserted: inserted,
  } as unknown as D1Database & { _inserted: typeof inserted };
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id, i) => ({
    id,
    name: `P${i}`,
    seat: i,
    connected: true,
  }));
}

describe('recordGameStats', () => {
  it('inserts one row per authenticated player', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    await recordGameStats(db, 'ROOM1', null, players, 0, 1, 12, [4, 4, 5, 5], [0, 1]);
    expect(db._inserted).toHaveLength(4);
  });

  it('skips guest players (non-tg_ ids)', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'guest_abc', 'tg_3', 'bot_0']);
    await recordGameStats(db, 'ROOM2', null, players, 0, 1, 12, [4, 4, 5, 5], [0, 1]);
    expect(db._inserted).toHaveLength(1); // only tg_1 and tg_3, but tg_3 is seat 2 so...
    // only tg_1 (seat 0) and tg_3 (seat 2) are authenticated
    expect(db._inserted).toHaveLength(2);
  });

  it('assigns roles correctly: bidder, partner, opposition', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_10', 'tg_20', 'tg_30', 'tg_40']);
    // bidderSeat=0, partnerSeat=2, winnerSeats=[0,2]
    await recordGameStats(db, 'ROOM3', null, players, 0, 2, 12, [5, 4, 5, 4], [0, 2]);
    const roles = db._inserted.map((r) => r.args[4]); // 5th param is role
    expect(roles).toContain('bidder');
    expect(roles).toContain('partner');
    expect(roles.filter((r) => r === 'opposition')).toHaveLength(2);
  });

  it('parses bid 12 as level 3, suit ♥', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    await recordGameStats(db, 'ROOM4', null, players, 0, 1, 12, [5, 5, 4, 4], [0, 1]);
    const bidderRow = db._inserted.find((r) => r.args[4] === 'bidder')!;
    expect(bidderRow.args[6]).toBe(3);   // bid_level
    expect(bidderRow.args[7]).toBe('♥'); // bid_suit
  });

  it('sets partner_telegram_id to null for solo bidder (partner === bidder)', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    // partnerSeat === bidderSeat → solo bid
    await recordGameStats(db, 'ROOM5', null, players, 0, 0, 5, [7, 2, 2, 2], [0]);
    const bidderRow = db._inserted.find((r) => r.args[4] === 'bidder')!;
    expect(bidderRow.args[9]).toBeNull(); // partner_telegram_id
  });

  it('sets won=1 for winner seats and won=0 for losers', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_1', 'tg_2', 'tg_3', 'tg_4']);
    // winnerSeats = [0, 1] (bidder team wins)
    await recordGameStats(db, 'ROOM6', null, players, 0, 1, 12, [5, 5, 4, 4], [0, 1]);
    const wonValues = db._inserted.map((r) => ({ seat: r.args[3], won: r.args[5] }));
    // seat=0 (tg_1) → won=1, seat=1 (tg_2) → won=1, seat=2 (tg_3) → won=0, seat=3 (tg_4) → won=0
    expect(wonValues.find((r) => r.seat === 1)?.won).toBe(1);
    expect(wonValues.find((r) => r.seat === 2)?.won).toBe(1);
    expect(wonValues.find((r) => r.seat === 10)?.won).toBe(1);
    expect(wonValues.find((r) => r.seat === 20)?.won).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/stats-db.test.ts
```
Expected: error — `recordGameStats` not found.

- [ ] **Step 3: Create `src/stats-db.ts` with `recordGameStats`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import type { Player } from './types';

const BID_SUITS = ['♣', '♦', '♥', '♠', '🚫'] as const;

export interface PlayerStatRow {
  telegramId: number;
  displayName: string;
  games: number;
  wins: number;
  winPct: number;
  bidder: { games: number; wins: number; winPct: number };
  partner: { games: number; wins: number; winPct: number };
  opposition: { games: number; wins: number; winPct: number };
  favBidSuit: string | null;
}

export interface PairStatRow {
  player1: string;
  player2: string;
  games: number;
  wins: number;
  winPct: number;
}

/**
 * Inserts one game_records row per authenticated player.
 * Guests (non-tg_ IDs) and bots are silently skipped.
 */
export async function recordGameStats(
  db: D1Database,
  gameId: string,
  groupId: string | null,
  players: Player[],
  bidderSeat: number,
  partnerSeat: number,
  bid: number,
  sets: number[],
  winnerSeats: number[],
): Promise<void> {
  const bidLevel = Math.floor(bid / 5) + 1;
  const bidSuit = BID_SUITS[bid % 5];
  const isSoloBidder = bidderSeat === partnerSeat;
  const bidderTeam = isSoloBidder ? [bidderSeat] : [bidderSeat, partnerSeat];
  const oppTeam = [0, 1, 2, 3].filter((s) => !bidderTeam.includes(s));

  const bidderTricksWon = bidderTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);
  const oppTricksWon = oppTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);

  // seat → telegram_id lookup (null for guests)
  const seatToTgId: Record<number, number | null> = {};
  for (const p of players) {
    seatToTgId[p.seat] = p.id.startsWith('tg_') ? Number(p.id.slice(3)) : null;
  }

  const stmts = players
    .filter((p) => p.id.startsWith('tg_'))
    .map((player) => {
      const telegramId = Number(player.id.slice(3));
      const { seat } = player;
      const won = winnerSeats.includes(seat) ? 1 : 0;
      const tricksWon = bidderTeam.includes(seat) ? bidderTricksWon : oppTricksWon;

      let role: 'bidder' | 'partner' | 'opposition';
      let partnerTgId: number | null = null;

      if (seat === bidderSeat) {
        role = 'bidder';
        partnerTgId = isSoloBidder ? null : (seatToTgId[partnerSeat] ?? null);
      } else if (!isSoloBidder && seat === partnerSeat) {
        role = 'partner';
        partnerTgId = seatToTgId[bidderSeat] ?? null;
      } else {
        role = 'opposition';
        const oppPartnerSeat = oppTeam.find((s) => s !== seat) ?? null;
        partnerTgId = oppPartnerSeat !== null ? (seatToTgId[oppPartnerSeat] ?? null) : null;
      }

      return db
        .prepare(
          `INSERT INTO game_records
           (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          gameId, groupId, Math.floor(Date.now() / 1000),
          telegramId, role, won, bidLevel, bidSuit, tricksWon, partnerTgId,
        );
    });

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}
```

- [ ] **Step 4: Fix the test — the `won` test used wrong seat lookups. Update the last test in `tests/stats-db.test.ts` to match the actual insert order (args[3] is telegram_id, not seat):**

Replace the last test with:
```typescript
  it('sets won=1 for winner seats and won=0 for losers', async () => {
    const db = makeMockDb();
    const players = makePlayers(['tg_100', 'tg_200', 'tg_300', 'tg_400']);
    // seats: 0=tg_100, 1=tg_200, 2=tg_300, 3=tg_400
    // winnerSeats = [0, 1] → tg_100 and tg_200 win
    await recordGameStats(db, 'ROOM6', null, players, 0, 1, 12, [5, 5, 4, 4], [0, 1]);
    // args order: game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id
    const tg100row = db._inserted.find((r) => r.args[3] === 100)!;
    const tg300row = db._inserted.find((r) => r.args[3] === 300)!;
    expect(tg100row.args[5]).toBe(1); // won
    expect(tg300row.args[5]).toBe(0); // lost
  });
```

Also fix the guest-skip test (Step 1 has a duplicate expect — remove the first one):
```typescript
  it('skips guest players (non-tg_ ids)', async () => {
    const db = makeMockDb();
    // seat 0 = tg_1, seat 1 = guest_abc, seat 2 = tg_3, seat 3 = bot_0
    const players: Player[] = [
      { id: 'tg_1',    name: 'P0', seat: 0, connected: true },
      { id: 'guest_x', name: 'P1', seat: 1, connected: true },
      { id: 'tg_3',    name: 'P2', seat: 2, connected: true },
      { id: 'bot_0',   name: 'P3', seat: 3, connected: true },
    ];
    await recordGameStats(db, 'ROOM2', null, players, 0, 1, 12, [4, 4, 5, 5], [0, 1]);
    expect(db._inserted).toHaveLength(2); // only tg_1 and tg_3
  });
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Run tests**

```bash
npm test -- tests/stats-db.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/stats-db.ts tests/stats-db.test.ts
git commit -m "feat: add recordGameStats with per-game role tracking"
```

---

### Task 3: src/stats-db.ts — getPlayerStats + getPairStats

**Files:**
- Modify: `src/stats-db.ts`
- Modify: `tests/stats-db.test.ts`

- [ ] **Step 1: Add smoke tests for getPlayerStats and getPairStats**

Append to `tests/stats-db.test.ts`:

```typescript
import { getPlayerStats, getPairStats } from '../src/stats-db';

// Mock that returns empty results (smoke tests — SQL logic is tested via D1)
function makeEmptyDb() {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getPlayerStats', () => {
  it('returns an empty array when no records exist', async () => {
    const db = makeEmptyDb();
    const result = await getPlayerStats(db);
    expect(result).toEqual([]);
  });

  it('accepts an optional groupId without throwing', async () => {
    const db = makeEmptyDb();
    const result = await getPlayerStats(db, '-100200300');
    expect(result).toEqual([]);
  });
});

describe('getPairStats', () => {
  it('returns an empty array when no records exist', async () => {
    const db = makeEmptyDb();
    const result = await getPairStats(db);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
npm test -- tests/stats-db.test.ts
```
Expected: `getPlayerStats` and `getPairStats` not found.

- [ ] **Step 3: Add `getPlayerStats` and `getPairStats` to `src/stats-db.ts`**

Append to the bottom of `src/stats-db.ts`:

```typescript
function pct(wins: number, games: number): number {
  return games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;
}

export async function getPlayerStats(db: D1Database, groupId?: string): Promise<PlayerStatRow[]> {
  const where = groupId ? 'WHERE gr.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId] : [];

  const main = await db
    .prepare(
      `SELECT
         u.telegram_id, u.display_name,
         COUNT(*) as games,
         SUM(gr.won) as wins,
         ROUND(100.0 * SUM(gr.won) / COUNT(*), 1) as win_pct,
         SUM(CASE WHEN gr.role = 'bidder' THEN 1 ELSE 0 END) as bidder_games,
         SUM(CASE WHEN gr.role = 'bidder' AND gr.won = 1 THEN 1 ELSE 0 END) as bidder_wins,
         SUM(CASE WHEN gr.role = 'partner' THEN 1 ELSE 0 END) as partner_games,
         SUM(CASE WHEN gr.role = 'partner' AND gr.won = 1 THEN 1 ELSE 0 END) as partner_wins,
         SUM(CASE WHEN gr.role = 'opposition' THEN 1 ELSE 0 END) as opp_games,
         SUM(CASE WHEN gr.role = 'opposition' AND gr.won = 1 THEN 1 ELSE 0 END) as opp_wins
       FROM game_records gr
       JOIN users u ON u.telegram_id = gr.telegram_id
       ${where}
       GROUP BY gr.telegram_id
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{
      telegram_id: number; display_name: string;
      games: number; wins: number; win_pct: number;
      bidder_games: number; bidder_wins: number;
      partner_games: number; partner_wins: number;
      opp_games: number; opp_wins: number;
    }>();

  const suitWhere = groupId ? "WHERE role = 'bidder' AND group_id = ?" : "WHERE role = 'bidder'";
  const suits = await db
    .prepare(
      `SELECT telegram_id, bid_suit
       FROM (
         SELECT telegram_id, bid_suit,
                ROW_NUMBER() OVER (PARTITION BY telegram_id ORDER BY COUNT(*) DESC) as rn
         FROM game_records
         ${suitWhere}
         GROUP BY telegram_id, bid_suit
       )
       WHERE rn = 1`,
    )
    .bind(...bindings)
    .all<{ telegram_id: number; bid_suit: string }>();

  const favSuit = new Map((suits.results ?? []).map((r) => [r.telegram_id, r.bid_suit]));

  return (main.results ?? []).map((r) => ({
    telegramId: r.telegram_id,
    displayName: r.display_name,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
    bidder: { games: r.bidder_games, wins: r.bidder_wins, winPct: pct(r.bidder_wins, r.bidder_games) },
    partner: { games: r.partner_games, wins: r.partner_wins, winPct: pct(r.partner_wins, r.partner_games) },
    opposition: { games: r.opp_games, wins: r.opp_wins, winPct: pct(r.opp_wins, r.opp_games) },
    favBidSuit: favSuit.get(r.telegram_id) ?? null,
  }));
}

export async function getPairStats(db: D1Database, groupId?: string): Promise<PairStatRow[]> {
  const where = groupId ? 'WHERE gr1.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId] : [];

  const rows = await db
    .prepare(
      `SELECT
         u1.display_name as player1,
         u2.display_name as player2,
         COUNT(*) as games,
         SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) as wins,
         ROUND(100.0 * SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct
       FROM game_records gr1
       JOIN game_records gr2
         ON gr1.game_id = gr2.game_id
        AND gr1.telegram_id < gr2.telegram_id
        AND gr1.won = gr2.won
       JOIN users u1 ON u1.telegram_id = gr1.telegram_id
       JOIN users u2 ON u2.telegram_id = gr2.telegram_id
       ${where}
       GROUP BY gr1.telegram_id, gr2.telegram_id
       HAVING COUNT(*) >= 2
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{ player1: string; player2: string; games: number; wins: number; win_pct: number }>();

  return (rows.results ?? []).map((r) => ({
    player1: r.player1,
    player2: r.player2,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
  }));
}
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: all tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/stats-db.ts tests/stats-db.test.ts
git commit -m "feat: add getPlayerStats and getPairStats queries"
```

---

### Task 4: src/index.ts — /api/stats, /api/stats/pairs, /api/groups routes

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import for stats-db functions**

At the top of `src/index.ts`, the current imports are:
```typescript
import type { Env } from './types';
import { verifyTelegramAuth, signJwt, verifyJwt } from './auth';
import { upsertUser, getUser, updateDisplayName, getLeaderboard, upsertGroup, getGroupLeaderboard } from './db';
import { sendMessage, parseUpdate } from './telegram';
```

Add a new import line after the last import:
```typescript
import { getPlayerStats, getPairStats } from './stats-db';
```

- [ ] **Step 2: Add the three new route handlers**

Find the line `return new Response(null, { status: 404 });` at the end of the fetch handler and insert these three blocks before it:

```typescript
  if (url.pathname === '/api/stats' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId') ?? undefined;
    const data = await getPlayerStats(env.DB, groupId);
    return Response.json(data);
  }

  if (url.pathname === '/api/stats/pairs' && request.method === 'GET') {
    const groupId = url.searchParams.get('groupId') ?? undefined;
    const data = await getPairStats(env.DB, groupId);
    return Response.json(data);
  }

  if (url.pathname === '/api/groups' && request.method === 'GET') {
    const rows = await env.DB
      .prepare('SELECT group_id, group_name FROM groups ORDER BY group_name ASC')
      .all<{ group_id: string; group_name: string }>();
    const groups = (rows.results ?? []).map((r) => ({
      groupId: r.group_id,
      groupName: r.group_name,
    }));
    return Response.json(groups);
  }
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add /api/stats, /api/stats/pairs, /api/groups routes"
```

---

### Task 5: src/game-room.ts — call recordGameStats at game end

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add import for recordGameStats**

The current imports at the top of `src/game-room.ts` end with:
```typescript
import { sendMessage, isChatMember } from './telegram';
import { recordGroupResult } from './db';
```

Add one line after them:
```typescript
import { recordGameStats } from './stats-db';
```

- [ ] **Step 2: Add recordGameStats call in the bidder-wins block**

In `handlePlayCard`, find the bidder-wins game-over block. It currently contains:
```typescript
  await recordGameResult(
    (this.env as Env).DB,
    state.players,
    getWinnerSeats(bidder, partner, true),
  );
```

Add the `recordGameStats` call immediately after it:
```typescript
  await recordGameStats(
    (this.env as Env).DB,
    state.roomCode,
    state.groupId,
    state.players,
    bidder,
    partner,
    state.bid,
    state.sets,
    getWinnerSeats(bidder, partner, true),
  );
```

- [ ] **Step 3: Add recordGameStats call in the opposition-wins block**

Find the opposition-wins game-over block containing:
```typescript
  await recordGameResult(
    (this.env as Env).DB,
    state.players,
    getWinnerSeats(bidder, partner, false),
  );
```

Add immediately after it:
```typescript
  await recordGameStats(
    (this.env as Env).DB,
    state.roomCode,
    state.groupId,
    state.players,
    bidder,
    partner,
    state.bid,
    state.sets,
    getWinnerSeats(bidder, partner, false),
  );
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/game-room.ts
git commit -m "feat: record rich stats on game end"
```

---

### Task 6: Frontend — HTML (screen-stats + home link)

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: Add "Full stats →" link to the home screen**

In `static/index.html`, find:
```html
    <div id="leaderboard-section"></div>
```

Replace with:
```html
    <div id="leaderboard-section"></div>
    <div class="stats-link-bar">
      <button class="btn-link" onclick="showStats()">📊 Full stats →</button>
    </div>
```

- [ ] **Step 2: Add the screen-stats div**

Find the closing `</body>` or the last `</div>` before it and add the new screen just before:

```html
  <div id="screen-stats" class="screen hidden">
    <div class="stats-container">
      <div class="stats-topbar">
        <span class="stats-title">📊 Bridge Stats</span>
        <div class="stats-topbar-right">
          <select id="stats-group-select" class="stats-group-select"></select>
          <button class="btn-link" onclick="showScreen('screen-home')">← Home</button>
        </div>
      </div>
      <div class="stats-tabs">
        <button class="stats-tab active" id="stats-tab-players" onclick="switchStatsTab('players')">Players</button>
        <button class="stats-tab" id="stats-tab-pairs" onclick="switchStatsTab('pairs')">Pairs</button>
      </div>
      <div class="stats-filter-bar">
        <span class="stats-filter-label">Min games:</span>
        <div class="min-games-filter">
          <button class="min-games-btn active" data-value="3" onclick="setMinGames(3)">3</button>
          <button class="min-games-btn" data-value="10" onclick="setMinGames(10)">10</button>
          <button class="min-games-btn" data-value="20" onclick="setMinGames(20)">20</button>
        </div>
      </div>
      <div id="stats-content"></div>
      <p class="stats-footer">Stats tracked from first deployment of this feature · Historical games not included</p>
    </div>
  </div>
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat: add screen-stats HTML and Full stats link on home"
```

---

### Task 7: Frontend — CSS (stats page styles)

**Files:**
- Modify: `static/style.css`

- [ ] **Step 1: Add stats styles at the end of style.css**

```css
/* --- Stats page --- */
.stats-link-bar {
  text-align: right;
  margin-top: 0.25rem;
}
.btn-link {
  background: none;
  border: none;
  color: var(--accent-light);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.25rem 0;
  text-decoration: none;
  transition: color var(--transition);
}
.btn-link:hover { color: #fff; }

.stats-container {
  width: 100%;
  max-width: 600px;
  background: var(--glass);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  backdrop-filter: blur(20px);
  overflow: hidden;
}
.stats-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.stats-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--accent-light);
}
.stats-topbar-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.stats-group-select {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  color: #ccc;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 0.72rem;
  cursor: pointer;
}
.stats-tabs {
  display: flex;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  padding: 0 1rem;
}
.stats-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #888;
  font-size: 0.82rem;
  font-weight: 500;
  padding: 0.6rem 1rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition: color var(--transition), border-color var(--transition);
}
.stats-tab.active {
  color: #fff;
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.stats-filter-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.stats-filter-label {
  font-size: 0.68rem;
  color: #888;
}
.min-games-filter {
  display: flex;
  gap: 3px;
}
.min-games-btn {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.08);
  color: #888;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: all var(--transition);
}
.min-games-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.stats-table-wrap {
  overflow-x: auto;
  padding: 0 0 0.5rem;
}
.stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.73rem;
}
.stats-table thead tr {
  background: rgba(255,255,255,0.04);
}
.stats-table th {
  padding: 6px 8px;
  text-align: right;
  font-weight: 500;
  color: #888;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: color var(--transition);
}
.stats-table th:hover { color: #ccc; }
.stats-table th.sorted { color: #fff; }
.stats-th-left { text-align: left !important; padding-left: 1rem !important; }
.stats-table td {
  padding: 6px 8px;
  border-top: 1px solid rgba(255,255,255,0.05);
  color: #ccc;
}
.stats-td-name {
  text-align: left;
  padding-left: 1rem !important;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
}
.stats-td-num {
  text-align: right;
  font-family: var(--mono);
  white-space: nowrap;
}
.sort-arrow { font-size: 0.6rem; margin-left: 2px; color: #555; }
.sort-arrow.active { color: var(--accent-light); }
.win-pct-high { color: #4ade80; font-weight: 700; }
.win-pct-mid  { color: #facc15; font-weight: 700; }
.win-pct-low  { color: #f87171; font-weight: 700; }
.stats-na { color: #555; }
.stats-empty {
  text-align: center;
  color: #666;
  font-size: 0.8rem;
  padding: 2rem 1rem;
}
.stats-footer {
  text-align: center;
  font-size: 0.62rem;
  color: #444;
  padding: 0.5rem 1rem 0.75rem;
  margin: 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add static/style.css
git commit -m "feat: stats page CSS styles"
```

---

### Task 8: Frontend — JS (showStats, renderPlayersTab, renderPairsTab)

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Add stats state variables**

Near the top of `static/app.js`, after the existing `let` declarations (look for `let prevTurn`, `let lastGameOver`, etc.), add:

```javascript
let statsData = { players: [], pairs: [] };
let statsGroups = [];
let statsTab = 'players';
let statsMinGames = 3;
let statsSort = { col: 'winPct', dir: 'desc' };
let statsGroupId = null;
```

- [ ] **Step 2: Add showStats and loadStats functions**

Add these functions after the existing `renderGroupLeaderboard` function:

```javascript
async function showStats() {
  showScreen('screen-stats');
  statsTab = 'players';
  statsSort = { col: 'winPct', dir: 'desc' };
  $('stats-tab-players')?.classList.add('active');
  $('stats-tab-pairs')?.classList.remove('active');
  await loadStats();
}

async function loadStats() {
  const groupParam = statsGroupId ? `?groupId=${encodeURIComponent(statsGroupId)}` : '';
  try {
    const [playersRes, pairsRes, groupsRes] = await Promise.all([
      fetch(`/api/stats${groupParam}`),
      fetch(`/api/stats/pairs${groupParam}`),
      fetch('/api/groups'),
    ]);
    if (playersRes.ok) statsData.players = await playersRes.json();
    if (pairsRes.ok) statsData.pairs = await pairsRes.json();
    if (groupsRes.ok) {
      statsGroups = await groupsRes.json();
      renderStatsGroupDropdown();
    }
  } catch {
    // network error — render with whatever we have
  }
  renderStatsTab();
}

function renderStatsGroupDropdown() {
  const sel = $('stats-group-select');
  if (!sel) return;
  if (statsGroups.length === 0) {
    sel.style.display = 'none';
    return;
  }
  sel.style.display = '';
  sel.innerHTML =
    '<option value="">🌐 Global</option>' +
    statsGroups.map((g) => `<option value="${esc(g.groupId)}">${esc(g.groupName)}</option>`).join('');
  sel.value = statsGroupId ?? '';
  sel.onchange = () => {
    statsGroupId = sel.value || null;
    loadStats();
  };
}

function switchStatsTab(tab) {
  statsTab = tab;
  $('stats-tab-players')?.classList.toggle('active', tab === 'players');
  $('stats-tab-pairs')?.classList.toggle('active', tab === 'pairs');
  renderStatsTab();
}

function setMinGames(n) {
  statsMinGames = n;
  document.querySelectorAll('.min-games-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.value) === n);
  });
  renderStatsTab();
}

function sortStats(col) {
  if (statsSort.col === col) {
    statsSort.dir = statsSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    statsSort.col = col;
    statsSort.dir = 'desc';
  }
  renderStatsTab();
}

function renderStatsTab() {
  if (statsTab === 'players') {
    renderPlayersTab(statsData.players, statsMinGames, statsSort);
  } else {
    renderPairsTab(statsData.pairs, statsMinGames, statsSort);
  }
}
```

- [ ] **Step 3: Add renderPlayersTab function**

```javascript
function renderPlayersTab(rows, minGames, sort) {
  const content = $('stats-content');
  if (!content) return;

  const filtered = rows.filter((r) => r.games >= minGames);

  const sortFns = {
    winPct:           (r) => r.winPct,
    games:            (r) => r.games,
    bidderWinPct:     (r) => r.bidder.winPct,
    partnerWinPct:    (r) => r.partner.winPct,
    oppositionWinPct: (r) => r.opposition.winPct,
    name:             (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[sort.col] ?? sortFns.winPct;
  const sorted = [...filtered].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return sort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });

  if (sorted.length === 0) {
    content.innerHTML = `<p class="stats-empty">No players with ${minGames}+ games yet.</p>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const winPctClass = (p) => p >= 60 ? 'win-pct-high' : p >= 50 ? 'win-pct-mid' : 'win-pct-low';
  const fmtPct = (p, g) =>
    g === 0 ? '<span class="stats-na">—</span>' : `<span class="${winPctClass(p)}">${p}%</span>`;

  const arrow = (col) => {
    if (sort.col !== col) return '<span class="sort-arrow">⇅</span>';
    return `<span class="sort-arrow active">${sort.dir === 'desc' ? '▼' : '▲'}</span>`;
  };
  const th = (col, label, left) =>
    `<th class="${left ? 'stats-th-left' : ''}${sort.col === col ? ' sorted' : ''}" onclick="sortStats('${col}')">${label} ${arrow(col)}</th>`;

  const bodyRows = sorted.map((r, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`;
    return `<tr>
      <td class="stats-td-name">${medal} ${esc(r.displayName)}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${fmtPct(r.winPct, r.games)}</td>
      <td class="stats-td-num">${fmtPct(r.bidder.winPct, r.bidder.games)}</td>
      <td class="stats-td-num">${fmtPct(r.partner.winPct, r.partner.games)}</td>
      <td class="stats-td-num">${fmtPct(r.opposition.winPct, r.opposition.games)}</td>
      <td class="stats-td-num">${r.favBidSuit ?? '<span class="stats-na">—</span>'}</td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      ${th('name', 'Player', true)}
      ${th('games', 'G', false)}
      ${th('winPct', 'Win%', false)}
      ${th('bidderWinPct', 'Bid%', false)}
      ${th('partnerWinPct', 'Ptnr%', false)}
      ${th('oppositionWinPct', 'Def%', false)}
      <th>Suit</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table></div>`;
}
```

- [ ] **Step 4: Add renderPairsTab function**

```javascript
function renderPairsTab(rows, minGames, sort) {
  const content = $('stats-content');
  if (!content) return;

  const filtered = rows.filter((r) => r.games >= minGames);
  const sorted = [...filtered].sort((a, b) => {
    if (sort.col === 'games') return sort.dir === 'desc' ? b.games - a.games : a.games - b.games;
    return sort.dir === 'desc' ? b.winPct - a.winPct : a.winPct - b.winPct;
  });

  if (sorted.length === 0) {
    content.innerHTML = `<p class="stats-empty">No pairs with ${minGames}+ games together yet.</p>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const winPctClass = (p) => p >= 60 ? 'win-pct-high' : p >= 50 ? 'win-pct-mid' : 'win-pct-low';

  const arrow = (col) => {
    if (sort.col !== col) return '<span class="sort-arrow">⇅</span>';
    return `<span class="sort-arrow active">${sort.dir === 'desc' ? '▼' : '▲'}</span>`;
  };
  const th = (col, label, left) =>
    `<th class="${left ? 'stats-th-left' : ''}${sort.col === col ? ' sorted' : ''}" onclick="sortStats('${col}')">${label} ${arrow(col)}</th>`;

  const bodyRows = sorted.map((r, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`;
    return `<tr>
      <td class="stats-td-name">${medal} ${esc(r.player1)} + ${esc(r.player2)}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num"><span class="${winPctClass(r.winPct)}">${r.winPct}%</span></td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      ${th('name', 'Teammates', true)}
      ${th('games', 'G', false)}
      ${th('winPct', 'Win%', false)}
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table></div>`;
}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add static/app.js
git commit -m "feat: stats page JS — showStats, renderPlayersTab, renderPairsTab"
```

---

### Task 9: Push and open PR

- [ ] **Step 1: Push branch**

```bash
git push
```

- [ ] **Step 2: Open PR on GitHub**

Navigate to: `https://github.com/vocsong/sg_bridge_bot/pull/new/new-feature`

Suggested title: `feat: rich stats tracking and /stats page`

Body:
```
## Summary
- New `game_records` D1 table records per-player per-game stats: role (bidder/partner/opposition), outcome, bid level/suit, tricks won, teammate
- New `/stats` screen with Players tab (sortable by Win%, Bid%, Ptnr%, Def%, fav suit) and Pairs tab (any two teammates, sorted by win rate together)
- Supports global and per-group filtering via group dropdown
- "Full stats →" link on home screen

## Test Plan
- [ ] Play a full game to completion and verify rows appear in `game_records` via wrangler
- [ ] Open `/stats` from home screen and verify Players tab shows correct win rates
- [ ] Switch to Pairs tab and verify teammate pairs appear
- [ ] Play several games and verify sort/filter work correctly
- [ ] Verify guest players do not appear in stats
```
