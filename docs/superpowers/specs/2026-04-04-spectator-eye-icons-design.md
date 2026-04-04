# Spectator Eye Icons Design

**Goal:** Show color-coded spectator names with eye icons visible across all game phases, and a matching eye icon on the seat label of the player each spectator is watching.

**Date:** 2026-04-04

---

## Design

### Backend

`spectators: Spectator[]` exists in `GameState` but is not currently included in `PlayerGameView`. Add:

```typescript
spectators: { name: string; watchingSeat: number }[];
```

to `PlayerGameView` in `src/types.ts`, and include it in `buildStateMessage` in `src/game-room.ts`:

```typescript
spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
```

No spectator IDs are exposed to clients.

### Frontend — Spectator Bar

Add `<div id="spectator-bar"></div>` once in `static/index.html`, inside `.top-bar` or just below it (always present in the DOM).

A `renderSpectatorBar(s)` helper:
- Hides the bar when `s.spectators` is empty or undefined
- Assigns each spectator a color from a fixed 6-color palette by index (mod 6)
- Renders each spectator as a colored `👁 Name` span
- Called from `renderBidding`, `renderPartner`, `renderPlay`, `renderGameOver`

**Color palette** (index 0–5):
```
#06b6d4  #f97316  #a3e635  #f43f5e  #a855f7  #facc15
```

### Frontend — Seat Label Eye Icons

In `renderPlay`, when building each seat label, check if any spectator has `watchingSeat === seat`. If so, prepend a small 👁 icon in that spectator's color before the player name (or after the stars, before the status dot).

Multiple spectators can watch the same seat — all their eye icons appear stacked.

### CSS

- `#spectator-bar`: flex row, centered, gap, small font, hidden when empty
- `.spectator-tag`: inline colored eye + name, `font-size: 0.75rem`
- `.seat-spectator-eye`: tiny inline eye icon on seat label, `font-size: 0.7rem`

---

## Out of Scope

- Spectators choosing to switch seats mid-game (already locked by existing logic)
- Showing spectators in the lobby screen
