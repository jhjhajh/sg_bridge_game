# Lobby Host Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host kick, Telegram-only login enforcement, and a 5-second countdown with a "Start Game" button to the game lobby.

**Architecture:** All lobby state lives in the Durable Object (`game-room.ts`). A new `gameStartAt` timestamp on `GameState` drives the countdown; a DO alarm fires after 5 seconds to auto-start. Kick removes a player from state and re-indexes seats. Guest enforcement is a single check at the top of `handleJoin`. Frontend renders kick buttons, countdown timer, and start button based on `PlayerGameView`.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vanilla JS SPA, Vitest

---

## File Map

| File | Change |
|------|--------|
| `src/protocol.ts` | Add `kickPlayer`, `startGame` client messages; `kicked`, `playerKicked` server messages |
| `src/types.ts` | Add `gameStartAt: number \| null` to `GameState` and `PlayerGameView` |
| `src/game-room.ts` | Guest block in `handleJoin`; extract `startGameFromLobby`; countdown logic; update `alarm()` and `webSocketClose()`; add `handleKickPlayer`, `handleStartGame` |
| `static/index.html` | Add `#lobby-countdown` and `#lobby-start-btn` to lobby screen |
| `static/app.js` | Kick buttons in `renderLobby`; countdown display; start button; handle `kicked`/`playerKicked` messages |
| `static/style.css` | Style `.kick-btn`, `#lobby-countdown`, `#lobby-start-btn` |

---

### Task 1: Protocol and type definitions

**Files:**
- Modify: `src/protocol.ts:3-30`
- Modify: `src/types.ts` (GameState and PlayerGameView interfaces)

- [ ] **Step 1: Update `src/protocol.ts`**

Replace the entire file with:

```typescript
import type { PlayerGameView, Suit } from './types';

export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'bid'; bidNum: number }
  | { type: 'pass' }
  | { type: 'selectPartner'; card: string }
  | { type: 'playCard'; card: string }
  | { type: 'playAgain' }
  | { type: 'watchSeat'; seat: number }
  | { type: 'addBot' }
  | { type: 'removeBot' }
  | { type: 'kickPlayer'; seat: number }
  | { type: 'startGame' };

export type ServerMessage =
  | { type: 'state'; state: PlayerGameView }
  | { type: 'error'; message: string }
  | { type: 'joined'; playerName: string; seat: number; playerCount: number }
  | { type: 'gameStart'; turn: number }
  | { type: 'bidMade'; seat: number; bidNum: number; name: string }
  | { type: 'passed'; seat: number; name: string }
  | { type: 'bidWon'; seat: number; bidNum: number; setsNeeded: number; name: string }
  | { type: 'allPassed' }
  | { type: 'partnerSelected'; card: string }
  | { type: 'youArePartner'; bidderName: string }
  | { type: 'playPhaseStart'; turn: number; firstPlayerName: string }
  | { type: 'cardPlayed'; seat: number; card: string; nextTurn: number }
  | { type: 'trickWon'; winnerSeat: number; sets: number[]; nextTurn: number; winnerName: string; trickCards: (string | null)[] }
  | { type: 'gameOver'; bidderWon: boolean; winnerNames: string[] }
  | { type: 'playerDisconnected'; seat: number; name: string }
  | { type: 'playerReconnected'; seat: number; name: string }
  | { type: 'kicked'; reason: string }
  | { type: 'playerKicked'; seat: number; name: string };
```

- [ ] **Step 2: Add `gameStartAt` to `GameState` in `src/types.ts`**

In the `GameState` interface, add after the `groupId` field:

```typescript
  gameStartAt: number | null;
```

- [ ] **Step 3: Add `gameStartAt` to `PlayerGameView` in `src/types.ts`**

In the `PlayerGameView` interface, add after the `groupId` field:

```typescript
  gameStartAt: number | null;
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: errors only about `gameStartAt` not being set in `createInitialState` and `buildStateMessage` (fixed in Task 2). If there are other errors, fix them first.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/types.ts
git commit -m "feat: add kickPlayer/startGame protocol messages and gameStartAt type"
```

---

### Task 2: Backend — guest block, startGameFromLobby helper, countdown

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add guest block at top of `handleJoin`**

