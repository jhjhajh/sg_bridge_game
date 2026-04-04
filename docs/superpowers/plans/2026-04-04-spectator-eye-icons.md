# Spectator Eye Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show color-coded spectator names with eye icons above each game phase screen, and a matching eye icon on the seat label of the player they're watching.

**Architecture:** Expose `spectators` in `PlayerGameView` from the backend. On the frontend, add a persistent `#spectator-bar` div below the top-bar, rendered by a shared `renderSpectatorBar(s)` helper called from all four phase render functions. Seat labels in `renderPlay` get additional colored eye icons for watching spectators.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vanilla JS

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `spectators` array to `PlayerGameView` |
| `src/game-room.ts` | Include `spectators` in `buildStateMessage` |
| `static/index.html` | Add `<div id="spectator-bar">` below `#top-bar` |
| `static/app.js` | Add `renderSpectatorBar(s)`; call from all 4 render fns; add eye icons to seat labels |
| `static/style.css` | Add `#spectator-bar`, `.spectator-tag`, `.seat-spectator-eye` styles |

---

### Task 1: Expose spectators in PlayerGameView

**Files:**
- Modify: `src/types.ts`
- Modify: `src/game-room.ts`

- [ ] **Step 1: Add `spectators` to `PlayerGameView` in `src/types.ts`**

The `PlayerGameView` interface (around line 70) ends with `partnerSeat: number;`. Add `spectators` before it:

```typescript
  gameStartAt: number | null;
  isGroupMember?: boolean;
  partnerSeat: number;
  spectators: { name: string; watchingSeat: number }[];
```

- [ ] **Step 2: Include `spectators` in `buildStateMessage` in `src/game-room.ts`**

`buildStateMessage` builds the `view` object (around line 291). It currently ends with:

```typescript
      partnerSeat: state.partnerRevealed ? state.partner : -1,
    };
```

Replace with:

```typescript
      partnerSeat: state.partnerRevealed ? state.partner : -1,
      spectators: state.spectators.map((sp) => ({ name: sp.name, watchingSeat: sp.watchingSeat })),
    };
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: 28 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/game-room.ts
git commit -m "feat: expose spectators list in PlayerGameView"
```

---

### Task 2: Add spectator bar HTML and CSS

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

- [ ] **Step 1: Add `#spectator-bar` div to `static/index.html`**

After the closing `</div>` of `#top-bar` (line 19), add:

```html
  <!-- Spectator bar (visible when spectators are present) -->
  <div id="spectator-bar" class="spectator-bar hidden"></div>
```

- [ ] **Step 2: Add styles to `static/style.css`**

Find the `.top-bar` styles and add after them (search for `top-bar-name` to locate the section, then add after):

```css
.spectator-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.25rem 1rem;
  background: rgba(0,0,0,0.25);
  font-size: 0.75rem;
}
.spectator-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-weight: 500;
}
.seat-spectator-eye {
  font-size: 0.7rem;
  line-height: 1;
}
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat: add spectator bar HTML and CSS"
```

---

### Task 3: Implement renderSpectatorBar and wire up all render functions

**Files:**
- Modify: `static/app.js`

**Color palette constant** — 6 colors assigned by spectator index mod 6:
```javascript
const SPECTATOR_COLORS = ['#06b6d4','#f97316','#a3e635','#f43f5e','#a855f7','#facc15'];
```

- [ ] **Step 1: Add `renderSpectatorBar` function and `SPECTATOR_COLORS` constant to `static/app.js`**

Add immediately before `// --- Bidding ---` (around line 956):

```javascript
const SPECTATOR_COLORS = ['#06b6d4','#f97316','#a3e635','#f43f5e','#a855f7','#facc15'];

function renderSpectatorBar(s) {
  const bar = $('spectator-bar');
  if (!bar) return;
  const specs = s.spectators ?? [];
  if (specs.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = specs.map((sp, i) => {
    const color = SPECTATOR_COLORS[i % SPECTATOR_COLORS.length];
    return `<span class="spectator-tag" style="color:${color}">👁 ${esc(sp.name)}</span>`;
  }).join('');
}
```

