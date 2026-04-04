# Player Role Stars Design

**Date:** 2026-04-04  
**Status:** Approved

## Overview

Two visual enhancements to the play screen seat labels:

1. **Bidder star** — the existing small inline `★` beside the bidder's name is replaced with a larger gold star rendered to the left of the label content.
2. **Partner star** — a silver `★` appears beside the partner's seat label, but only once the partner card has been played (partner revealed).

## Goals

- Gold `★` left of the bidder's name, visually prominent
- Silver `★` beside the partner's name, appearing only on partner reveal
- Partner identity must remain secret until the partner card is actually played

## Non-Goals

- Any animation on reveal
- Showing the star during bidding or partner-selection phases

## State Changes

### `GameState` (`src/types.ts`)

Add one field:

```typescript
partnerRevealed: boolean;
```

Default: `false`. Set to `true` in `handlePlayCard` when the played card equals `state.partnerCard`.

### `PlayerGameView` (`src/types.ts`)

Add one field:

```typescript
partnerSeat: number;
```

In `buildStateMessage` (`src/game-room.ts`):

```typescript
partnerSeat: state.partnerRevealed ? state.partner : -1,
```

This exposes the partner's seat index to all clients — but only after the partner card has been played. Before reveal, it is `-1`.

### `createInitialState` (`src/game-room.ts`)

Add to the returned object:

```typescript
partnerRevealed: false,
```

### `handlePlayAgain` (`src/game-room.ts`)

Reset the field:

```typescript
state.partnerRevealed = false;
```

### `handlePlayCard` (`src/game-room.ts`)

After successfully playing a card, check:

```typescript
if (card === state.partnerCard && !state.partnerRevealed) {
  state.partnerRevealed = true;
}
```

## Frontend (`static/app.js`)

### Seat label rendering (play screen, around the `seat-${pos}-label` loop)

Current:
```javascript
let text = player.name;
if (seat === s.bidder) text += ' ★';
// ...
label.innerHTML = `<span class="seat-name-row">${statusDot(player.connected)}<span class="seat-name">${esc(text)}</span></span><span class="seat-sets">${sets}</span>`;
```

Replace with:

```javascript
const bidderStar = seat === s.bidder
  ? '<span class="bidder-star">★</span>'
  : '';
const partnerStar = (s.partnerSeat !== -1 && seat === s.partnerSeat)
  ? '<span class="partner-star">★</span>'
  : '';
label.innerHTML = `<span class="seat-name-row">${bidderStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span>${partnerStar}</span><span class="seat-sets">${sets}</span>`;
```

## Styling (`static/style.css`)

```css
.bidder-star {
  color: #ffd700;
  font-size: 1.1rem;
  margin-right: 0.3rem;
  line-height: 1;
}
.partner-star {
  color: #c0c0c0;
  font-size: 0.85rem;
  margin-left: 0.3rem;
  line-height: 1;
}
```

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `src/types.ts` | Add `partnerRevealed: boolean` to `GameState`; add `partnerSeat: number` to `PlayerGameView` |
| Modify | `src/game-room.ts` | Init `partnerRevealed: false` in `createInitialState`; reset in `handlePlayAgain`; set `true` in `handlePlayCard` when partner card played; expose `partnerSeat` in `buildStateMessage` |
| Modify | `static/app.js` | Replace inline star text with `bidder-star` and `partner-star` spans in seat label rendering |
| Modify | `static/style.css` | Add `.bidder-star` (gold, 1.1rem) and `.partner-star` (silver, 0.85rem) styles |
