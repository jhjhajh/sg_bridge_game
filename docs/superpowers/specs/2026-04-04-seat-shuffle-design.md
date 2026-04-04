# Seat Shuffle Design

**Date:** 2026-04-04  
**Status:** Approved

## Overview

Randomise player seating positions at the start of every game — both the initial game from the lobby and every "Play Again" rematch. Currently players always sit in join-order (seat 0 = first to join, etc.). After this change, seats are re-drawn randomly each time bidding begins, so the table layout and turn order are unpredictable every game.

## Goals

- Shuffle seat assignments before every game start (initial and rematch)
- Each player's seat index (0–3) determines table position, turn order, and hand assignment — all are randomised as a result

## Non-Goals

- Showing the shuffle animation on the frontend
- Preserving any "teams" or partnerships across games
- Changing who the host is (seat 0 in the lobby context is irrelevant once the game starts)

## Implementation

### `shufflePlayerSeats(state: GameState): void` — private method in `src/game-room.ts`

Fisher-Yates in-place shuffle of `state.players`, then re-assign `p.seat = index` for each player:

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

### Call sites

- `startGameFromLobby`: call `this.shufflePlayerSeats(state)` immediately before `state.phase = 'bidding'`
- `handlePlayAgain`: call `this.shufflePlayerSeats(state)` immediately before `state.phase = 'bidding'`

Hands are dealt via `generateHands()` after the shuffle in both methods, so each player at their new seat receives a fresh random hand.

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `src/game-room.ts` | Add `shufflePlayerSeats` method; call it in `startGameFromLobby` and `handlePlayAgain` |
