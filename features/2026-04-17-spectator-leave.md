# Spectator Leave Mode

**Date:** 2026-04-17

## Goal
Currently, spectators are unable to step out of spectator mode once they join as a spectator. If they use the global "Leave" button, they behave as abandoning the game and are completely disconnected, returning to the home screen. 

This feature introduces a way for spectators to gracefully "leave spectator mode" (e.g., to stop watching or to return to the lobby) without having to abandon the game room connection, and replaces the misleading leave prompt experienced by spectators.

## Open Questions & Clarifications

Before proceeding with the technical implementation, the following requirements need to be clarified:

1. **Destination:** When a spectator clicks "Leave Spectator Mode", what is the intended destination? 
   - Should they be placed into a "waiting" queue so they can automatically join the next game if a seat opens up? 
   - Or should they just be returned to the `screen-spectator` (Choose who to watch) screen?
2. **"Abandon" Button Context:** The prompt mentions an "abandon" button. Currently, the global `#btn-leave-global` button in the top bar says "Leave" and prompts with `"Leave the current game?"`. Is this the button being referred to, and should it be restyled/reworded for spectators, or is there another button?
3. **During Active Game:** If a spectator leaves spectator mode while the game is still active, what should they see? The lobby screen indicating "Game in Progress", or should they remain in the room but not actively view hands?

## Scope

**In Scope:**
- Add a "Leave Spectator Mode" or "Stop Spectating" button to the spectator interface.
- Update the global "Leave" button's confirmation dialogue so that spectators aren't prompted with "Leave the current game?" (which implies abandoning).
- Update the backend `game-room.ts` to handle returning a spectator to an idle/lobby state without dropping their WebSocket connection.

**Out of Scope:**
- Allowing more than 4 active players in a game.

## UI / UX Design

1. **Spectator UI Controls:**
   - In `screen-play`, `screen-bidding`, and `screen-gameover`, add a button (e.g. `[Exit Spectator Mode]`) or replace the global Top Bar "Leave" button action for spectators.
2. **Confirmation Adjustments:**
   - Modify `app.js` line ~1910 so `gameState.isSpectator` bypasses the `confirm('Leave the current game?')` dialogue, or presents a unique dialogue: `Stop spectating and return to lobby?`

## Backend Implementation Details

- **`protocol.ts`**: Add a new client message type: `{ type: 'leaveSpectator' }`.
- **`game-room.ts`**:
  - Implement `handleLeaveSpectator(state, playerId)`.
  - Locate the spectator in `state.spectators`. 
  - If the user wishes to remain in the room (e.g., for the next game), move them from `state.spectators` back to a waiting observer state, or if the room is in `lobby` phase and `< 4` players, promote them directly to `state.players`.
  - Broadcast updated state so the frontend transitions the user out of the active game views.
