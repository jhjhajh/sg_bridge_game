# Lobby ELO Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each player's ELO rating in the lobby player list as `ELO 1042 · 3W / 9G`.

**Architecture:** `elo` is already stored in `users.elo` (D1). It needs to be fetched in `refreshPlayerStats`, added to the `Player` type, included in `buildStateMessage`'s player mapping, and rendered in `renderLobby`. No new DB queries — `getUser` already reads from `users` but its SELECT and `UserRow` type need `elo` added.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vanilla JS

---

## File Map

| File | Change |
|------|--------|
| `src/db.ts` | Add `elo` to `UserRow` interface and SELECT query |
| `src/types.ts` | Add `elo?: number` to `Player` interface and `PlayerGameView` players array type |
| `src/game-room.ts` | Set `player.elo` in `refreshPlayerStats`; expose in `buildStateMessage` |
| `static/app.js` | Render ELO in `renderLobby` statsHtml |

---

### Task 1: Add `elo` to DB layer and Player type

**Files:**
- Modify: `src/db.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add `elo` to `UserRow` in `src/db.ts`**

The `UserRow` interface (lines 4–10) currently ends with `games_played: number;`. The SELECT query fetches `wins, games_played`. Update both:

```typescript
export interface UserRow {
  telegram_id: number;
  display_name: string;
  created_at: number;
  wins: number;
  games_played: number;
  elo: number;
}
```

And update the SELECT in `getUser` (line 35):

```typescript
  const row = await db
    .prepare('SELECT telegram_id, display_name, created_at, wins, games_played, elo FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<UserRow>();
```

- [ ] **Step 2: Add `elo?: number` to `Player` in `src/types.ts`**

The `Player` interface (lines 13–22) currently ends with `isGroupMember?: boolean;`. Add after it:

```typescript
export interface Player {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
  wins?: number;
  gamesPlayed?: number;
  isBot?: boolean;
  isGroupMember?: boolean;
  elo?: number;
}
```

- [ ] **Step 3: Add `elo?: number` to the players array type in `PlayerGameView` in `src/types.ts`**

The `PlayerGameView` interface (around line 72) has an inline type for `players`:

```typescript
  players: { name: string; seat: number; connected: boolean; wins?: number; gamesPlayed?: number; isBot?: boolean; isGroupMember?: boolean; elo?: number }[];
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: 28 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/types.ts
git commit -m "feat: add elo to UserRow and Player types"
```

---

### Task 2: Expose ELO through the server state

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Set `player.elo` in `refreshPlayerStats`**

`refreshPlayerStats` is around line 344. It currently sets `player.wins` and `player.gamesPlayed`. Add `player.elo`:

```typescript
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
```

- [ ] **Step 2: Include `elo` in `buildStateMessage` player mapping**

`buildStateMessage` (around line 259) maps players. Add `elo`:

```typescript
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
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: 28 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/game-room.ts
git commit -m "feat: expose player elo in lobby state"
```

---

### Task 3: Render ELO in the lobby

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Update `statsHtml` in `renderLobby`**

In `renderLobby` (around line 902), the `statsHtml` line currently reads:

```javascript
    const statsHtml = (!p.isBot && p.gamesPlayed)
      ? `<span class="lobby-stats">${p.wins}W / ${p.gamesPlayed}G</span>`
      : '';
```

Replace with:

```javascript
    const eloStr = (!p.isBot && p.elo) ? `ELO ${p.elo} · ` : '';
    const statsHtml = (!p.isBot && p.gamesPlayed)
      ? `<span class="lobby-stats">${eloStr}${p.wins}W / ${p.gamesPlayed}G</span>`
      : '';
```

- [ ] **Step 2: Syntax check**

```bash
node --check static/app.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add static/app.js
git commit -m "feat: show ELO in lobby player list"
```

---

## Manual Verification

Run `npm run dev` and join a lobby with a Telegram-authenticated player who has played games.

- [ ] Lobby shows `ELO 1042 · 3W / 9G` for players with stats
- [ ] Bots show no ELO or stats
- [ ] Players with zero games played show no stats (same as before)
- [ ] ELO updates after a game if the player plays again (refreshPlayerStats re-fetches on reconnect/rejoin)