- [ ] **Step 2: Call `renderSpectatorBar(s)` from `renderBidding`**

`renderBidding` starts at around line 957. Its first line is:
```javascript
  renderPlayerStatusBar($('bidding-players'), s.players);
```

Add `renderSpectatorBar(s);` after it:

```javascript
function renderBidding(s) {
  renderPlayerStatusBar($('bidding-players'), s.players);
  renderSpectatorBar(s);
  // ... rest unchanged
```

- [ ] **Step 3: Call `renderSpectatorBar(s)` from `renderPartner`**

`renderPartner` starts at around line 1003. Its first line is:
```javascript
  renderPlayerStatusBar($('partner-players'), s.players);
```

Add `renderSpectatorBar(s);` after it:

```javascript
function renderPartner(s) {
  renderPlayerStatusBar($('partner-players'), s.players);
  renderSpectatorBar(s);
  // ... rest unchanged
```

- [ ] **Step 4: Call `renderSpectatorBar(s)` from `renderPlay`**

`renderPlay` starts at around line 1031. Add `renderSpectatorBar(s);` as its first line:

```javascript
function renderPlay(s) {
  renderSpectatorBar(s);
  // Info bar
```

- [ ] **Step 5: Call `renderSpectatorBar(s)` from `renderGameOver`**

`renderGameOver` starts at around line 1165. Its first line is:
```javascript
  renderPlayerStatusBar($('gameover-players'), s.players);
```

Add `renderSpectatorBar(s);` after it:

```javascript
function renderGameOver(s) {
  renderPlayerStatusBar($('gameover-players'), s.players);
  renderSpectatorBar(s);
  // ... rest unchanged
```

- [ ] **Step 6: Syntax check**

```bash
node --check static/app.js
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add static/app.js
git commit -m "feat: add renderSpectatorBar and call from all game phase renders"
```

---

### Task 4: Add eye icons to seat labels in renderPlay

**Files:**
- Modify: `static/app.js`

The seat label rendering is inside `renderPlay` (around line 1059). The current label HTML build is:

```javascript
      label.innerHTML = `<span class="seat-name-row">${bidderStar}${partnerStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span></span><span class="seat-sets">${sets}</span>`;
```

- [ ] **Step 1: Build eye icons string and insert into seat label**

Replace the seat label block (the lines building `bidderStar`, `partnerStar`, `sets`, and `label.innerHTML`) with:

```javascript
      const bidderStar = seat === s.bidder
        ? '<span class="bidder-star">★</span>'
        : '';
      const partnerStar = (s.partnerSeat !== -1 && seat === s.partnerSeat)
        ? '<span class="partner-star">★</span>'
        : '';
      const specs = s.spectators ?? [];
      const eyeIcons = specs
        .map((sp, i) => sp.watchingSeat === seat
          ? `<span class="seat-spectator-eye" style="color:${SPECTATOR_COLORS[i % SPECTATOR_COLORS.length]}">👁</span>`
          : '')
        .join('');
      const sets = s.sets?.[seat] ?? 0;
      label.innerHTML = `<span class="seat-name-row">${bidderStar}${partnerStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span>${eyeIcons}</span><span class="seat-sets">${sets}</span>`;
```

- [ ] **Step 2: Syntax check**

```bash
node --check static/app.js
```

Expected: no output.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 28 tests pass.

- [ ] **Step 4: Commit**

```bash
git add static/app.js
git commit -m "feat: show colored eye icons on watched seat labels"
```

---

## Manual Verification

Run `npm run dev`. Open two browsers — one as a player, one joining a game in progress (becomes a spectator).

- [ ] Spectator bar appears above bidding/partner/play/gameover screens
- [ ] Spectator shown as colored `👁 Name` in the bar
- [ ] After spectator picks a seat, a matching colored 👁 appears on that player's seat label
- [ ] Multiple spectators each get a different color
- [ ] Spectator bar is hidden when no spectators present
- [ ] Bar hides after all spectators disconnect (next state update with empty spectators)
