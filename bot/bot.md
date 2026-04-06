# Bot AI — Design & Logic Reference

This document describes the full bot AI implementation in `src/game-room.ts`. Use it as the source of truth when making enhancements or debugging bot behaviour.

---

## Overview

Bots are server-side only. All bot methods are private on `GameRoom`. A bot acts whenever `state.turn` is a bot seat and `state.phase` is `'bidding'`, `'partner'`, or `'play'`. The scheduler in `scheduleBotAction` adds a 700 ms delay before acting to feel more human.

Bots know the full `GameState` (all hands, partner identity, etc.) because they run on the server. They deliberately under-use this information to stay at intermediate difficulty.

---

## Confidence Model

```
confidence = isPartnerCardRevealed(state) ? 0.85 : 0.65
useTeamLogic = state.partner >= 0 && Math.random() < confidence
```

Before the partner card is played/revealed, bots only use team-aware logic 65% of the time. After it is revealed (partner identity is known), confidence rises to 85%. The remaining percentage falls back to **basic logic**: win if possible with lowest card, else play lowest card.

This simulates a player who plays better once they know who their partner is.

---

## Bidding — `getBotBid`

### Step 1: Hand strength (HCP + distribution)

```
A = 4, K = 3, Q = 2, J = 1
+1 per card beyond 4 in any suit (distribution bonus)
```

### Step 2: Desired bid level

| Points | Action |
|--------|--------|
| < 9 | Pass |
| 9–11 | 60% chance to bid level 1; 40% pass |
| 12–15 | Level 1 |
| 16–18 | Level 2 |
| 19+ | Level 3 (hard cap) |

### Step 3: Preferred trump suit

- Choose the longest suit (tiebreak: most HCP in that suit)
- If the longest suit has ≤ 3 cards → prefer no-trump (unreliable trump fit)

### Step 4: Scan upward for a legal bid

Starting at the preferred suit and level, scan upward through suits (then no-trump) until finding a bid that:
- Is strictly higher than the current highest bid (`state.bid`)
- Does not exceed `MAX_BID` (34)

If nothing valid is found at the desired level, **pass** (never overbid to a higher level).

---

## Partner Card Selection — `getBotPartnerCard`

Picks the highest card the bidder does **not** hold, scanning suits in order: ♠ ♥ ♦ ♣, values A → 2.

This targets the strongest card the bidder is missing, maximising the chance that the selected card is held by a strong player.

---

## Card Play — `getBotCard`

Entry point. Determines whether it is a **lead** (trick not yet started) or a **follow** (trick in progress), then delegates.

```
trickInProgress = !trickComplete && any playedCards !== null

if !trickInProgress:
  → getBotLeadCard (if useTeamLogic, else lowestCard)
else if useTeamLogic:
  → getBotCardAsBidderTeam or getBotCardAsOpposition
else:
  → basic fallback: lowestCard(winning) or smartDump
```

**Basic fallback discard rule:** when the bot cannot win the trick (e.g. confidence roll failed), it calls `smartDump` rather than `lowestCard(validCards)`. This prevents the bot from accidentally ruffing with trump or throwing away a high honour on the low-confidence path. "Dump low from shortest non-trump suit" is the universal rule for unforced discards.

---

## Leading — `getBotLeadCard`

Called when the bot is the first to play in a trick.

**Bidder team:**
1. If partner bid a suit (not no-trump, not trump), lead it high — establishes length, drives out stoppers.
2. Filter to suits where no opponent is void (avoid leading into a ruff).
3. Fallback: `leadLongestNonTrump` on the safe pool.

**Opposition:**
1. Build "safe" suits: not trump, not a suit the bidder or partner bid, and not a suit where any bidder-team player is void (avoid giving them a ruff).
2. Lead lowest card of a safe suit.
3. Fallback: avoid trump. If nothing else, any card.

### `leadLongestNonTrump`

Finds the non-trump suit with the most cards in hand. Leads:
- **High** (highest card) if the suit has 5+ cards — to drive out opponents' honours and establish future winners.
- **Low** (lowest card) if 4 or fewer — information lead, keeps options open.

---

## Following — Bidder Team (`getBotCardAsBidderTeam`)

