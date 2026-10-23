# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Fun Central** — a hub of multiplayer mini apps (card games) running on Cloudflare Workers with Durable Objects for state management and WebSocket for real-time communication. The original and largest app is Singaporean Floating Bridge; Regicide (co-op, 1–4 players) is the second.

## Fun Central (multi-app layout)

| URL | Files | Backend |
|-----|-------|---------|
| `/` | `static/index.html`, `static/hub.css` | — (hub with a tile per app) |
| `/bridge/` | `static/bridge/index.html` + root `static/app.js`, `hand.js`, `style.css`, `view.*` | `GameRoom` DO (`GAME_ROOM`), `/api/create`, `/api/ws`, … |
| `/regicide/` | `static/regicide/{index.html,regicide.js,regicide.css}` | `RegicideRoom` DO (`REGICIDE_ROOM`), `/api/regicide/create`, `/api/regicide/ws`, `/api/regicide/leaderboard` |

- **Bridge's `static/style.css` is the shared design system.** The hub and every app load `/style.css` and reuse its components (`.home-container`, `.lobby-container`, `.table` felt, `.seat-label`, `.game-info-bar`, `.card-hand.hand-fan`, `.card-mini`, `.btn*`); each app only adds its own small stylesheet on top.
- `static/fc-auth.js` — shared Telegram sign-in (same `localStorage.authToken` as Bridge, so one login works everywhere; dev login on localhost).
- `static/leaderboard.js` — the shared 🏆 Leaderboard card with a **Bridge | Regicide** switch, shown on the hub, Bridge home and Regicide home. The two boards stay separate.
- Old Bridge invite links (`/#ROOM`) are redirected by the hub to `/bridge/#ROOM`. Bridge invite messages now use `/bridge/#ROOM`.
- `localStorage.playerName` is shared across apps so a player's name carries over.
- **Adding an app:** put its page under `static/<app>/`, give it its own Durable Object class (new `[[migrations]]` tag in `wrangler.toml`, binding in `Env`, export from `src/index.ts`, and add it to `tests/ui/live-worker.cjs`), namespace its routes under `/api/<app>/`, and add a tile to `static/index.html`.

### Regicide (`src/regicide/`)
- **`engine.ts`** — pure rules engine (no Cloudflare deps), unit-tested in `tests/regicide-engine.test.ts`. Card codes are rank+suit letter (`7H`, `10S`, `KC`), Jesters `X1`/`X2`; pile index 0 = top. Actions (`playCards`, `yieldTurn`, `discardCards`, `chooseNextPlayer`, `flipSoloJester`) mutate the game and return an error string or `null`.
- **`room.ts`** — `RegicideRoom` DO: lobby (≤4 seats, first joiner hosts), start, relays actions to the engine, and broadcasts a per-player view (own hand only). Shuffles use a seeded PRNG kept in room state. Purges storage 30 min after the last socket disconnects.
- **Identity:** `/api/regicide/ws` turns a valid JWT into `playerId=tg_<id>` (+ the profile name); anything else becomes `guest_…`, which can watch but not take a seat.
- **Rating (`rating.ts`, `db.ts`, migration `0011_regicide.sql`):** separate from Bridge ELO. Score = royals defeated ÷ 12 (win = 1) vs an Elo expectation against a fixed castle rating of 1200; K = 32 for a player's first 30 games, then 16 (as in `elo.ts`). Rated once per game when won/lost, or when ended early after at least one royal fell. Tables: `regicide_ratings`, `regicide_games`, `regicide_rating_history`. `GET /api/regicide/leaderboard` returns Bridge's `{ top, me }` shape; `GET /api/regicide/stats` returns every rated player for the Bridge-style stats screen (`/regicide/?view=stats`: rating, games, wins, win%, best and average royals; min-games filter 3/10/20, no pairs).
- **Dev/test only (gated on `ALLOW_DEV_LOGIN=1`):** `POST /api/regicide/create { seed }` pins the shuffle; `POST /api/regicide/debug/patch?room=` merges fields into the live game to set up exact scenarios (used by `tests/ui/regicide-live.pw.js`).
- Rule calls worth knowing (from the official rulebook PDF; solo-yield from the official BGA adaptation): spades played before a Jester start shielding once it's played (clubs don't retro-double); **no yielding in solo**; the yield ban checks every other player's *last turn* (not a streak), so Jester reordering is handled; an empty hand is fine until you must cover damage or act; solo Jester flips are allowed at the start of Step 1 or Step 4; diamonds draw round-robin from the current player and skip full hands; an exact kill puts the royal on top of the tavern deck.

