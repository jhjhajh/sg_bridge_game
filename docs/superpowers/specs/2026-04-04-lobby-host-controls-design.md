# Lobby Host Controls Design

**Date:** 2026-04-04  
**Status:** Approved

## Overview

Add host controls to the game lobby: kick players, block guests from playing, and introduce a 5-second countdown with a "Start Game" button before the game begins. The primary motivation is that nameless/broken players sometimes join due to auth/cookie issues, forcing everyone to remake the room.

## Goals

- Host (seat 0) can kick any non-host player in the lobby
- Guests (non-Telegram authenticated users) cannot join as players
- When 4 players are in the lobby, a 5-second countdown starts before the game auto-begins
- Host can skip the countdown by clicking "Start Game"
- Kicked player is notified and returned to the home screen; the slot is freed for anyone to rejoin

## Non-Goals

- Kicking during an active game (lobby only)
- Permanent bans or per-room blocklists
- Spectator-only mode for guests (they are blocked entirely)

## Protocol Changes (`src/protocol.ts`)

### New client messages

```typescript
| { type: 'kickPlayer'; seat: number }
| { type: 'startGame' }
```

### New server messages

```typescript
| { type: 'kicked'; reason: string }           // sent only to the kicked player
| { type: 'playerKicked'; seat: number; name: string }  // broadcast to room
```

## Data Model

### `GameState` (`src/types.ts`)

Add one field:

```typescript
gameStartAt: number | null;  // Unix ms timestamp when game will auto-start; null when not counting down
```

## Backend (`src/game-room.ts`)

### Guest block

At the top of `handleJoin`, before any other checks:

```typescript
if (!playerId.startsWith('tg_')) {
  ws.send(JSON.stringify({ type: 'error', message: 'You must log in with Telegram to play.' }));
  return;
}
```

### Countdown on 4th player join

Replace the current auto-start block (`if (state.players.length === NUM_PLAYERS)`) with:

```typescript
if (state.players.length === NUM_PLAYERS) {
  state.gameStartAt = Date.now() + 5000;
  await this.ctx.storage.setAlarm(state.gameStartAt);
  await this.saveState(state);
  this.broadcastState(state);
  return;
}
```

### `handleKickPlayer(state, requestorId, targetSeat)`

Guards (silently return if any fail):
- `state.phase === 'lobby'`
- Requestor is seat 0 (host)
- `targetSeat !== 0` (can't kick host)
- Target player exists in `state.players`

Steps:
1. Find target player; send `{ type: 'kicked', reason: 'You were removed by the host.' }` to their WebSocket, then close it
2. Remove target from `state.players`
3. Re-index remaining players: re-assign `seat` sequentially (0, 1, 2, ...)
4. Cancel countdown if active: `state.gameStartAt = null; await this.ctx.storage.deleteAlarm()`
5. Broadcast `{ type: 'playerKicked', seat: targetSeat, name: targetName }` to all remaining connections
6. Broadcast updated state

### `handleStartGame(state, requestorId)`

Guards:
- `state.phase === 'lobby'`
- Requestor is seat 0
- `state.players.length === NUM_PLAYERS`

Steps:
1. `await this.ctx.storage.deleteAlarm()`
2. `state.gameStartAt = null`
3. Call existing game-start logic (set phase to bidding, generate hands, etc.)

### Alarm handler (`alarm()`)

Differentiate countdown alarm from inactivity cleanup:

```typescript
async alarm(): Promise<void> {
  const state = await this.loadState();
  if (!state) return;

  if (state.gameStartAt !== null && Date.now() >= state.gameStartAt - 100) {
    // Countdown elapsed — start game if still 4 players
    state.gameStartAt = null;
    if (state.players.length === NUM_PLAYERS && state.phase === 'lobby') {
      // existing game-start logic
    }
    await this.saveState(state);
    return;
  }

  // Existing inactivity cleanup logic
  if (state.players.every((p) => !p.connected)) {
    // purge storage
  }
}
```

## Frontend (`static/app.js`)

### `renderLobby(s)`

- When `isHost && p.seat !== 0`: render a kick button per player
  ```html
  <button class="kick-btn" onclick="send({type:'kickPlayer',seat:${p.seat}})">✕</button>
  ```
- When `s.players.length === NUM_PLAYERS && s.gameStartAt`:
  - Show countdown: `<span id="lobby-countdown">Starting in X...</span>` (updated by `requestAnimationFrame` loop using `s.gameStartAt - Date.now()`)
  - Show "Start Game" button for host: `<button onclick="send({type:'startGame'})">Start Game</button>`
- When `s.players.length < NUM_PLAYERS`: hide countdown and start button

### `handleMessage(msg)`

- `kicked`: show toast/alert ("You were removed by the host."), navigate to home screen
- `playerKicked`: no manual re-render needed — server broadcasts updated `state` message which triggers `renderLobby`

## Styling (`static/style.css`)

- `.kick-btn`: small, muted red ✕ button — similar styling to `.bot-remove-btn` but red tint
- `#lobby-countdown`: muted status text, same style as `#lobby-status`
- `#lobby-start-btn`: primary green button, shown only to host when 4 players present

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `src/protocol.ts` | Add `kickPlayer`, `startGame` client messages; `kicked`, `playerKicked` server messages |
| Modify | `src/types.ts` | Add `gameStartAt: number \| null` to `GameState` |
| Modify | `src/game-room.ts` | Guest block in `handleJoin`; replace auto-start with countdown; add `handleKickPlayer`, `handleStartGame`; update `alarm()` |
| Modify | `static/app.js` | Kick buttons in `renderLobby`; countdown display; handle `kicked` + `playerKicked` messages |
| Modify | `static/style.css` | Style `.kick-btn`, `#lobby-countdown`, `#lobby-start-btn` |
| Modify | `static/index.html` | Add `#lobby-countdown` and `#lobby-start-btn` elements to lobby screen |
