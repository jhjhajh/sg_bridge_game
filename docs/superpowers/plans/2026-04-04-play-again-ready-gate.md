# Play Again Ready Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require all 4 players to click "Play Again" before the next game starts, instead of any one player immediately starting it for everyone.

**Architecture:** Add `readySeats: number[]` to `GameState` and `PlayerGameView`. Rework `handlePlayAgain` to accumulate ready seats — only transitioning to `phase = 'lobby'` (with a 5-second countdown) when all 4 are ready. Bots auto-ready via `triggerBotAction`. The gameover screen shows who's ready and disables the button once clicked.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vanilla JS

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `readySeats: number[]` to `GameState` and `PlayerGameView` |
| `src/game-room.ts` | Init field; reset on gameover; rework `handlePlayAgain`; add bot auto-ready in `triggerBotAction`; expose in `buildStateMessage` |
| `static/index.html` | Add ready list div and countdown para to gameover screen |
| `static/app.js` | Update `renderGameOver` to show ready status, countdown, and disabled button |

---

### Task 1: Add readySeats to types and initialize

**Files:**
- Modify: `src/types.ts`
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `readySeats` to `GameState` in `src/types.ts`**

Read `src/types.ts`. The `GameState` interface ends with `gameId: string;`. Add after it:

```typescript
  gameId: string;
  readySeats: number[];
```

- [ ] **Step 2: Add `readySeats` to `PlayerGameView` in `src/types.ts`**

The `PlayerGameView` interface ends with `spectators: { name: string; watchingSeat: number }[];`. Add after it:

```typescript
  spectators: { name: string; watchingSeat: number }[];
  readySeats: number[];
```

- [ ] **Step 3: Initialize `readySeats` in `createInitialState` in `src/game-room.ts`**

Read `src/game-room.ts`. Find `createInitialState` (around line 210). It ends with:

```typescript
      partnerRevealed: false,
      gameId: crypto.randomUUID(),
    };
```

Replace with:

```typescript
      partnerRevealed: false,
      gameId: crypto.randomUUID(),
      readySeats: [],
    };
```

- [ ] **Step 4: Reset `readySeats = []` when game ends**

In `src/game-room.ts`, `handlePlayCard` sets `state.phase = 'gameover'` in two places (bidder wins and bidder loses). Both look like:

```typescript
        state.phase = 'gameover';
```

After each of those two assignments, add:

```typescript
        state.phase = 'gameover';
        state.readySeats = [];
```

Search for `state.phase = 'gameover'` (there are exactly 2 occurrences in `handlePlayCard`) and add the reset after each.

- [ ] **Step 5: Expose `readySeats` in `buildStateMessage` in `src/game-room.ts`**

`buildStateMessage` builds the view object. It currently ends with:

```typescript
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
    };
```

Replace with:

```typescript
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
      readySeats: state.readySeats,
    };
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

Expected: 28 tests pass.

- [ ] **Step 8: Commit**

```bash
cd G:/sg_bridge_game && git add src/types.ts src/game-room.ts && git commit -m "feat: add readySeats to GameState and PlayerGameView"
```

---

### Task 2: Rework handlePlayAgain and add bot auto-ready

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Replace `handlePlayAgain` with ready-gate version**

Find `handlePlayAgain` (around line 866). Replace the entire method with:

```typescript
  private async handlePlayAgain(
    state: GameState,
    playerId: string,
  ): Promise<void> {
    if (state.phase !== 'gameover') return;

    const player = state.players.find((p) => p.id === playerId);
    if (!player) return; // spectator or unknown — ignore

    if (state.readySeats.includes(player.seat)) return; // already ready

    state.readySeats = [...state.readySeats, player.seat];

    if (state.readySeats.length < NUM_PLAYERS) {
      await this.saveState(state);
      this.broadcastFullState(state);
      return;
    }

    // All players ready — transition to lobby with countdown
    state.readySeats = [];
    state.phase = 'lobby';
    state.gameStartAt = Date.now() + 5000;
    await this.ctx.storage.setAlarm(state.gameStartAt);
    await this.saveState(state);
    this.broadcastFullState(state);
  }
