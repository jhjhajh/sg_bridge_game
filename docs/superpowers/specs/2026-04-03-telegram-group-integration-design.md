# Telegram Group Integration Design

## Goal

When a Telegram bot command `/newgame` is sent in a group chat, the bot creates a game room linked to that group, posts the join link, and subsequently posts game events (start, bid won, game over) back into the group. Each group maintains its own leaderboard, scoped to verified group members. The existing global leaderboard is unchanged.

## Architecture

**Approach:** Webhook-first with a shared `src/telegram.ts` helper module. All Telegram API calls (outgoing notifications, membership checks, webhook parsing) are centralised in `telegram.ts`. `game-room.ts` and `index.ts` import it.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1 (SQLite), Telegram Bot API

---

## Data Model

### New D1 migrations

**`migrations/0003_groups.sql`**
```sql
CREATE TABLE IF NOT EXISTS groups (
  group_id   TEXT    PRIMARY KEY,  -- Telegram chat ID (negative integer, stored as text)
  group_name TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_stats (
  group_id     TEXT    NOT NULL,
  telegram_id  INTEGER NOT NULL,
  wins         INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, telegram_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
```

### `GameState` additions (`src/types.ts`)
```typescript
groupId: string | null;   // null for web-only games
```

### `Player` addition (`src/types.ts`)
```typescript
isGroupMember?: boolean;  // undefined for non-group games or guests
```

### `PlayerGameView` addition (`src/types.ts`)
```typescript
isGroupMember?: boolean;
```

---

## `src/telegram.ts` — Shared Helper Module

Three pure async functions, no state:

### `sendMessage(token, chatId, text)`
POST to `https://api.telegram.org/bot{token}/sendMessage`. Fire-and-forget — errors logged but not thrown (notifications are non-critical).

### `isChatMember(token, chatId, userId) → Promise<boolean>`
Calls `getChatMember`. Returns `true` for status `member | administrator | creator`. Returns `false` for `left | kicked | restricted`, not found, or any API error. Fails safe — unknown = treated as non-member.

### `parseUpdate(body) → TelegramCommand | null`
```typescript
interface TelegramCommand {
  command: 'newgame' | 'leaderboard';
  chatId: string;
  groupName: string;
  fromUserId: number;
  fromUsername: string;
}
```
Parses Telegram Update JSON. Returns `null` for:
- Non-group messages (private chats)
- Non-command messages
- Commands other than `/newgame` and `/leaderboard`

---

## `src/db.ts` — New Queries

### `upsertGroup(db, groupId, groupName)`
INSERT OR REPLACE into `groups`.

### `recordGroupResult(db, groupId, players, winnerSeats)`
Same signature pattern as `recordGameResult`. Only processes players where `player.isGroupMember === true` and `player.id.startsWith('tg_')`. Updates `group_stats` (INSERT ON CONFLICT UPDATE).

### `getGroupLeaderboard(db, groupId, telegramId?) → { top: LeaderboardEntry[], me: ... | null }`
Same shape as existing `getLeaderboard`. Queries `group_stats JOIN users` filtered by `group_id`. Top 5 by wins. Optionally includes caller's rank if outside top 5.

---

## `src/index.ts` — New and Updated Routes

### `POST /api/telegram` (new — webhook endpoint)

No auth required (Telegram calls this). Responds 200 immediately.

**`/newgame` handling:**
1. `parseUpdate(body)` → extract chatId, groupName, fromUsername
2. `upsertGroup(db, chatId, groupName)`
3. Generate 4-char room code (same logic as `POST /api/create`)
4. Provision Durable Object with `{ roomCode, groupId: chatId }`
5. `sendMessage(token, chatId, "🃏 @{username} started a new game!\nJoin → https://{origin}/#{roomCode}")`
   — `origin` is derived from the incoming webhook request URL (`new URL(request.url).origin`)

**`/leaderboard` handling:**
1. `parseUpdate(body)` → extract chatId
2. `getGroupLeaderboard(db, chatId)`
3. Format and `sendMessage`:
```
🏆 Group Leaderboard
🥇 Alice — 12W / 20G
🥈 Bob — 9W / 15G
...
```
If no stats yet: "No games played in this group yet!"

### `GET /api/leaderboard` (updated)
- If `?groupId=` param present → `getGroupLeaderboard(db, groupId, telegramId?)`
- If no param → existing global query (unchanged)

---

## `src/game-room.ts` — Changes

### Room creation
`POST /create` handler accepts `{ roomCode, groupId }`. Stores `groupId` in initial `GameState`.

### `handleJoin` — membership check
When a player joins and `state.groupId` is set and player has a `tg_` ID:
- Call `isChatMember(token, state.groupId, telegramId)`
- Set `player.isGroupMember = result`
- Non-members join and play normally; stats won't count

### Notifications (when `state.groupId` is set)
All via `sendMessage(token, state.groupId, ...)`:

| Trigger | Message |
|---|---|
| 4th player joins (game starts) | `🎮 Game started!\nPlayers: Alice, Bob, Charlie, Dave` |
| Bid won (`finalizeBidding`) | `🔨 Bob bid 3♠` |
| Game over — bidder wins | `🏆 Bob & Alice won!\nBid 3♠, made 9/9 tricks` |
| Game over — opposition wins | `🛡️ Charlie & Dave defended!\nBob's 3♠ bid failed` |

### Game-over stats
Call `recordGroupResult(db, state.groupId, state.players, winnerSeats)` in addition to existing `recordGameResult` call.

### `buildStateMessage`
Include `isGroupMember` in the `PlayerGameView` players array and as a top-level field for the current player.

---

## Frontend (`static/app.js`, `static/style.css`)

### Lobby screen
Players with `isGroupMember === false` show a `⚠️ not ranked` badge next to their name.

### Game-over screen
If `gameState.groupId` is set, show a group leaderboard section fetched from `GET /api/leaderboard?groupId={groupId}`. Reuses existing leaderboard rendering logic.

### Home screen
Global leaderboard unchanged.

---

## Webhook Registration

One-time setup after deploy:
```bash
curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://{worker-domain}/api/telegram"
```

Document in README under "Setup".

---

## Error Handling

- Telegram API calls in `sendMessage` are fire-and-forget — game flow never blocks on notifications
- `isChatMember` errors → false (non-member treatment), game continues
- `/api/telegram` always returns 200 to Telegram, even on internal errors (prevents Telegram retry storms)
- Non-group `/newgame` (sent in DM): `parseUpdate` returns null → 200 with no action

---

## Out of Scope

- Bot admin commands (e.g. `/kick`, `/settings`)
- Per-group configuration (custom bot behaviour per group)
- Removing a group or resetting group stats
- Notifications for spectators
- Play Again resets game state but retains `groupId` — group context persists across rematches in the same room
