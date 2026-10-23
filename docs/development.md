# Local development

The current app is the TypeScript Worker and the `static/` frontend, not the
archived Python bot. Start with the [architecture](architecture.md) for game
boundaries and [testing](testing.md) for PR validation.

## Checkout and dependencies

```sh
git clone https://github.com/vocsong/funCentral.git
cd funCentral
npm ci --include=dev
```

Use a supported Node.js release compatible with the locked Wrangler and
Playwright versions (the current Wrangler requires Node.js ≥20.3).
All app tooling is in `devDependencies`: an environment that omits dev
packages must explicitly include them. Use the lockfile, not a global
Wrangler install, as the tooling source of truth.

The default branch is `master`. Work on a feature branch and merge via PR;
merging to `master` triggers a production build/deployment.

## Local-only configuration

Create `.dev.vars` at the repository root:

```dotenv
JWT_SECRET=local-development-only-not-a-production-secret
ALLOW_DEV_LOGIN=1
```

These are safe local placeholders, not production credentials. `.dev.vars`
is gitignored and must stay uncommitted. Do not copy production secrets into
examples or test commands. `.env.example` and `start_local.sh` belong to the
archived Python implementation and are not Worker setup instructions.

Telegram's Login Widget does not work on localhost. On `localhost` or
`127.0.0.1`, the Bridge and Regicide login screens expose **Dev Login**.
With `ALLOW_DEV_LOGIN=1`, `/api/auth/dev` creates a local profile and signed
token; the same display name maps to the same synthetic identity. Both
games share the sign-in token and profile. Production must have
`ALLOW_DEV_LOGIN` **absent**; never enable dev auth/debug routes there.

Local dev login does not require a real Telegram bot token. Do not exercise
real bot/webhook commands from local development unless intentionally
configured; automated bot coverage captures outbound requests instead.

## Initialize local D1 and run

Wrangler uses local D1 and Durable Object storage with the checked-in
configuration. On a fresh local database:

```sh
npx wrangler d1 migrations list sg-bridge-users --local
npx wrangler d1 migrations apply sg-bridge-users --local
npm run dev
```

For an existing local database, inspect its schema and migration ledger
before applying pending SQL. `0006_stats_reset.sql` resets statistics; do
not blindly replay SQL files against data you want to keep. The migration
ledger, not repeated `--file` commands, should determine what runs.
See [deployment](deployment.md) for the stricter remote workflow.

Open the localhost URL printed by Wrangler (normally port 8787):

| URL | Purpose |
| --- | --- |
| `/` | Fun Central game hub and shared leaderboard |
| `/bridge/` | Bridge home, rooms, history/replay and statistics |
| `/regicide/` | Regicide home and rooms |
| `/regicide/?view=stats` | Regicide statistics |

Create a room after signing in and open another browser context to join as
a different player. Separate contexts avoid sharing `localStorage` identity.
Wrangler's local state lives under `.wrangler/`; automated suites create
and clean their own temporary storage rather than using production D1.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local Worker, room Durable Objects and static assets |
| `npm run typecheck` | TypeScript check without emitting files |
| `npm test -- --maxWorkers=2` | Bounded Vitest rules/unit/runtime regressions |
| `npm run test:e2e` | Selected live-worker and browser interaction suites |
| `npm run test:ui` | Complete Chromium Playwright suite |
| `npm run test:pr` | Typecheck, bounded Vitest, full browser suite and repeated 2.5D hand suite |

A compatible browser must already be installed/configured; no test command
installs one. Use [testing](testing.md) for ports, coverage boundaries and
reporting. Do not run `npm run deploy` as a development or validation step.

For a new mini app, follow the [extension checklist](architecture.md#adding-another-game)
instead of moving Bridge's established files or copying its state machine.