## Commands

```bash
npm install       # Install dependencies
npm run dev       # Start local dev server (simulates Durable Objects)
npm run deploy    # Deploy to Cloudflare Workers (requires wrangler login)
npm run typecheck # TypeScript type check without compiling
npm run test      # Run vitest
```

## Deployment

**Do not run `npm run deploy` manually.** Merging a PR to `master` triggers automatic Cloudflare deployment. Feature work should be done on a branch and merged via PR.

## Architecture

### Bridge Backend (Cloudflare Workers + Durable Objects)

- **`src/index.ts`** — Worker entry point. Routes `POST /api/create` (generates room code, provisions DO), `/api/ws` (upgrades to WebSocket), `/api/games/mine` + `/api/games/:gameId` (history + replay), and dev-only `/api/auth/dev`.
- **`src/game-room.ts`** — The Durable Object. One instance per room. Holds the full `GameState` in DO storage, manages the WebSocket connections for all 4 players, and runs the entire game state machine (lobby → bidding → partner selection → play → game over).
- **`src/bridge.ts`** — Pure game logic: deck shuffling, hand generation (with wash/redeal rule for weak hands), point calculation, valid card determination, trick winner comparison.
- **`src/types.ts`** — `GameState`, `PlayerGameView`, `Player`, `Hand`, `TrickRecord` interfaces; constants (`NUM_PLAYERS=4`, `MAX_BID=34`).
- **`src/protocol.ts`** — Union types for all WebSocket messages (client→server and server→client).
- **`src/history.ts`** — Per-user game list + full replay payload (D1 queries, server-side trick-winner computation, rating injection).
- **`src/move-rating.ts`** — Heuristic move rating engine (`rateGame`, `summarize`); labels each played card as best/good/inaccuracy/mistake/blunder.
- **`src/game-logging.ts`** — Writes `game_hands` (with per-seat `telegram_id`), `game_tricks`, and `game_metadata` (with `is_practice`). Runs for **all** games, including practice.

### Bridge Frontend (Vanilla JS SPA)

- **`static/app.js`** — Connects via WebSocket, sends/receives messages, handles all screen transitions, auto-reconnects with exponential backoff.
- **`static/bridge/index.html`** — 6 screen states: home, lobby, bidding, partner selection, play, game-over. (Served at `/bridge/`; it references the root-level `/app.js`, `/style.css`, etc.)
- **`static/style.css`** — CSS-only card rendering (no images), dark glassmorphism theme.

### Key Design Decisions

**Server-authoritative state:** All game state lives on the Durable Object. Each player's `PlayerGameView` contains only their own hand; others' hands are null. The partner identity is whispered privately.

**One DO per room:** `env.GAME_ROOM.getByName(roomCode)` — the room code is the DO name/key.

**WebSocket flow:** Client connects with `?room=CODE&playerId=ID` → Worker delegates `fetch()` to DO → DO accepts WebSocket via `server.accept()`. Same `playerId` on reconnect restores the session.

**Inactivity cleanup:** If all players disconnect, the DO sets a 5-minute alarm. On alarm, if still empty, all DO storage is purged.

### WebSocket Protocol

Client → Server:
```
join | bid | pass | selectPartner | playCard | playAgain
```

Server → Client:
```
state          # Full PlayerGameView (sent on reconnect and state changes)
joined | bidMade | bidWon | cardPlayed | trickWon | gameOver
youArePartner  # Whispered only to the partner
playerDisconnected | playerReconnected
```

