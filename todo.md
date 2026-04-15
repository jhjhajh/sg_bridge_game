---

## SPEC — Disconnect / leave: Bot takeover after 3 minutes, rejoin, and rated override

### Goal

1. **Bot takeover (after 3 minutes):** When a seated human **disconnects or leaves** during **`bidding`** or **`play`**, the seat **remains empty for 3 continuous minutes**. If the player has not rejoined by then, a **sophisticated** bot immediately replaces that seat and continues the game on their behalf (same game id).
2. **Rejoin and takeover:** If the original player **rejoins before the game ends** (either before or after bot takeover), they can **immediately take over the seat** from the bot and resume playing.
3. **Elo attribution:** **Whoever finishes the game** (bot or player) — the **original player** gets the Elo result (win/loss). The result is based purely on the game outcome. **No penalty** for abandonment; the player just plays (via bot or themselves) until the deal ends.
4. **Rated override:** If the game **began** as **1 bot + 3 humans** and **one human** drops (so the table becomes **2 bots + 2 humans**), the match remains **rated** — i.e. do **not** downgrade to practice solely because the bot count increased mid-game.

### Scope (phases)

- Applies when phase is **`bidding`** or **`play`** (not lobby-only disconnect unless extended later).
- Timer / takeover logic should be **server-authoritative** (Durable Object).
- **Leave button** shows confirmation prompt during bidding/play informing them the seat will be taken over by a bot after 3 minutes of disconnect.

### Acceptance

- Bot substitution uses the **sophisticated** bot profile (not basic/intermediate) for the taken-over seat.
- Bot plays with **incomplete information** — it does not see cards of the original player's hand; it makes decisions based only on public board state.
- **Elo attribution:** The game result (win/loss) is recorded under the **original player's ID**, regardless of whether the bot or player finished the deal. **Bots do not earn Elo**.
- `isPractice` is computed from **composition at deal start**, so mid-game bot substitution does **not** flip a rated game to practice.
- Rejoining player **immediately replaces the bot** and resumes from the current game state.

### Clarified Requirements

- **Disconnect vs Leave:** Same treatment for explicit **Leave** button and socket drop.
- **Continuous 3 minutes:** Must be continuous disconnect; if they rejoin within 3 minutes, no bot takeover occurs (timer resets).
- **Lobby disconnect:** No bot takeover; this rule applies only to bidding/play phases.
- **No penalty:** The player simply plays via bot and receives the game result. No additional penalties or bonuses.

---

## SPEC — “Abandon” (replaces top-right Leave during deal)

### Goal

During **`bidding`** or **`play`**, allow a **seated player to initiate an abandon vote** to end the current deal early and return all players to the lobby. The vote is **visible to all seated players** (spectators can view but do not vote).

### Flow

1. Player A clicks **Abandon** → server starts an **abandon vote** **visible to all seated players**.
2. **Each connected human player** (not bots) gets a prompt: **OK** (agree to abandon) or **No** (reject).
3. **Unanimous OK from all connected humans:** The current deal **ends without normal finish**, move **everyone** back to **game lobby** (same room code). The hand is **void** — no Elo result recorded for anyone (no penalty, no win/loss).
4. **Any No:** vote **cancels**, game **continues** unchanged.
5. **Timeout:** If a player doesn't respond within **1 minute**, vote **auto-accepts** for them (vote proceeds as if they said OK).

### Acceptance

- Only one abandon proposal at a time; stale proposals invalidated if phase changes.
- **Bots do not vote**; they don't block a vote and don't count toward quorum.
- **Spectators see the vote UI but do not vote** — they are read-only observers.
- **Quorum:** Only **connected human players** must vote unanimously; disconnected players do not block the vote.
- **Elo:** Abandoned hand is **void** — no rated result, no penalty, no delta for anyone.
- Server-authoritative: clients cannot force lobby without Durable Object agreement.

### Clarified Requirements

- **Outside bidding/play (lobby):** The button label remains **Leave** (no vote; instant exit).
- **During bidding/play:** Button label is **Abandon** (triggers vote flow above).
- **Leave vs disconnect:** This spec handles the **explicit Abandon button**. Disconnects are handled separately (see bot takeover spec above).