```

- [ ] **Step 2: Add bot auto-ready in `triggerBotAction`**

Find `triggerBotAction` (around line 949). It currently handles `bidding`, `partner`, and `play` phases. Add a `gameover` handler at the top (before the `bidding` check):

```typescript
  private async triggerBotAction(state: GameState): Promise<boolean> {
    if (state.phase === 'gameover') {
      const unreadyBot = state.players.find((p) => p.isBot && !state.readySeats.includes(p.seat));
      if (unreadyBot) {
        await this.handlePlayAgain(state, unreadyBot.id);
        return true;
      }
      return false;
    }
    if (state.phase === 'bidding') {
```

- [ ] **Step 3: Run typecheck**

```bash
cd G:/sg_bridge_game && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd G:/sg_bridge_game && npm test
```

Expected: 28 tests pass.

- [ ] **Step 5: Commit**

```bash
cd G:/sg_bridge_game && git add src/game-room.ts && git commit -m "feat: ready-gate play again — all players must click before game restarts"
```

---

### Task 3: Gameover screen ready UI

**Files:**
- Modify: `static/index.html`
- Modify: `static/app.js`

- [ ] **Step 1: Add ready list and countdown to gameover HTML**

Read `static/index.html`. Find the gameover screen (around line 169):

```html
      <div class="gameover-actions">
        <button id="btn-play-again" class="btn btn-primary">Play Again</button>
      </div>
```

Replace with:

```html
      <div id="gameover-ready-list" class="gameover-ready-list"></div>
      <p id="gameover-countdown" class="status-text hidden"></p>
      <div class="gameover-actions">
        <button id="btn-play-again" class="btn btn-primary">Play Again</button>
      </div>
```

- [ ] **Step 2: Update `renderGameOver` in `static/app.js` to show ready status**

Read `static/app.js`. Find `renderGameOver` (around line 1196). After the closing `}` of the scores loop (`scores.appendChild(item);` block), add the ready list rendering. Find this block near the end of `renderGameOver`:

```javascript
  const groupLbEl = $('gameover-group-lb');
  if (groupLbEl) groupLbEl.innerHTML = '';
  if (s.groupId) {
    renderGroupLeaderboard(s.groupId);
  }
}
```

Replace with:

```javascript
  const groupLbEl = $('gameover-group-lb');
  if (groupLbEl) groupLbEl.innerHTML = '';
  if (s.groupId) {
    renderGroupLeaderboard(s.groupId);
  }

  // Ready list
  const readyList = $('gameover-ready-list');
  if (readyList) {
    const readySeats = s.readySeats ?? [];
    readyList.innerHTML = s.players.map((p) =>
      `<span class="gameover-ready-player${readySeats.includes(p.seat) ? ' ready' : ''}">
        ${readySeats.includes(p.seat) ? '✓' : '○'} ${esc(p.name)}
      </span>`
    ).join('');
  }

  // Play Again button state
  const playAgainBtn = $('btn-play-again');
  const readySeats = s.readySeats ?? [];
  const iAmReady = !s.isSpectator && readySeats.includes(s.mySeat);
  if (playAgainBtn) {
    playAgainBtn.disabled = iAmReady || s.isSpectator;
    playAgainBtn.textContent = iAmReady ? 'Waiting...' : 'Play Again';
  }

  // Countdown (reuses same pattern as lobby)
  const countdownEl = $('gameover-countdown');
  if (countdownEl) {
    if (s.gameStartAt) {
      countdownEl.classList.remove('hidden');
      clearTimeout(gameoverCountdownTimer);
      const tick = () => {
        const rem = Math.ceil((s.gameStartAt - Date.now()) / 1000);
        if (rem <= 0) { countdownEl.textContent = 'Starting...'; return; }
        countdownEl.textContent = `Starting in ${rem}s...`;
        gameoverCountdownTimer = setTimeout(tick, 500);
      };
      tick();
    } else {
      countdownEl.classList.add('hidden');
      clearTimeout(gameoverCountdownTimer);
    }
  }
}
```

- [ ] **Step 3: Add `gameoverCountdownTimer` module-level variable**

Near the top of `static/app.js`, find the existing `lobbyCountdownTimer` declaration:

```javascript
let lobbyCountdownTimer = null;
```

Add a line after it:

```javascript
let lobbyCountdownTimer = null;
let gameoverCountdownTimer = null;
```

- [ ] **Step 4: Add CSS for `.gameover-ready-list` and `.gameover-ready-player`**

Read `static/style.css`. Find the `.gameover-actions` rule or nearby gameover styles (search for `gameover-actions`). Add after the gameover styles:

```css
.gameover-ready-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
  margin: 0.75rem 0;
  font-size: 0.85rem;
}
.gameover-ready-player {
  color: var(--text-dimmer);
}
.gameover-ready-player.ready {
  color: #4ade80;
  font-weight: 600;
}
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

Expected: 28 tests pass.

- [ ] **Step 7: Commit**

```bash
cd G:/sg_bridge_game && git add static/index.html static/app.js static/style.css && git commit -m "feat: show ready status on gameover screen while waiting for all players"
```

---

## Manual Verification

Run `npm run dev`. Play a full game with 4 players (use bots to fill).

- [ ] Game ends → gameover screen shows all 4 players as `○ Name` (not ready)
- [ ] Bots auto-click Play Again within ~1 second (their `○` turns to `✓`)
- [ ] Human player clicks "Play Again" → their `○` turns to `✓`, button shows "Waiting..." and is disabled
- [ ] When all 4 ready → everyone transitions to lobby, 5-second countdown starts
- [ ] Host can press "Start Game" to skip countdown
- [ ] Spectators see the ready list but have no Play Again button to click
- [ ] Playing again multiple times in a row works correctly each time
