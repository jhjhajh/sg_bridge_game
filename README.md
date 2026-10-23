# Fun Central

A multiplayer card-game hub built with Cloudflare Workers, Durable Objects,
D1 and a vanilla JavaScript frontend.

**Play:** <https://sgbridgegame.vocs.workers.dev> ·
**Repository:** <https://github.com/vocsong/funCentral> · Default branch: `master`

## Games

| Game | URL | Play |
| --- | --- | --- |
| Floating Bridge | [/bridge/](https://sgbridgegame.vocs.workers.dev/bridge/) | Four-player Singaporean Bridge: bid, call a secret partner and win tricks. Includes bots, spectators, Classic/2.5D views, history and replay. |
| Regicide | [/regicide/](https://sgbridgegame.vocs.workers.dev/regicide/) | Cooperative play for 1–4 players: use suit powers to defeat all 12 royals. Includes solo mode, spectators and separate ratings/stats. |

Choose a game from the hub, sign in with Telegram, create a room and share its
four-character code or invite link. Both games use the same account and saved
sign-in, but their ratings and leaderboards stay separate. Old Bridge invites
such as `/#ABCD` still redirect to `/bridge/#ABCD`.

In Telegram groups, **[@funCentral_bot](https://t.me/funCentral_bot)** shows
an inline **Bridge | Regicide** choice for `/newgame`; choosing a game creates
a room in that same group. `/newbridge` and `/newregicide` remain typed
shortcuts (`/newregicidegame` is also supported). The registered command menu
contains `/newgame`, `/leaderboard` and `/help` (`/start` also shows help).
Group boards count eligible group members.

### Bridge rules at a glance

- Four players, 52 cards, 13 cards each. Hands with ≤4 points are redealt.
- Points: A=4, K=3, Q=2, J=1, plus one per card beyond four in a suit.
- Bid levels 1–7 with suits ordered ♣ < ♦ < ♥ < ♠ < no trump.
- The winning bidder calls a card to select a secret partner.
- Follow suit when possible; trump beats the led suit. Trump normally cannot
  be led until broken, unless only trump remains.
- Bidder and partner need `bid level + 6` tricks. Play can end before all 13
  tricks once either side has secured the result.

## Local development

Use a current supported Node.js release compatible with the locked tools
(Node.js 20.3 or newer is required by the current Wrangler dependency).

```sh
git clone https://github.com/vocsong/funCentral.git
cd funCentral
npm ci --include=dev
```

Create a local-only `.dev.vars` and initialize **local** D1 using the
[development guide](docs/development.md), then run:

```sh
npm run dev
```

Open the localhost URL printed by Wrangler. The hub is `/`, Bridge is
`/bridge/` and Regicide is `/regicide/`. The Telegram widget does not work on
localhost; the documented dev-only login supports both games instead.

Before a PR, run `npm run test:pr` with an available Chromium browser. See
[testing](docs/testing.md) for setup, coverage and reporting requirements.

## Organization

- `src/index.ts` routes shared services and game APIs; room Durable Objects
  own authoritative gameplay and WebSocket connections.
- Bridge's established backend remains in `src/bridge.ts`, `src/game-room.ts`
  and related root modules. Its page is `static/bridge/`; existing client
  scripts and shared styles remain at the `static/` root.
- Regicide lives in `src/regicide/` and `static/regicide/`, with namespaced
  `/api/regicide/*` routes and `regicide_*` database tables.
- Future games should follow `src/<game>/`, `static/<game>/` and
  `/api/<game>/*`, with their own room class and game-specific statistics.
  No broad reorganization of Bridge is required.

See [architecture and adding a game](docs/architecture.md) for the full map,
shared components and extension checklist. Players receive game-specific
views, not unrestricted state; spectator views are explicit exceptions
(Bridge supports watching a seat or the full board).

## Deployment and documentation

**Do not run `npm run deploy` manually.** Merge a reviewed PR to `master`;
Cloudflare Workers Builds deploys the existing `sgbridgegame` service. The
legacy service/database names are intentional: preserve existing resources,
secrets, data and public URLs. Database migrations are a separate controlled
step; see [deployment](docs/deployment.md).

The [documentation index](docs/README.md) links current guides and historical
design/screenshot evidence. Root Python files and `.env.example` belong to
the archived Telegram-bot implementation, not the current Worker runtime.
