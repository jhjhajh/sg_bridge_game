# Kick Any Player in Game Lobby (including from Game Over screen)

**Date:** 2026-04-17

## Goal

After a game ends, players land on the game-over screen and must click "Play Again" (ready up) before the room transitions back to lobby. Currently, kicking is only allowed in the `lobby` phase — so if a player disconnects on the game-over screen and never readies up, the other 3 players are stuck: they can't kick the ghost, can't start a new game, and must abandon the room and recreate it.

Fix: allow any connected, non-spectator player to kick any other player when the phase is either `lobby` or `gameover`.

## Approach

- Remove the `phase === 'lobby'` guard in `handleKickPlayer` and replace with `phase === 'lobby' || phase === 'gameover'`.
- When kicked from `gameover`, also remove the target from `readySeats` (in case they were already ready before disconnecting) and re-index seats.
- No transition logic needed — if after a kick the ready count equals the new player count, trigger the playAgain flow as normal.
- Frontend: show kick buttons in the game-over player list, not just the lobby list.

## Files Touched

- `src/game-room.ts` — relax phase guard in `handleKickPlayer`; remove kicked seat from `readySeats`
- `static/app.js` — render kick buttons in game-over player list (currently only shown in lobby)

## Acceptance Criteria

- [ ] Any connected player can kick any other player (except themselves) in both `lobby` and `gameover` phases
- [ ] Disconnected ghost on game-over screen can be kicked
- [ ] After kicking from gameover, if remaining ready players equal new player count, game transitions back to lobby correctly
- [ ] Kick buttons are visible on the game-over screen (not just lobby)
- [ ] Cannot kick yourself
- [ ] Spectators cannot kick

## Known Risks

- If all 4 players were ready and one gets kicked from gameover mid-transition, the `readySeats.length >= NUM_PLAYERS` check might fire on stale count — mitigated by re-checking against `state.players.length` after the kick.
- No change to bot kick rules (host-only for bots in lobby).

## Test Plan

1. Start a game with 4 players, finish it to game-over screen
2. Have one player close the tab (disconnect, don't ready up)
3. Any other player clicks ✕ on the disconnected player — confirm they are removed
4. Remaining 3 players can now ready up and return to lobby normally
5. Verify kicking yourself is still blocked
6. Verify spectators have no kick button
