# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Fun Central** — a multiplayer card-game hub on Cloudflare Workers, with Durable Objects for authoritative rooms/WebSockets, D1 for profiles/history/statistics, and a vanilla JavaScript frontend. Floating Bridge is the original four-player game; Regicide is cooperative for 1–4 players.

Repository: `https://github.com/vocsong/funCentral`, default branch `master`.
Start with [README.md](README.md) and the [documentation index](docs/README.md).
Current guides: [architecture / adding a game](docs/architecture.md),
[local development](docs/development.md), [testing](docs/testing.md),
[deployment / migrations](docs/deployment.md).

## Fun Central (multi-app layout)

| URL | Files | Backend |
|-----|-------|---------|
| `/` | `static/index.html`, `static/hub.css` | — (hub with a tile per app) |
| `/bridge/` | `static/bridge/index.html` + root `static/app.js`, `hand.js`, `style.css`, `view.*` | `GameRoom` DO (`GAME_ROOM`), `/api/create`, `/api/ws`, … |
| `/regicide/` | `static/regicide/{index.html,regicide.js,regicide.css}` | `RegicideRoom` DO (`REGICIDE_ROOM`), `/api/regicide/create`, `/api/regicide/ws`, `/api/regicide/leaderboard` |

- **Root `static/style.css` is the shared design system.** The hub and every app load `/style.css` and reuse its components (`.home-container`, `.lobby-container`, `.table` felt, `.seat-label`, `.game-info-bar`, `.card-hand.hand-fan`, `.card-mini`, `.btn*`); each app only adds its own small stylesheet on top.
- Shared auth endpoints/profile and `localStorage.authToken` give both games one sign-in. Bridge retains its login flow in `static/app.js`; other clients use `static/fc-auth.js`. Dev login is local-only.
- `static/leaderboard.js` — the shared 🏆 Leaderboard card with a **Bridge | Regicide** switch, shown on the hub, Bridge home and Regicide home. The two boards stay separate.
- Old Bridge invite links (`/#ROOM`) are redirected by the hub to `/bridge/#ROOM`. Bridge invite messages now use `/bridge/#ROOM`.
- `localStorage.playerName` is shared across apps so a player's name carries over.
- Bridge's existing backend paths and `/api/create` / `/api/ws` compatibility routes intentionally remain in place. No broad layout move is required.
- `src/games.ts` exports the typed `GAME_CATALOG` for Telegram choices (`id`, `name`, `path`, `telegramCommand`, `players`, `emoji`). Hub tiles remain static HTML; there is no automated website catalog endpoint.
- **Adding an app:** use `src/<game>/`, `static/<game>/` and `/api/<game>/*`; add its own room class/binding with a new incremental DO migration and game-prefixed D1 tables. Update `Env`, Worker exports, the catalog, hub tiles and local test harnesses. Follow the [extension checklist](docs/architecture.md#adding-another-game).

### Regicide (`src/regicide/`)
- **`engine.ts`** — pure rules engine (no Cloudflare deps), unit-tested in `tests/regicide-engine.test.ts`. Card codes are rank+suit letter (`7H`, `10S`, `KC`), Jesters `X1`/`X2`; pile index 0 = top. Actions (`playCards`, `yieldTurn`, `discardCards`, `chooseNextPlayer`, `flipSoloJester`) mutate the game and return an error string or `null`.
- **`room.ts`** — `RegicideRoom` DO: lobby (≤4 seats, first seated player hosts), start, engine actions and per-player views (spectators get no private hand). Shuffles use a seeded PRNG in room state. Authoritative transitions are saved before external I/O; delayed membership/rating callbacks merge into the latest state. A durable completion outbox retries D1 failures and survives restarts. Empty rooms purge after 30 minutes only when no results remain pending.
- **Identity:** `/api/regicide/ws` turns a valid JWT into `playerId=tg_<id>` (+ the profile name); anything else becomes `guest_…`, which can watch but not take a seat.
- **Rating (`rating.ts`, `db.ts`, migration `0011_regicide.sql` — all four Regicide tables, `CREATE … IF NOT EXISTS` only):** separate from Bridge ELO. Score = royals defeated ÷ 12 (win = 1) vs an Elo expectation against a fixed castle rating of 1200; K = 32 for a player's first 30 games, then 16 (as in `elo.ts`). Rated once per game when won/lost, or when ended early after at least one royal fell. Tables: `regicide_ratings`, `regicide_games`, `regicide_rating_history`, `regicide_group_stats`. Until they exist in an environment, Regicide still plays; only ratings/boards/stats are empty, and Bridge (incl. the bot's `/leaderboard`) is unaffected. `GET /api/regicide/leaderboard` returns Bridge's `{ top, me }` shape; `GET /api/regicide/stats` returns every rated player for the Bridge-style stats screen (`/regicide/?view=stats`: rating, games, wins, win%, best and average royals; min-games filter 3/10/20, no pairs).
- **Dev/test only (gated on `ALLOW_DEV_LOGIN=1`):** `POST /api/regicide/create { seed }` pins the shuffle; `POST /api/regicide/debug/patch?room=` merges fields into the live game to set up exact scenarios (used by `tests/ui/regicide-live.pw.js`).
- Rule calls worth knowing (from the official rulebook PDF; solo-yield from the official BGA adaptation): spades played before a Jester start shielding once it's played (clubs don't retro-double); **no yielding in solo**; the yield ban checks every other player's *last turn* (not a streak), so Jester reordering is handled; an empty hand is fine until you must cover damage or act; solo Jester flips are allowed at the start of Step 1 or Step 4; diamonds draw round-robin from the current player and skip full hands; an exact kill puts the royal on top of the tavern deck.