### Game Rules Summary

- 4 players, 13 cards each; hands with ≤4 points are redealt
- Bidding: levels 1–7 × suits (♣ < ♦ < ♥ < ♠ < 🚫 no-trump), encoded as integers 0–34
- Bidder calls a card to designate their partner (secret until that card is played)
- Must follow suit; can't lead trump until trump has been broken
- Win condition: bidder + partner win ≥ (bid level + 6) tricks

## Bot AI (Intermediate)

Bots live entirely server-side in `src/game-room.ts`. All bot methods are private on `GameRoom`.

### Bidding (`getBotBid`)
- Calculate HCP (A=4 K=3 Q=2 J=1) + distribution bonus (+1 per card beyond 4 in any suit)
- < 12 pts → pass; 12–14 → level 1; 15–17 → level 2; 18+ → level 3 (hard cap)
- Trump suit = longest suit in hand (tiebreak: highest HCP). Suits ≤ 3 cards → prefer no-trump
- If preferred suit already bid, try next higher suits at same level up to no-trump; never overbid level

### Partner card selection (`getBotPartnerCard`)
- Picks the highest card the bidder doesn't hold (tries A♠ → K♠ → ... → 2♣)

### Card play (`getBotCard`) — confidence model
- **Before** partner card is played in a trick: confidence = 0.65
- **After** partner card revealed (checked by scanning if `state.partnerCard` is still in any hand): confidence = 0.85
- Each decision rolls `Math.random() < confidence`; failures fall back to basic logic (win if possible, else lowest)

