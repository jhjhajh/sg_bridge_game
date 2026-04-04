# Seat Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Randomise player seat assignments at the start of every game (initial and Play Again).

**Architecture:** A private `shufflePlayerSeats(state)` method is added to `GameRoom` in `src/game-room.ts`. It Fisher-Yates shuffles `state.players` in-place and re-assigns `p.seat = index`. It is called in both `startGameFromLobby` (initial game) and `handlePlayAgain` (rematch) before any game-state fields are set.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vitest

---

## File Map

| File | Change |
|------|--------|
| `src/game-room.ts` | Add `shufflePlayerSeats` private method; call it in `startGameFromLobby` and `handlePlayAgain` |

---

### Task 1: Add shufflePlayerSeats and wire it into both game-start paths

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `shufflePlayerSeats` private method**

Open `src/game-room.ts`. Add this method immediately before `startGameFromLobby` (which is currently around line 1197):

```typescript
  private shufflePlayerSeats(state: GameState): void {
    const players = state.players;
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    players.forEach((p, i) => { p.seat = i; });
  }
```

- [ ] **Step 2: Call `shufflePlayerSeats` at the start of `startGameFromLobby`**

Find `startGameFromLobby` (around line 1197). It currently starts with:

```typescript
  private async startGameFromLobby(state: GameState): Promise<void> {
    state.gameStartAt = null;
    state.phase = 'bidding';
```

Add the shuffle call as the very first line of the method body:

```typescript
  private async startGameFromLobby(state: GameState): Promise<void> {
    this.shufflePlayerSeats(state);
    state.gameStartAt = null;
    state.phase = 'bidding';
```

- [ ] **Step 3: Call `shufflePlayerSeats` at the start of `handlePlayAgain`**

Find `handlePlayAgain` (around line 855). After the guard check it currently starts with:

```typescript
    if (state.phase !== 'gameover') return;

    const otherSeats = [0, 1, 2, 3].filter((s) => s !== state.firstBidder);
```

Add the shuffle call immediately after the guard:

```typescript
    if (state.phase !== 'gameover') return;

    this.shufflePlayerSeats(state);

    const otherSeats = [0, 1, 2, 3].filter((s) => s !== state.firstBidder);
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run existing tests**

```bash
npm test
```

Expected: 28 tests pass. The shuffle is a DO-internal method; existing pure-function tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/game-room.ts
git commit -m "feat: shuffle player seats at the start of every game"
```

---

## Manual Verification

Run `npm run dev` and open two browser windows.

- [ ] Fill a room with 4 players (use Add Bot). Let the countdown fire. After bidding starts, note who is at which seat position around the table.
- [ ] End the game (let it play out or use bots). Click "Play Again". Verify that player positions around the table are different from the previous game.
- [ ] Repeat Play Again 2–3 times to confirm seating changes each round.
