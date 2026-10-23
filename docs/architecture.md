# Fun Central architecture

Fun Central is one Cloudflare Worker serving a hub and independent multiplayer
games. Share identity and presentation where useful, not game state or rating
systems. [Development](development.md), [deployment](deployment.md) and
[testing](testing.md) cover operations.

## Runtime and routes

| Area | Browser entry | Backend / storage |
| --- | --- | --- |
| Hub | `/` → `static/index.html`, `hub.css` | Static game tiles and shared leaderboard |
| Bridge | `/bridge/` → `static/bridge/index.html` | `GameRoom` via `GAME_ROOM`; existing `/api/create`, `/api/ws`, history/stats APIs |
| Regicide | `/regicide/` → `static/regicide/` | `RegicideRoom` via `REGICIDE_ROOM`; `/api/regicide/*`; `regicide_*` D1 tables |
| Shared services | Same-origin clients | Telegram auth, `/api/me`, `/api/config`, `/api/telegram`, shared users/groups in D1 |

`src/index.ts` routes requests and exports the room classes. A room code names
a Durable Object within the relevant game's namespace, so the games have
independent rooms even when codes match. Both room classes use the hibernation
API, `ctx.acceptWebSocket()`, with persisted session attachments and room state.

The existing Bridge API URLs are compatibility routes and remain supported;
new games must not take them over. The hub redirects legacy `/#ROOM` invites
to `/bridge/#ROOM`. New invites identify their game explicitly.

## Code map

```text
src/
  index.ts               Worker routing, auth endpoints, Telegram dispatch
  games.ts               Typed available-games catalog for Telegram choices
  auth.ts, player-name.ts
  db.ts                  Shared users/groups and existing Bridge queries
  bridge.ts              Bridge rules
  game-room.ts           Bridge room, bots, chat and lifecycle
  types.ts, protocol.ts   Existing Bridge state and WebSocket types; Env bindings
  god-bot.ts             Bridge full-information bot
  history.ts, game-logging.ts, move-rating.ts
  elo.ts, stats*.ts, betting-db.ts
  telegram.ts            Telegram parsing and Bot API helpers
  regicide/
    engine.ts            Pure Regicide rules
    room.ts              Regicide room and durable completion outbox
    rating.ts, db.ts      Separate Regicide rating/statistics persistence
static/
  index.html, hub.css    Hub tiles
  bridge/index.html     Bridge page
  app.js, hand.js        Established Bridge client and hand interaction code
  style.css             Shared card/table/component design system
  view.js, view.css      Bridge Classic/2.5D presentation
  fc-auth.js            Shared auth helper for other game clients
  leaderboard.js        Shared leaderboard card with separate game boards
  regicide/             Regicide page, client and game-specific styles
migrations/             Ordered D1 schema/data migrations
tests/                  Unit/runtime regressions and tests/ui browser suites
```

Bridge predates the hub. Its backend and browser assets intentionally remain
at their established paths; `static/style.css` is at the root, not inside
`static/bridge/`. Adding another game does not require moving Bridge first.
The Python files, `bot/`, `game/`, `requirements.txt`, Docker files and
`.env.example` are archived implementation material, not the Worker runtime.

## Shared services and game boundaries

- **Identity:** Telegram Login Widget verification and JWTs are shared.
  `localStorage.authToken` and the saved `playerName` work across this origin.
  Bridge keeps its client login flow in `app.js`; Regicide uses `fc-auth.js`.
  A URL/player name, bot link or unverified Mini App data is not authentication.
- **Presentation:** reuse `/style.css` components for cards, felt, seats,
  buttons and layouts; layer game-specific CSS above them. Shared style or
  leaderboard changes need regression coverage on the hub and both games.
- **Leaderboards:** `leaderboard.js` presents separate Bridge and Regicide
  boards. Sharing a card does not merge scores or rating algorithms.