### Bidder team play (`getBotCardAsBidderTeam`, `getBotLeadCard` with `onBidderTeam=true`)
- Following: if a teammate is currently winning → dump lowest (don't steal). If opposition winning → play lowest winning card, else dump lowest.
- Leading: prefer suit the **partner bid** (bid history signal = they have more of it). Else lead longest non-trump suit.

### Opposition play (`getBotCardAsOpposition`, `getBotLeadCard` with `onBidderTeam=false`)
- Following: if an opposition teammate already winning → dump lowest. Else try to win; if can't, dump lowest **non-trump** (conserve trump to block bidder later).
- Leading: never lead trump. Avoid suits the bidder or partner bid (they're strong there). Prefer neutral suits; fallback to any non-trump.

### Bid history as suit signal
`state.bidHistory` entries where `bidNum !== null` indicate the bidder/partner likely holds more of that suit.

## Telegram Bot (group chats)

Webhook `POST /api/telegram` → `parseUpdate` (`src/telegram.ts`, group/supergroup messages only) → `handleTelegramCommand` (`src/index.ts`). Always answers 200.

| Command | Aliases | Does |
|---|---|---|
| `/newbridge` | `/newgame` (original, kept) | Bridge room linked to the group; reply also hints at `/newregicide` |
| `/newregicide` | `/newregicidegame` | Regicide room linked to the group |
| `/leaderboard` | | Group board for both games (Bridge by ELO, Regicide by rating) |
| `/help` | `/start` | Lists the commands |

- **No BotFather step:** the "/" menu (`/newbridge`, `/newregicide`, `/leaderboard`; `/help` and the aliases work but aren't listed) is registered from code with `setMyCommands` (scope `all_group_chats`), once per Worker instance, on the first command it handles. Telegram delivers `/commands` to bots even in privacy mode, so new commands only need code. The one-time `setWebhook` registration is the only bot-owner setup.
- **Group Regicide rooms** check membership on join (`isChatMember`, as Bridge does). Non-members play and are rated globally but are flagged "⚠️ not in group" and don't count in `regicide_group_stats` (migration `0012`). The room posts lobby joins, the start, and the result with rating changes to the group.
- User-controlled names in new bot messages go through `escapeHtml` (messages use HTML parse mode).
- Tests: `tests/telegram.test.ts` (parser) and `tests/ui/telegram-live.pw.js` (live webhook with every Bot API call captured via Miniflare `outboundService` — nothing reaches Telegram).

## Game History & Replay

Completed games (practice *and* rated) are replayable from the home screen via **Match History**.

### Storage split
- **`game_hands`** — one row per (game_id, seat) with `telegram_id` (nullable for bots/guests), `initial_hand`, `final_hand`. This is the **participation index** — history queries find a user's games here.
- **`game_metadata`** — one row per game. Holds `bidder_seat`, `bid_num`, `trump_suit`, `partner_card`, `bid_history`, `seat_map`, `tricks_won`, `winning_team`, `is_practice`.
- **`game_tricks`** — one row per card played, keyed by `(game_id, trick_num, play_order)`.
- **`game_records`** — rated games only. Source of truth for leaderboard / ELO / head-to-head. **Practice games are deliberately excluded from this table** so they don't pollute stats.

### Key invariant
`game_hands` / `game_metadata` / `game_tricks` are written for **every** completed game (see the `waitUntil` block in `game-room.ts` after each win path). `game_records` / `recordGameStats` / `recordEloUpdate` are gated by `!isPracticeGame`.

### Replay authorization
`getGameReplay` checks the caller participated via `SELECT 1 FROM game_hands WHERE game_id = ? AND telegram_id = ?`. Do **not** switch this back to `game_records` — that would re-exclude practice games.

### Move rating (`src/move-rating.ts`)
Heuristic only (no DDS). Rates each played card:
- **best (★)** — cheapest winning card, or winning-card-when-partner-ahead
- **good (✓)** — reasonable play
- **inaccuracy (?!)** — suboptimal but not catastrophic
- **mistake (?)** — material error (e.g. wasted high card)
- **blunder (??)** — trumping partner, overtaking partner's winner, leading trump before it's broken

**Duo-aware knowledge model.** The engine derives `partnerSeat` from the initial hands (always known to the engine, not gated on the partner card being played). Per-play team identification goes through `perceivedTeam(observer, target)` which returns `'bidder' | 'opposition' | 'unknown'` from the observer's POV:
- Partner (the seat holding the partner card) privately knows all teams from trick 1.
- Bidder and opposition only fully know after the partner card is publicly played (`partnerCardPlayed`).
- Pre-reveal, a non-partner observer sees non-bidder seats as `'unknown'` and falls back to "play for the trick".

**Duo-vs-duo full-hand check.** `teammateCanWinTrick` looks across all four hands to see if the observer's *known* teammate, still to play in this trick, holds a guaranteed winner. If so, playing a loser is rated `'good'` ("Left the trick for partner") instead of `'mistake'`. Gated on the observer actually knowing their teammate (partner always; bidder/opposition only post-reveal).

`rateGame` takes a `RateGameInput` (not the full `GameReplay` — avoids a circular type). The engine is swappable; a DDS-backed version can replace `rateGame` without changing callers.

## Local Dev Login

Telegram Login Widget doesn't work on `localhost`. For local testing there's a dev-only path:
- `.dev.vars` sets `ALLOW_DEV_LOGIN=1` (file is gitignored; never commit)
- `POST /api/auth/dev { displayName }` mints a JWT for a deterministic fake `telegram_id` (hashed from the name, so the same name always hits the same row)
- The frontend shows a "Dev Login" box only when `location.hostname` is `localhost` / `127.0.0.1`
- The endpoint is gated by `env.ALLOW_DEV_LOGIN === '1'`, so it's a no-op in production

## Legacy Code

The root-level Python files (`bridge.py`, `handlers.py`, `main.py`, etc.) are an archived Telegram bot implementation. `bridge.py` was the original source of truth for game logic, which was ported to `bridge.ts`. The Python code is not actively deployed.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **sg_bridge_game** (482 symbols, 1484 relationships, 37 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/sg_bridge_game/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/sg_bridge_game/context` | Codebase overview, check index freshness |
| `gitnexus://repo/sg_bridge_game/clusters` | All functional areas |
| `gitnexus://repo/sg_bridge_game/processes` | All execution flows |
| `gitnexus://repo/sg_bridge_game/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