In `src/game-room.ts`, `handleJoin` starts at line 335. The first line of the method body is:
```typescript
    const existing = state.players.find((p) => p.id === playerId);
```

Add the guest check immediately before that line:

```typescript
    if (!playerId.startsWith('tg_')) {
      ws.send(JSON.stringify({ type: 'error', message: 'You must log in with Telegram to play.' }));
      return;
    }

    const existing = state.players.find((p) => p.id === playerId);
```

- [ ] **Step 2: Add `gameStartAt: null` to `createInitialState`**

In `createInitialState` (around line 186), the return object ends with `groupId`. Add:

```typescript
      groupId,
      gameStartAt: null,
```

- [ ] **Step 3: Add `gameStartAt` to `buildStateMessage`**

In `buildStateMessage` (around line 222), the `view` object is built. After `isGroupMember: player?.isGroupMember,`, add:

```typescript
      isGroupMember: player?.isGroupMember,
      gameStartAt: state.gameStartAt,
```

- [ ] **Step 4: Extract `startGameFromLobby` private method**

Add this new private method before `handleAddBot` (just before line 1184):

```typescript
  private async startGameFromLobby(state: GameState): Promise<void> {
    state.gameStartAt = null;
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
```

- [ ] **Step 5: Replace auto-start block in `handleJoin` with countdown**

Find this block in `handleJoin` (around lines 402–425):

```typescript
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
      if (state.groupId) {
        const names = state.players.map((p) => p.name).join(', ');
        sendMessage(
          (this.env as Env).TELEGRAM_BOT_TOKEN,
          state.groupId,
          `🎮 Game started!\nPlayers: ${names}`,
        ).catch(() => {});
      }
      this.ctx.waitUntil(this.scheduleBotAction());
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
    }
```

Replace with:

```typescript
    if (state.players.length === NUM_PLAYERS) {
      state.gameStartAt = Date.now() + 5000;
      await this.ctx.storage.setAlarm(state.gameStartAt);
    }
    await this.saveState(state);
    this.broadcastFullState(state);
```

- [ ] **Step 6: Replace auto-start block in `handleAddBot` with countdown**

Find this block in `handleAddBot` (around lines 1209–1231):

```typescript
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
      if (state.groupId) {
        const names = state.players.map((p) => p.name).join(', ');
        sendMessage(
          (this.env as Env).TELEGRAM_BOT_TOKEN,
          state.groupId,
          `🎮 Game started!\nPlayers: ${names}`,
        ).catch(() => {});
      }
      this.ctx.waitUntil(this.scheduleBotAction());
    } else {
      await this.saveState(state);
      this.broadcastFullState(state);
    }
```

Replace with:

```typescript
    if (state.players.length === NUM_PLAYERS) {
      state.gameStartAt = Date.now() + 5000;
      await this.ctx.storage.setAlarm(state.gameStartAt);
    }
    await this.saveState(state);
    this.broadcastFullState(state);
```

- [ ] **Step 7: Update `alarm()` to handle countdown alarm**

Replace the existing `alarm()` method (lines 175–182):

```typescript
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected) {
      await this.ctx.storage.deleteAll();
    }
  }
```

With:

```typescript
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;

    // Countdown alarm — auto-start game when 5 seconds elapse
    if (state.gameStartAt !== null && Date.now() >= state.gameStartAt - 100) {
      state.gameStartAt = null;
      if (state.phase === 'lobby' && state.players.length === NUM_PLAYERS) {
        const anyConnected = state.players.some((p) => p.connected);
        if (anyConnected) {
          await this.startGameFromLobby(state);
          return;
        }
      }
      // Countdown fired but couldn't start — schedule cleanup
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
```

- [ ] **Step 8: Update `webSocketClose` to not overwrite an active countdown alarm**

In `webSocketClose` (around line 165–168), find:

```typescript
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
```

Replace with:

```typescript
    const anyConnected = state.players.some((p) => p.connected);
    if (!anyConnected && !state.gameStartAt) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
```