## Commands

```sh
npm ci --include=dev           # Locked tooling, even if devDependencies were omitted
npm run dev                   # Local Worker, room Durable Objects and assets
npm run typecheck             # TypeScript check without emitting files
npm test -- --maxWorkers=2     # Bounded unit/runtime regressions
npm run test:e2e               # Selected live-worker and browser input checks
npm run test:ui                # Complete Chromium Playwright suite
npm run test:pr                # Required repeatable PR validation
```

The PR runner performs typecheck, Vitest with two workers, the full Chromium
suite with Classic hand settings, then the complete hand-layout suite in 2.5D.
Use an already available browser; commands do not install browsers, access
production D1 or deploy. Report actual results and device/emulation limits.

## Deployment

**Never run `npm run deploy` manually.** A PR merge to `master` triggers
Cloudflare Workers Builds. Keep Worker `sgbridgegame`, D1 `sg-bridge-users`,
existing bindings/secrets and public URL `https://sgbridgegame.vocs.workers.dev`.
Required existing secrets are `JWT_SECRET` and `TELEGRAM_BOT_TOKEN`; the public
username is `funCentral_bot`. Production `ALLOW_DEV_LOGIN` must be absent.

DO migrations retain `GAME_ROOM`/`GameRoom` at `v1` and add
`REGICIDE_ROOM`/`RegicideRoom` at `v2` automatically during deployment.
D1 SQL is a separate controlled step: inspect the remote schema/ledger and
pending list first; never replay destructive `0006_stats_reset.sql`.
See [deployment](docs/deployment.md) for the workflow and rollout checkpoint.

## Architecture

### Bridge Backend (Cloudflare Workers + Durable Objects)

- **`src/index.ts`** — Shared Worker entry point. Routes Bridge's `POST /api/create`, `/api/ws`, `/api/games/mine` + `/api/games/:gameId`, namespaced Regicide APIs, shared auth/profile and Telegram updates.
- **`src/game-room.ts`** — Bridge's `GameRoom`, one instance per room. Holds `GameState` in DO storage, manages player/spectator WebSockets and runs lobby → bidding → partner selection → play → game over.
- **`src/bridge.ts`** — Pure game logic: deck shuffling, hand generation (with wash/redeal rule for weak hands), point calculation, valid card determination, trick winner comparison.
- **`src/types.ts`** — `GameState`, `PlayerGameView`, `Player`, `Hand`, `TrickRecord` interfaces; constants (`NUM_PLAYERS=4`, `MAX_BID=34`).
- **`src/protocol.ts`** — Bridge client/server WebSocket message unions (Regicide owns its separate protocol in `src/regicide/room.ts`).
- **`src/history.ts`** — Per-user game list + full replay payload (D1 queries, server-side trick-winner computation, rating injection).
- **`src/move-rating.ts`** — Heuristic move rating engine (`rateGame`, `summarize`); labels each played card as best/good/inaccuracy/mistake/blunder.
- **`src/game-logging.ts`** — Writes `game_hands` (with per-seat `telegram_id`), `game_tricks`, and `game_metadata` (with `is_practice`). Runs for **all** games, including practice.

### Bridge Frontend (Vanilla JS SPA)

- **`static/app.js`** — Connects via WebSocket, sends/receives messages, handles all screen transitions, auto-reconnects with exponential backoff.
- **`static/bridge/index.html`** — Bridge screens for home, role choice, lobby, bidding, partner selection, play/results, spectators, history/replay and stats. Served at `/bridge/`, referencing root-level `/app.js`, `/style.css`, etc.
- **`static/style.css`** — CSS-only card rendering (no images), dark glassmorphism theme.

### Key Design Decisions

**Server-authoritative state:** Rooms validate all actions and build recipient-specific views. A seated Bridge player sees their own hand; spectators can explicitly watch a seat or the full board. Partner identity is private until the called card is played, then public (also revealed at game over).

**One DO per room, per game:** Bridge uses `GAME_ROOM.getByName(roomCode)`; Regicide uses its own `REGICIDE_ROOM` namespace.

**WebSocket flow:** Clients send room/session information and a saved token when available. The Worker verifies identity, forwards to the game's DO, and the room accepts with `ctx.acceptWebSocket()` (hibernation API), serializing session attachments for reconnect/rehydration. Client-supplied names/IDs do not replace verified identity.

**Inactivity cleanup:** Empty Bridge rooms use a five-minute alarm. Regicide uses 30 minutes and preserves pending result work until successful persistence.

