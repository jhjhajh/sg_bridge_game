# Lobby ELO Display Design

**Goal:** Show each player's ELO rating in the lobby player list alongside existing wins/games stats.

**Date:** 2026-04-04

---

## Design

### Backend

1. Add `elo?: number` to the `Player` interface in `src/types.ts`.
2. In `src/game-room.ts`, `handleJoin` already calls `getUser(env.DB, playerId)` and copies `wins` and `gamesPlayed` onto the player object. Add `elo` from the same `getUser` result.
3. In `buildStateMessage`, the player mapping already includes `wins` and `gamesPlayed`. Add `elo` to the same mapping so it reaches the client.

### Frontend

In `renderLobby` (`static/app.js`), the `statsHtml` block currently renders `${p.wins}W / ${p.gamesPlayed}G`. Update it to prepend ELO when available:

```
ELO 1042 · 3W / 9G
```

- Skip ELO for bots (they have no ELO).
- If `p.elo` is undefined (player has never played), show only `W / G` as before.
- No new CSS classes needed — reuse `.lobby-stats`.

### Data flow

`users.elo` (D1) → `getUser` result → `Player.elo` → `buildStateMessage` → `PlayerGameView.players[].elo` → `renderLobby`

---

## Out of Scope

- Showing ELO during gameplay or on the game-over screen (separate feature).
- ELO tooltips or history.
