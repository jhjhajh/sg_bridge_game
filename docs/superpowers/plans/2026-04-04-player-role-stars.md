# Player Role Stars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a large gold star to the left of the bidder's seat label and a silver star beside the partner's label once the partner card has been played.

**Architecture:** A new `partnerRevealed: boolean` field in `GameState` tracks whether the partner card has been played. It is exposed to clients as `partnerSeat: number` in `PlayerGameView` (the partner's seat index, or -1 if not yet revealed). The frontend renders `.bidder-star` and `.partner-star` spans in the seat label HTML instead of the current inline text approach.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vanilla JS

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `partnerRevealed: boolean` to `GameState`; add `partnerSeat: number` to `PlayerGameView` |
| `src/game-room.ts` | Init field in `createInitialState`; expose in `buildStateMessage`; set `true` in `handlePlayCard`; reset in `handlePlayAgain` |
| `static/app.js` | Replace inline star text with `bidder-star`/`partner-star` HTML spans |
| `static/style.css` | Add `.bidder-star` (gold) and `.partner-star` (silver) styles |

---

### Task 1: Types and backend — partnerRevealed state + partnerSeat view field

**Files:**
- Modify: `src/types.ts`
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `partnerRevealed` to `GameState` in `src/types.ts`**

The `GameState` interface ends with `gameStartAt: number | null;`. Add after it:

```typescript
  gameStartAt: number | null;
  partnerRevealed: boolean;
```

- [ ] **Step 2: Add `partnerSeat` to `PlayerGameView` in `src/types.ts`**

The `PlayerGameView` interface ends with `gameStartAt: number | null;`. Add after it:

```typescript
  gameStartAt: number | null;
  partnerSeat: number;
```

- [ ] **Step 3: Initialize `partnerRevealed` in `createInitialState`**

`createInitialState` (around line 210) returns an object. It currently ends with:

```typescript
      groupId,
      gameStartAt: null,
    };
```

Replace with:

```typescript
      groupId,
      gameStartAt: null,
      partnerRevealed: false,
    };
```

- [ ] **Step 4: Expose `partnerSeat` in `buildStateMessage`**

`buildStateMessage` (around line 246) builds the `view` object. It currently ends with:

```typescript
      isGroupMember: player?.isGroupMember,
      gameStartAt: state.gameStartAt,
    };
```

Replace with:

```typescript
      isGroupMember: player?.isGroupMember,
      gameStartAt: state.gameStartAt,
      partnerSeat: state.partnerRevealed ? state.partner : -1,
    };
```

- [ ] **Step 5: Set `partnerRevealed = true` in `handlePlayCard` when partner card is played**

`handlePlayCard` (around line 617). After the card is registered at `state.playedCards[seat] = card;` (around line 655), add:

```typescript
    state.playedCards[seat] = card;

    if (card === state.partnerCard && !state.partnerRevealed) {
      state.partnerRevealed = true;
    }
```

- [ ] **Step 6: Reset `partnerRevealed` in `handlePlayAgain`**

`handlePlayAgain` resets all game state. It has the block:

```typescript
    state.partner = -1;
    state.partnerCard = null;
    state.passCount = 0;
```

Add the reset immediately after `state.partnerCard = null;`:

```typescript
    state.partner = -1;
    state.partnerCard = null;
    state.partnerRevealed = false;
    state.passCount = 0;
```

- [ ] **Step 7: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Run tests**

```bash
npm test
```

Expected: 28 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/game-room.ts
git commit -m "feat: track partnerRevealed state, expose partnerSeat in PlayerGameView"
```

---

### Task 2: Frontend — star spans in seat labels and CSS styles

**Files:**
- Modify: `static/app.js`
- Modify: `static/style.css`

- [ ] **Step 1: Replace inline star with `bidder-star` and `partner-star` spans in seat label rendering**

In `static/app.js`, around line 1058, find:

```javascript
    if (player) {
      let text = player.name;
      if (seat === s.bidder) text += ' ★';
      const sets = s.sets?.[seat] ?? 0;
      label.innerHTML = `<span class="seat-name-row">${statusDot(player.connected)}<span class="seat-name">${esc(text)}</span></span><span class="seat-sets">${sets}</span>`;
```

Replace with:

```javascript
    if (player) {
      const bidderStar = seat === s.bidder
        ? '<span class="bidder-star">★</span>'
        : '';
      const partnerStar = (s.partnerSeat !== -1 && seat === s.partnerSeat)
        ? '<span class="partner-star">★</span>'
        : '';
      const sets = s.sets?.[seat] ?? 0;
      label.innerHTML = `<span class="seat-name-row">${bidderStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span>${partnerStar}</span><span class="seat-sets">${sets}</span>`;
```

- [ ] **Step 2: Add `.bidder-star` and `.partner-star` styles to `static/style.css`**

Find a suitable location — e.g. after the `.seat-sets` rule or near the existing `.seat-name` styles. Search for `.seat-name` to find the section, then add after the seat-related rules:

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

- [ ] **Step 3: Syntax check**

```bash
node --check static/app.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add static/app.js static/style.css
git commit -m "feat: gold bidder star and silver partner star on seat labels"
```

---

## Manual Verification

Run `npm run dev` and open two browser windows to play a game (use bots to fill seats).

- [ ] During bidding: verify a larger gold `★` appears to the LEFT of the bidder's name label (before the name, not after)
- [ ] Other players have no star
- [ ] After partner card is played: a silver `★` appears beside the partner's name label
- [ ] Before the partner card is played: no silver star anywhere
- [ ] On "Play Again": silver star disappears until the next partner card is played
