# advance_bot.md — Advanced Bot AI Design & Logic

This document is the source of truth for the **Advance** level bot in `src/game-room.ts`. It covers **bidding** (HCP, distribution, virtual honor, competition) and **play** (leading, following, helpers, confidence).

---

## 1. Overview & confidence

Bots are server-side and use deliberate incomplete information to feel human.

| Mechanism | Detail |
| :--- | :--- |
| **Pre-reveal** | 65% chance to use team logic (before partner card is played). |
| **Post-reveal** | 85% chance to use team logic. |
| **Basic fallback** | On failed roll: lowest winning card or `smartDump`. |
| **Delay** | 700 ms via `scheduleBotAction`. |

---

## 2. Bidding (advanced)

### 2.1 Hand evaluation

**A. High Card Points (HCP)** — standard 13-card valuation:

- Ace = 4, King = 3, Queen = 2, Jack = 1.

**B. Length points (L)** — rewards long suits after trumps are drawn:

- 5th card in any suit: +1.
- 6th card and above: +1 per extra card.

**C. Virtual honor (VH) — the “call” bonus**

The bidder names a card they do not hold; that card is treated as a virtual asset for strength.

- Identify the highest missing honour in the **intended trump** suit (A, then K, then Q).
- Add that card’s **HCP value** to total strength for that trump choice.  
  *Example:* missing A♠ for a spade contract → **+4** VH.

### 2.2 Suit selection & NT priority

**Suit rank (low → high)**  
♣ → ♦ → ♥ → ♠ → **NT** (lowest to highest; at the same level, NT beats any suit).

**Choosing strain**

1. **Primary:** longest suit.
2. **Tiebreak:** more HCP in that suit.

**No-trump (NT) criteria**

- No suit longer than 4 cards (balanced).
- Stoppers (A or K) in at least three suits.
- Base HCP (excluding VH) ≥ 15.

### 2.3 Bid level thresholds

Total strength **S = HCP + L + VH**.

| S | Level | Tricks to make (6 + level) |
| :--- | :--- | :--- |
| Below 13 | Pass | — |
| 13–19 | 1 | 7 |
| 20–23 | 2 | 8 |
| 24+ | 3 | 9 |

### 2.4 Competitive overcalling (“step up”)

Compare the bot’s `targetLevel` + `targetSuit` to `state`’s current high bid.

**Overtake rule**

- If `targetSuit` **ranks above** current bid suit → may bid at the **same** level (e.g. 1 NT over 1 ♠).
- If `targetSuit` **does not rank above** current bid suit → must bid **one level higher** (e.g. 2 ♦ over 1 ♠).

**Constraint**

- Never bid above the bot’s **own** max level from **S**.
- If the overtake rule needs level 2 but **S** only supports level 1 → **pass**.

### 2.5 Partner card selection (post-auction)

- Pick the **highest** card (A → 2) the bidder **does not** hold (scan suits e.g. ♠ ♥ ♦ ♣).

### 2.6 Implementation sketch (`getBotBid`)

```typescript
function getBotBid(hand, currentBid) {
  const washThreshold = 4;
  if (getHCP(hand) < washThreshold) return null; // PASS (wash / too weak)

  let bestSuit = selectBestSuit(hand);
  let totalStrength = calculateTotalStrength(hand, bestSuit);
  let myMaxLevel = getLevelFromStrength(totalStrength);

  if (myMaxLevel === 0) return null; // PASS

  let proposedLevel = currentBid.level;
  let isHigherSuit = compareSuitRank(bestSuit, currentBid.suit) > 0;

  if (!isHigherSuit) {
    proposedLevel++;
  }

  if (proposedLevel <= myMaxLevel && proposedLevel <= 3) {
    return { level: proposedLevel, suit: bestSuit };
  }

  return null; // PASS
}
```

### 2.7 Known exceptions & caps

- **Level 3 cap:** advance bots do not bid above level 3 (no deep endgame planning).
- **Wash:** if raw HCP is below 4, pass regardless of length (aligns with table redeal rule in the live game).

---

## 3. Leading (first to play)

| Role | Scenario | Decision |
| :--- | :--- | :--- |
| **Bidder** | Known void in suit | **50%** force trump (long suit) / **50%** switch suit to avoid ruff. |
| **Partner** | Lead after winning | **1:** Lead **low** in the **called suit**. **2:** Lead bidder’s **bid suit** from history. |
| **Opposition** | Holds K or Q in called suit | **70%** lead high (reveal test) / **30%** longest side suit. |
| **Opposition** | Teammate winning with trump | **100%** `smartDump` (“no-stack”) — save high trumps. |

**NT contract — partner leads called suit**

If bidder will lead the called suit in NT, partner convention: lead **low** in that suit to preserve bidder’s honours and give partner line to A/K (related to **§3** partner priority 1).

---

## 4. Following (trick in progress)

### 4.1 “Second hand low”

When playing second to a trick with honours (K, Q, J):

- **70%** play low (wait for fourth hand / partner).
- **30%** play high (aggressive).

### 4.2 Partner identity (reveal)

When bidder leads the **called suit** and the bot holds the **called card**:

Play the called card **when all** hold:

1. An **opposition** player is currently winning the trick.
2. The bot has **fewer than 4** cards in that suit (reduces risk of being ruffed next).

### 4.3 Void management (ruff vs discard)

- **Partner:** if opposition is winning and trump wins — **ruff**; never `smartDump` the called ace away casually.
- **Opposition:** ruff if bidder is winning; if an opposition teammate already wins with trump — **smartDump**.

---

## 5. Helpers & memory

### `smartDump(state, hand)`

Default discard when not forced to win:

1. Drop trump cards from pool unless only trumps remain.
2. Shortest **side** suit.
3. **Lowest** card in that suit.
4. **Partner:** never dump the **called card** unless it is the last card.

### `isBossCard(state, card)`

`true` when no higher rank remains in that suit (uses `trickLog` + current trick). Boss cards may be led high from length (5+).

### `getVoids(state)`

Map of seats that have shown void by discarding off-suit. Bidder uses this to avoid leading into a ruff.

---

## 6. Implementation checklist

**Bidding**

- [ ] Implement **S = HCP + L + VH** and `selectBestSuit` / NT rules per §2.
- [ ] Apply **competitive step-up** (§2.4) against `state.bid` / `bidHistory`.
- [ ] Enforce **wash** (HCP below 4) and **level 3** cap.

**Play**

- [ ] Integrate `state.bidHistory` into `getBotLeadCard` for partner returns.
- [ ] Apply 70/30 opposition reveal weights in `getBotLeadCard`.
- [ ] Ensure `isPartnerCardRevealed` gates team logic at start of `getBotCard`.
- [ ] Verify `smartDump` respects the **called-card** constraint for partner.
