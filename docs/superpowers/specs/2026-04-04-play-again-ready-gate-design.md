# Play Again Ready Gate Design

**Goal:** Prevent a single player's "Play Again" click from immediately starting the next game for everyone. Instead, all 4 players must click "Play Again" before the lobby (and its countdown) begins.

**Date:** 2026-04-04

---

## Design

### Backend

**New state field:** Add `readySeats: number[]` to `GameState` in `src/types.ts`. Initialised as `[]` in `createInitialState`. Reset to `[]` when the game ends (where `phase` is set to `'gameover'`).

**`handlePlayAgain` reworked:**
- Guard: `if (state.phase !== 'gameover') return`
- Add the player's seat to `readySeats` if not already present
- If `readySeats.length < NUM_PLAYERS` → save state and broadcast (so other players see the update); return
- If all 4 seats ready → reset `readySeats = []`, transition to `phase = 'lobby'`, set `gameStartAt = Date.now() + 5000`, schedule the 5-second alarm (same as initial game join)
- Existing countdown alarm and `startGameFromLobby` handle the rest unchanged

**Bots auto-ready:** In `scheduleBotAction`, if `state.phase === 'gameover'`, call a new private `handleBotReadyUp(state)` that adds all bot seats to `readySeats` and checks for full readiness — same logic as `handlePlayAgain` but iterating all bots at once.

**`handleStartGame`** (host skip) already works once `phase === 'lobby'` — no changes needed.

**Reset:** `readySeats` is reset to `[]` inside `handlePlayAgain` when transitioning to lobby, and in `createInitialState`.

### PlayerGameView

Add `readySeats: number[]` to `PlayerGameView` in `src/types.ts` and expose it in `buildStateMessage`. The frontend uses this to show which players have clicked Play Again.

### Frontend

**Gameover screen:**
- "Play Again" button: clicking sends `{ type: 'playAgain' }`. After click, button label changes to "Waiting..." and is disabled.
- Player list on gameover screen shows a ✓ beside names of players in `s.readySeats`.
- `s.mySeat` in `readySeats` → button is disabled and shows "Waiting..."

**Lobby screen** (unchanged): when all 4 ready, everyone transitions to lobby via normal state broadcast. Existing countdown and "Start Game" host button apply.

---

## Out of Scope

- Spectators clicking Play Again (they are not in `readySeats` logic)
- Un-readying (clicking Play Again is one-way per game)
- Partial lobby (e.g. showing 3/4 ready in the lobby screen)