- [ ] **Step 9: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/game-room.ts
git commit -m "feat: guest block, startGameFromLobby helper, 5-second lobby countdown"
```

---

### Task 3: Backend — handleKickPlayer and handleStartGame

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `handleKickPlayer` method**

Add this method immediately after `handleRemoveBot` (after line 1246, before the closing `}`):

```typescript
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
```

- [ ] **Step 2: Add `handleStartGame` method**

Add immediately after `handleKickPlayer`:

```typescript
  private async handleStartGame(state: GameState, requestorId: string): Promise<void> {
    if (state.phase !== 'lobby') return;
    const requestor = state.players.find((p) => p.id === requestorId);
    if (!requestor || requestor.seat !== 0) return;
    if (state.players.length !== NUM_PLAYERS) return;

    await this.ctx.storage.deleteAlarm();
    await this.startGameFromLobby(state);
  }
```

- [ ] **Step 3: Wire up new cases in the `webSocketMessage` switch**

In the `switch (msg.type)` block (around line 108), add after the `removeBot` case:

```typescript
      case 'kickPlayer':
        await this.handleKickPlayer(state, session.playerId, msg.seat);
        break;
      case 'startGame':
        await this.handleStartGame(state, session.playerId);
        break;
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/game-room.ts
git commit -m "feat: handleKickPlayer and handleStartGame backend handlers"
```

---

### Task 4: Frontend HTML — countdown and start button elements

**Files:**
- Modify: `static/index.html:78-82`

- [ ] **Step 1: Add `#lobby-countdown` and `#lobby-start-btn` to the lobby screen**

Find the lobby screen section (lines 78–82):

```html
      <div id="lobby-players" class="player-list"></div>
      <p id="lobby-status" class="status-text">Waiting for players...</p>
      <button id="lobby-add-bot" class="btn btn-ghost btn-small hidden" onclick="send({type:'addBot'})">🤖 Add Bot</button>
```

Replace with:

```html
      <div id="lobby-players" class="player-list"></div>
      <p id="lobby-status" class="status-text">Waiting for players...</p>
      <p id="lobby-countdown" class="status-text hidden"></p>
      <button id="lobby-add-bot" class="btn btn-ghost btn-small hidden" onclick="send({type:'addBot'})">🤖 Add Bot</button>
      <button id="lobby-start-btn" class="btn btn-primary hidden" onclick="send({type:'startGame'})">Start Game</button>
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: add countdown and start game elements to lobby HTML"
```

---

### Task 5: Frontend JS — renderLobby, countdown, kick buttons, message handling

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Update `renderLobby` — replace bot-remove-btn with kick-btn for all non-host players**

Find this block in `renderLobby` (around lines 900–904):

```javascript
    const isLastBot = p.isBot && p.seat === s.players.length - 1;
    const removeBtn = (isHost && isLastBot)
      ? `<button class="bot-remove-btn" onclick="send({type:'removeBot'})">✕</button>`
      : '';
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span>${statusDot(p.connected)}${botIcon}<span class="lobby-player-name">${esc(p.name)}</span>${statsHtml}${notRankedBadge}${removeBtn}`;
```

Replace with:

```javascript
    const kickBtn = (isHost && p.seat !== 0)
      ? `<button class="kick-btn" onclick="send({type:'kickPlayer',seat:${p.seat}})">✕</button>`
      : '';
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span>${statusDot(p.connected)}${botIcon}<span class="lobby-player-name">${esc(p.name)}</span>${statsHtml}${notRankedBadge}${kickBtn}`;
```

- [ ] **Step 2: Update `renderLobby` — add countdown display and start button logic**

Find this block at the end of `renderLobby` (around lines 907–919):

```javascript
  const remaining = NUM_PLAYERS - s.players.length;
  $('lobby-status').textContent = remaining > 0
    ? `Waiting for ${remaining} more player(s)...`
    : 'Game starting...';

  const addBotBtn = $('lobby-add-bot');
  if (addBotBtn) {
    if (isHost && remaining > 0) {
      addBotBtn.classList.remove('hidden');
    } else {
      addBotBtn.classList.add('hidden');
    }
  }
}
```

Replace with:

```javascript
  const remaining = NUM_PLAYERS - s.players.length;

  const countdownEl = $('lobby-countdown');
  const startBtn = $('lobby-start-btn');
  const statusEl = $('lobby-status');

  if (remaining === 0 && s.gameStartAt) {
    const secsLeft = Math.max(0, Math.ceil((s.gameStartAt - Date.now()) / 1000));
    countdownEl.textContent = `Game starting in ${secsLeft}...`;
    countdownEl.classList.remove('hidden');
    statusEl.classList.add('hidden');
    if (isHost) {
      startBtn.classList.remove('hidden');
    } else {
      startBtn.classList.add('hidden');
    }
    if (secsLeft > 0) {
      setTimeout(() => { if (gameState && gameState.phase === 'lobby') renderLobby(gameState); }, 500);
    }
  } else {
    countdownEl.classList.add('hidden');
    startBtn.classList.add('hidden');
    statusEl.classList.remove('hidden');
    statusEl.textContent = remaining > 0
      ? `Waiting for ${remaining} more player(s)...`
      : 'Game starting...';
  }

  const addBotBtn = $('lobby-add-bot');
  if (addBotBtn) {
    if (isHost && remaining > 0) {
      addBotBtn.classList.remove('hidden');
    } else {
      addBotBtn.classList.add('hidden');
    }
  }
}
```

- [ ] **Step 3: Add `kicked` and `playerKicked` cases to `handleMessage`**

In `handleMessage` (around line 659), find the `playerDisconnected` case:

```javascript
    case 'playerDisconnected':
      showConnectionToast(`${msg.name} disconnected`);
```

Add the new cases immediately before `playerDisconnected`:

```javascript
    case 'kicked':
      alert(msg.reason || 'You were removed from the room.');
      leaveGame();
      break;
    case 'playerKicked':
      // State update follows from the server's broadcastFullState — no manual action needed
      break;
    case 'playerDisconnected':
      showConnectionToast(`${msg.name} disconnected`);
```

- [ ] **Step 4: Run typecheck (not applicable — JS file) — do a quick syntax check**

Open `static/app.js` in the editor and verify there are no obvious syntax errors around the edited sections. Alternatively:

```bash
node --check static/app.js
```

Expected: no output (no syntax errors).

- [ ] **Step 5: Commit**

```bash
git add static/app.js
git commit -m "feat: lobby kick buttons, countdown display, startGame and kicked message handling"
```

---

### Task 6: Frontend CSS — kick button, countdown, start button styles

**Files:**
- Modify: `static/style.css`

- [ ] **Step 1: Add `.kick-btn` style after `.bot-remove-btn` block**

Find the `.bot-remove-btn:hover` rule (around line 1163–1165):

```css
.bot-remove-btn:hover {
  background: rgba(255, 68, 87, 0.15);
}
```

Add immediately after:

```css
.kick-btn {
  background: none;
  border: 1px solid rgba(255, 68, 87, 0.3);
  color: var(--danger);
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  margin-left: auto;
  transition: background var(--transition);
}
.kick-btn:hover {
  background: rgba(255, 68, 87, 0.15);
}
```

- [ ] **Step 2: Add `#lobby-start-btn` style**

After the `.kick-btn:hover` block, add:

```css
#lobby-start-btn {
  width: 100%;
  margin-top: 0.75rem;
}
```

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "feat: kick-btn and start-game button styles"
```

---

## Manual Test Plan

Run `npm run dev` and open the game in two browser windows.

**Guest block:**
- [ ] Open the game without Telegram auth (as a guest). Attempt to join a room. Verify you see the error alert: "You must log in with Telegram to play."

**Countdown:**
- [ ] Fill a room with 4 players (use Add Bot to fill). Verify the lobby shows "Game starting in 5..." counting down.
- [ ] Verify the "Start Game" button appears only for the host (seat 1).
- [ ] Wait for countdown to reach 0. Verify the game transitions to bidding automatically.

**Start Game button:**
- [ ] Fill a room with 4 players. Click "Start Game" as the host. Verify the game starts immediately without waiting for countdown.
- [ ] Verify non-host players do NOT see the "Start Game" button.

**Kick player:**
- [ ] Open two browser windows. Window 1 creates a room (host), Window 2 joins.
- [ ] In Window 1, verify a ✕ button appears next to Window 2's player name but NOT next to the host row.
- [ ] Click ✕ to kick Window 2's player. Verify Window 2 sees an alert "You were removed by the host." and is returned to the home screen.
- [ ] Verify Window 1's lobby updates to show only 1 player (seat re-indexed to seat 1).
- [ ] Verify Window 2 can rejoin the same room code.

**Kick during countdown:**
- [ ] Fill a room with 4 players. During countdown, kick one player. Verify countdown stops and lobby returns to waiting state.