### WebSocket Protocol

Use `src/protocol.ts` for the complete Bridge message unions and
`src/regicide/room.ts` for Regicide messages/views. Both include more than
basic card actions: lobby/host controls, spectators and reconnect behavior
must stay consistent with their respective clients. Do not share a game's
message schema merely because both use WebSockets.

### Game Rules Summary

- 4 players, 13 cards each; hands with ≤4 points are redealt
- Bidding: levels 1–7 × suits (♣ < ♦ < ♥ < ♠ < 🚫 no-trump), encoded as integers 0–34
- Bidder calls a card to designate their partner (secret until that card is played)
- Must follow suit; can't lead unbroken trump unless only trump remains
- Bidder + partner need ≥ (bid level + 6) tricks; the game ends as soon as either side secures the contract result, possibly before all 13 tricks

## Bridge bots

Bots run server-side in `src/game-room.ts`; full-information God bot decisions
live in `src/god-bot.ts`. The server supports Basic, Intermediate, Advanced,
Sophisticated and God levels; the lobby exposes Intermediate, Advanced,
Sophisticated and God controls. Do not assume one level's heuristics describe
all bots. Games starting with two or more bots are practice/unrated; that
status is snapshotted at the deal and still permits participant history/replay.

## Telegram Bot (group chats)

`POST /api/telegram` handles group/supergroup commands and inline-menu
callbacks. `src/telegram.ts` owns parsing/Bot API helpers; `src/index.ts`
dispatches to the game room namespaces. `GAME_CATALOG` in `src/games.ts`
provides the available games and their choice metadata; static hub tiles
remain separately authored.

| Command | Aliases | Does |
|---|---|---|
| `/newgame` | | Shows inline Bridge/Regicide choices; selection creates a room in the same group |
| `/newbridge` | | Creates a Bridge room directly |
| `/newregicide` | `/newregicidegame` | Creates a Regicide room directly |
| `/leaderboard` | | Group board for both games (Bridge ELO, separate Regicide rating) |
| `/help` | `/start` | Lists the commands |

- `/newgame` is **not** a Bridge alias. Buttons use `callback_data=newgame:<id>`; selection callbacks are acknowledged before room creation in the originating group. Unsupported/private selections are acknowledged without creating rooms.
- The registered "/" menu is `newgame`, `leaderboard`, `help`, managed from code with `setMyCommands` for group chats. Typed game shortcuts remain supported but need not appear in that menu. Game additions do not need a manual BotFather command-menu update; webhook/domain changes remain intentional bot-owner operations.
- Group Regicide joins verify membership. Non-members can play and be rated globally but are flagged "⚠️ not in group" and excluded from `regicide_group_stats`. Lobby/start/result posts go to the linked group.
- Escape user-controlled names in HTML bot messages. Keep games' ratings and group boards separate.
- `tests/telegram.test.ts` and `tests/ui/telegram-live.pw.js` cover parsing/local webhook behavior with Bot API calls captured via Miniflare `outboundService`; they do not establish real Telegram/WebView compatibility. See [testing](docs/testing.md) for chooser/callback regression requirements.

## Bridge Game History & Replay

Completed Bridge games (practice *and* rated) are replayable from the Bridge home screen via **Match History**.

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

Telegram Login Widget doesn't work on `localhost`. Both games support a dev-only path; use [local setup](docs/development.md), not the legacy `.env.example`:
- `.dev.vars` sets a local-only `JWT_SECRET` and `ALLOW_DEV_LOGIN=1` (file is gitignored; never commit)
- `POST /api/auth/dev { displayName }` mints a JWT for a deterministic fake `telegram_id` (hashed from the name, so the same name always hits the same row)
- The frontend shows a "Dev Login" box only when `location.hostname` is `localhost` / `127.0.0.1`
- The endpoint is gated by `env.ALLOW_DEV_LOGIN === '1'`; the flag must be absent in production, not merely hidden by the frontend

## Legacy Code

The root-level Python files (`bridge.py`, `handlers.py`, `main.py`, etc.), Python directories, `requirements.txt`, Docker setup, `start_local.sh` and `.env.example` are archived Telegram-bot implementation material. `bridge.py` supplied the original rules ported to `src/bridge.ts`. Do not reorganize/delete these as part of game additions; they are not the deployed Worker setup.

Dated plans/specs, feature notes and screenshot/validation folders remain
historical evidence. Use the [documentation index](docs/README.md) to distinguish
them from current setup, architecture and validation instructions.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

The canonical checkout is indexed by GitNexus as **funCentral**. Linked worktrees can have their own index names; select the index for the checkout being edited. Use GitNexus to understand code, assess impact, and navigate safely.

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
3. `READ gitnexus://repo/funCentral/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "master"})` — see what your branch changed

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
| `gitnexus://repo/funCentral/context` | Codebase overview, check index freshness |
| `gitnexus://repo/funCentral/clusters` | All functional areas |
| `gitnexus://repo/funCentral/processes` | All execution flows |
| `gitnexus://repo/funCentral/process/{name}` | Step-by-step execution trace |

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