```
if teammate is current winner:
  → smartDump (don't steal the trick)

if I hold the boss card in led suit:
  → play it (guaranteed win; saves teammate's resources)

if teammate plays last in the trick:
  if led suit is NOT partner's bid suit:
    → smartDump (let teammate close with best position)
  else fall through (partner is strong here but we can save their card)

opposition winning, no teammate-last cover:
  compute winning cards
  if can win:
    if opponent plays after us → highestCard(winning) (guard against overtake)
    else                       → lowestCard(winning)
  else → smartDump
```

---

## Following — Opposition (`getBotCardAsOpposition`)

```
if opp teammate is current winner:
  → smartDump (don't steal)

if I hold the boss card in led suit:
  → play it

if opp teammate plays last in the trick:
  if led suit is NOT bidder's bid suit (safe suit):
    → smartDump (let teammate close with best position)
  else fall through (bidder is strong here — teammate may not handle it)

bidder team winning, no teammate-last cover:
  compute winning cards
  if can win:
    if bidder-team player plays after us → highestCard(winning) (guard against re-overtake)
    else                                 → lowestCard(winning)
  else → smartDump
```

---

## Helper: `smartDump`

Discards the **lowest card from the shortest non-trump side suit**.

Logic:
1. Filter to non-trump cards (unless all cards are trump — then use all).
2. Among those, find the suit with the fewest cards in hand (by current hand length).
3. Return the lowest card in that suit.

Rationale: burning a short, weak side suit is low-cost and avoids wasting trump or established long suits. This is the **universal discard rule** for all unforced discards — used by both team-logic branches and the basic fallback. The bot never intentionally discards a high card for signalling or unblocking purposes.

---

## Helper: `getCurrentTrickWinnerSeat`

Returns the seat number currently winning the trick, based on `state.playedCards` and the ordering from `state.firstPlayer`. Uses `compareCards` (pure game logic in `bridge.ts`) to determine the winner given the current suit and trump.

---

## Helper: `getOrderedCardsPlayed`

Returns the cards played so far this trick in play order (from `firstPlayer` around the table), skipping empty slots.

---

## Helper: `isPartnerCardRevealed`

Scans all hands. If the partner card is no longer in any hand, it has been played → partner is known. Returns `true` when revealed.

---

## Helper: `isOnBidderTeam`

```
seat === state.bidder || seat === state.partner
```

---

## Helper: `lowestCard` / `highestCard`

Simple reduce over a card array, comparing numeric rank via `getNumFromValue`.

---

## Bid History as Suit Signal

`state.bidHistory` stores each player's bids in order. Entries where `bidNum !== null` carry a suit signal: the player likely holds length in that suit. Used in both `getBotLeadCard` (lead into partner's suit; avoid bidder's suits) and `getBotCardAsOpposition` (avoid leading bidder's strong suits).

---

## Memory & Inference Helpers

### `getAllPlayedCards`
Returns a `Set<string>` of every card played across all completed tricks (`trickLog`) plus the current trick's `playedCards`. Used by `isBossCard`.

### `isBossCard(state, card)`
Returns `true` if every card ranked higher than `card` in the same suit has already been played. A boss card is the highest remaining in its suit.

**Important:** `isBossCard` alone is not sufficient to decide whether to play a card. An Ace of ♣ is always a boss card, but if the bot is void in the led suit, playing A♣ as a discard throws away a guaranteed winner for nothing. Both following functions verify with `compareCards` that the boss card would actually win the current trick before committing to it.

### `getVoids(state)`
Returns `Map<seat, Set<Suit>>`. For each completed trick, identifies the led suit (the `playOrder === 1` entry) then marks any player who played a different suit as void in the led suit. Used by `getBotLeadCard` to avoid leading into an opponent ruff.

### `getPlayersAfter(state, seat)`
Returns the seats (in play order) that still have to play after `seat` in the current trick. Used for positional reasoning in `getBotCardAsBidderTeam` and `getBotCardAsOpposition`.

### `getPartnerBidSuits` / `getBidderBidSuits`
Convenience helpers that extract the non-trump, non-no-trump suits from the bid history for the partner and bidder respectively. Centralises the bid-history scan previously duplicated in `getBotLeadCard` and the following methods.

---

## Known Limitations / Future Work

- **No contract-depth awareness**: bot does not know how many tricks the bidder team still needs vs. how many remain, so it cannot tighten or loosen play accordingly.
- **No end-game squeeze logic**: no attempt to count remaining high cards or plan multi-trick sequences.
- **Hard confidence cap at level 3 bid**: bot never bids above level 3 regardless of hand strength.
