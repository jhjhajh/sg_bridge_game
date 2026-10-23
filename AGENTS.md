# Fun Central

## Repo Map
- `src/index.ts` is the shared Cloudflare Worker router; `src/games.ts` is the
  typed available-games catalog used by Telegram choices.
- Bridge retains `src/bridge.ts`, `src/game-room.ts` and related root modules.
  Regicide is namespaced under `src/regicide/` with its own room class.
- `static/index.html` is the hub at `/`; pages live in `static/bridge/` and
  `static/regicide/`. Bridge's established client assets remain at the root
  of `static/`; `/style.css` is shared across the hub and games.
- Shared auth/profile storage does not merge game ratings. Keep existing
  Bridge API URLs and `/#ROOM` redirects compatible.
- New games use `src/<game>/`, `static/<game>/`, `/api/<game>/*`, their own
  Durable Object binding/class + incremental migration, and game-prefixed
  stats tables. Update the catalog, static hub tiles and local test harnesses.
- `/newgame` is an inline game chooser, not a Bridge alias. Typed
  `/newbridge`, `/newregicide` and `/newregicidegame` remain supported;
  the registered command menu is `newgame`, `leaderboard`, `help`.
- See `docs/architecture.md` for the extension checklist, `docs/README.md`
  for current guides and historical evidence, and `CLAUDE.md` for code notes.
- Root Python files, `requirements.txt` and `.env.example` are archived;
  do not reorganize them as part of hub/game work.

## Commands
- `npm ci --include=dev` installs locked app tooling, including when the
  environment otherwise omits devDependencies.
- `npm run dev` starts local Wrangler with the Worker, rooms and assets.
  Use local-only `.dev.vars`/dev login as described in `docs/development.md`.
- `npm test -- --maxWorkers=2` runs bounded Vitest checks, including local
  Regicide persistence/concurrency regressions.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run test:e2e` selects live Worker/WebSocket game, identity, creator,
  Regicide/Telegram and related browser input checks with temporary data.
- `npm run test:ui` runs the complete Chromium Playwright suite.
- `npm run test:pr` runs typecheck, bounded Vitest, the full Chromium suite
  with Classic hand settings, then the complete hand-layout suite in 2.5D.
  See `docs/testing.md` for browser setup, ports, coverage and reporting.

## Workflow
- Use `README.md`, `package.json` and existing scripts as command sources of
  truth; `requirements.txt` applies only to the archived Python code.
- Run `npm run test:pr` before opening or updating a PR. Report exact passing,
  failing and skipped checks, browser/version, viewport/touch emulation, and
  remaining physical-device limitations. Do not count fixtures as live E2E or
  Chrome mobile emulation as iPhone/Safari testing. Keep relevant focused unit
  checks alongside E2E. Never deploy as part of verification.
- **Never run `npm run deploy` manually.** A PR merge to `master` in
  `vocsong/funCentral` triggers Cloudflare Workers Builds. Preserve Worker
  `sgbridgegame`, D1 `sg-bridge-users`, existing bindings/secrets and URLs.
- Production requires existing `JWT_SECRET`/`TELEGRAM_BOT_TOKEN` secrets and
  public username `funCentral_bot`; `ALLOW_DEV_LOGIN` must be absent.
- Inspect remote D1 schema/ledger and list pending migrations before applying
  anything. Never replay destructive `0006_stats_reset.sql`; see
  `docs/deployment.md`. DO class migrations are separate from D1 SQL.
- Keep dated designs, feature notes and screenshot evidence historical rather
  than rewriting their results as current verification.

## GitNexus
- Run `gitnexus_impact` before editing any function, class, or method.
- Warn the user before proceeding if impact analysis returns HIGH or CRITICAL risk.
- Run `gitnexus_detect_changes()` before committing.
- Use `gitnexus_rename` for renames; do not use search-and-replace.
- If GitNexus reports a stale index, run `npx gitnexus analyze`.
