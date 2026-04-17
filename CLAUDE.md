# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A multiplayer Singaporean Floating Bridge card game running on Cloudflare Workers with Durable Objects for state management and WebSocket for real-time communication.

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

### Backend (Cloudflare Workers + Durable Objects)

- **`src/index.ts`** — Worker entry point. Routes `POST /api/create` (generates room code, provisions DO) and `/api/ws` (upgrades to WebSocket, delegates to DO).
- **`src/game-room.ts`** — The Durable Object. One instance per room. Holds the full `GameState` in DO storage, manages the WebSocket connections for all 4 players, and runs the entire game state machine (lobby → bidding → partner selection → play → game over).
- **`src/bridge.ts`** — Pure game logic: deck shuffling, hand generation (with wash/redeal rule for weak hands), point calculation, valid card determination, trick winner comparison.
- **`src/types.ts`** — `GameState`, `PlayerGameView`, `Player`, `Hand`, `TrickRecord` interfaces; constants (`NUM_PLAYERS=4`, `MAX_BID=34`).
- **`src/protocol.ts`** — Union types for all WebSocket messages (client→server and server→client).

### Frontend (Vanilla JS SPA)

- **`static/app.js`** — Connects via WebSocket, sends/receives messages, handles all screen transitions, auto-reconnects with exponential backoff.
- **`static/index.html`** — 6 screen states: home, lobby, bidding, partner selection, play, game-over.
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