- **Telegram:** `/newgame` presents inline choices from `GAME_CATALOG` in
  `src/games.ts`. Entries carry `id`, `name`, `path`, `telegramCommand`,
  `players` and `emoji`; button data is `newgame:<id>`. Selection callbacks
  are acknowledged before creating a room in the originating group;
  unsupported/private selections are acknowledged without creating rooms.
  Typed `/newbridge` and `/newregicide` shortcuts remain, as does
  `/newregicidegame`. The registered menu is `newgame`, `leaderboard`, `help`.
  Static hub tiles are still authored in `static/index.html`; the catalog
  neither generates those tiles nor exposes an automated website endpoint.
- **Authority and visibility:** clients submit actions; rooms validate them
  and broadcast game-specific views. Seated players normally see only their
  own hand. Bridge spectators can watch a selected seat or the full board;
  Regicide spectators do not receive a private hand. Bridge reveals partner
  identity publicly when the called card is played (and at game over).

## Persistence and lifecycle

Room state and reconnect/session data live in Durable Object storage; D1
holds shared profiles/groups and persistent game statistics/history.

- Bridge's existing tables and `users.elo` remain unchanged. Practice status
  is snapshotted at deal time (two or more bots); practice games are logged
  for participant history/replay but excluded from rated records and ELO.
  A game ends once the contract result is determined, not necessarily after
  all 13 tricks. Empty Bridge rooms use a five-minute cleanup alarm.
- Regicide owns `regicide_ratings`, `regicide_games`,
  `regicide_rating_history` and `regicide_group_stats`. Rating measures team
  progress against the castle, independently of Bridge ELO. Wins/losses are
  rated; ending early counts after at least one royal has fallen.
- Regicide saves authoritative transitions before asynchronous D1/Telegram
  work. A durable pending-result outbox survives restarts and retries through
  alarms. Completion writes are transactional/idempotent; concurrent games
  add rating deltas rather than overwriting newer ratings. Delayed external
  acknowledgements merge into the latest room state, not an old snapshot.
- Regicide cleans up after 30 minutes without sockets **only after pending
  results are resolved**. Missing Regicide tables leave boards/stats empty
  and results queued for retry; gameplay and Bridge remain available. This
  compatibility behavior is not a substitute for applying migrations.
- Global Regicide results count signed-in players; group statistics count
  verified members of the linked Telegram group.

D1 SQL migrations and Durable Object class migrations are separate. Existing
bindings are `GAME_ROOM`/`GameRoom` (`v1`) and
`REGICIDE_ROOM`/`RegicideRoom` (`v2`). Keep those identities and add incremental
migrations for future classes. See [deployment](deployment.md).

## Adding another game

1. Choose a stable URL slug. Put rules, room/protocol types and game-specific
   persistence in `src/<game>/`; keep pure rules independent of Cloudflare
   APIs where possible. Put the page/client/styles in `static/<game>/`.
2. Namespace APIs under `/api/<game>/*`. Add the game to the typed
   `src/games.ts` catalog and wire room creation/callback dispatch. Add its
   tile to `static/index.html` separately; include game-specific invite URLs
   and a link back to `/`.
3. Give real-time rooms their own Durable Object class and binding. Update
   `Env` in `src/types.ts`, export the class from `src/index.ts`, add the
   binding in `wrangler.toml` and append a **new** migration tag. Never edit
   old `v1`/`v2` tags to repurpose existing storage.
4. Reuse verified auth/profile handling, shared styling and the leaderboard
   component where appropriate. Define seating, spectators, reconnection,
   hidden information, host controls and cleanup explicitly for the game.
5. Add game-prefixed D1 tables through a new incremental SQL migration.
   Keep each game's ratings/history distinct; do not rename or reset Bridge
   tables. If publishing results asynchronously, make retries durable and
   completion writes idempotent.
6. Add the room binding to `tests/ui/live-worker.cjs` and any relevant test
   harness. Cover rules plus real local API/WebSocket flows, identity,
   spectators, reloads, persistence/retries and shared hub compatibility.
   Test Telegram choices/callbacks with captured outbound calls, not Telegram.
7. Update the hub, catalog, help/leaderboards, guides and coverage together.
   Run the required [PR checks](testing.md); review D1 migrations separately
   before the PR merge triggers Workers Builds. Do not deploy manually.

No shared game superclass or repository-wide layout migration is required.
