# Deployment and migrations

## Production identity and release path

- Repository: <https://github.com/vocsong/funCentral>; default/release branch:
  **`master`**.
- Merge a reviewed PR to `master` to trigger **Cloudflare Workers Builds**.
  **Never run `npm run deploy` manually.** Its script exists, but it is not
  the release or validation workflow.
- Existing Worker/service: **`sgbridgegame`**.
- Public URL: <https://sgbridgegame.vocs.workers.dev>.
- Existing D1 database: **`sg-bridge-users`**, binding **`DB`**.
- Existing secrets: **`JWT_SECRET`** and **`TELEGRAM_BOT_TOKEN`**.
- Public variable: **`TELEGRAM_BOT_USERNAME=funCentral_bot`**.
- **`ALLOW_DEV_LOGIN` must be absent in production.** It also gates Regicide
  seed/debug conveniences; it is not just a UI switch.

Fun Central is the product/repository name, not a reason to rename existing
Cloudflare resources. Keep the service/database names, binding identities,
secrets and URLs so existing data, Telegram integration and links survive.
Never put credential values in documentation, shell arguments or commits.

Run [PR validation](testing.md) before opening/updating a PR. Tests use local
storage, never deploy and do not establish production or real Telegram
compatibility. After merge, inspect the Workers Builds result and verify the
hub, game links, sign-in and relevant room/leaderboard flows on the deployed
version; do not treat a successful build alone as application verification.

## Durable Object migrations are part of deployment

`wrangler.toml` retains:

| Binding | Class | Migration |
| --- | --- | --- |
| `GAME_ROOM` | `GameRoom` | `v1` creates the existing SQLite-backed Bridge class |
| `REGICIDE_ROOM` | `RegicideRoom` | `v2` adds the separate SQLite-backed Regicide class |

Workers deployment applies the configured class migration. Keep `v1` and
`GAME_ROOM` intact; `v2` does not replace Bridge. Future games append a new
migration tag, binding and exported class. These are **not D1 SQL migrations**.

## D1 migrations are a separate controlled step

Do not assume Workers Builds runs D1 SQL migrations. Before any remote
change, confirm the target/account, inspect the actual schema **and** ledger,
read pending SQL and review its data impact. Historical environments may have
had SQL applied manually, so a missing ledger entry alone does not prove the
schema change is missing.

Read-only inspection from the repository root:

```sh
npx wrangler d1 migrations list sg-bridge-users --remote
npx wrangler d1 execute sg-bridge-users --remote --command "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name"
npx wrangler d1 execute sg-bridge-users --remote --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
```

If the ledger table does not exist or does not match the schema, stop and
reconcile that discrepancy before using the migration runner. Do not rerun
historical files to make the ledger appear complete. In particular,
**`0006_stats_reset.sql` resets ELO/wins/game counts and deletes history,
game records and group statistics**. It must not be replayed against existing
production data. `0010` also contains non-repeatable `ALTER TABLE` operations.

Only after inspecting/reconciling the ledger, confirming the pending list and
reviewing a recovery plan, an authorized maintainer applies migrations:

```sh
npx wrangler d1 migrations apply sg-bridge-users --remote
npx wrangler d1 migrations list sg-bridge-users --remote
```

Verify the resulting schema, ledger and affected application flows afterwards.
Use `--local` for ordinary development; never substitute `--remote` merely to
unblock a local test.

### Hub/Regicide rollout checkpoint

At the verified hub/Regicide rollout checkpoint, remote migrations
`0010_practice_in_history.sql` and `0011_regicide.sql` had been applied
successfully and the ledger showed no pending migrations. This is a
historical checkpoint, **not a permanent assertion about any environment**;
repeat the read-only inspection before future changes.

- `0010` adds participant identity to Bridge hand logs and practice metadata
  so practice games appear in participant history without affecting ratings.
- `0011` creates four Regicide tables (`regicide_ratings`, `regicide_games`,
  `regicide_rating_history`, `regicide_group_stats`) and two indexes, using
  `CREATE … IF NOT EXISTS`. It neither resets nor renames Bridge data.
- With Regicide tables missing, its gameplay remains available and
  leaderboard/stat APIs return empty data; completion persistence retries
  from its durable outbox. Bridge, including the bot's Bridge board, remains
  independent. Apply the migration rather than relying on this fallback.

## Telegram integration

The existing bot is **[@funCentral_bot](https://t.me/funCentral_bot)**. Its
webhook is `/api/telegram` on the existing Worker origin. Bot-owner webhook
or domain changes are separate intentional operations, not prerequisites for
each game addition or each release. Never include a bot-token-bearing URL
in the repository.

`/newgame` offers inline game choices; a callback creates the chosen room in
the same group. The registered command menu (`newgame`, `leaderboard`,
`help`) is managed in code with `setMyCommands`, not a manual BotFather menu
update. Typed game shortcuts remain supported. See
[architecture](architecture.md#shared-services-and-game-boundaries) for the
catalog and static hub responsibilities.
