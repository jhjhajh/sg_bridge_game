# Floating Bridge

## Repo Map
- `src/` is the Cloudflare Workers/TypeScript app.
- `static/` is the vanilla JS frontend: the Fun Central hub at `/`, Bridge at
  `static/bridge/`, Regicide at `static/regicide/` (see CLAUDE.md for the layout
  and how to add another mini app).

## Commands
- `npm run dev` starts Wrangler dev for the Worker, Durable Object, and static assets.
- `npm run deploy` deploys to Cloudflare Workers.
- `npm test` runs Vitest.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run test:e2e` exercises actual local Worker/WebSocket multi-player games,
  room chat replay, and browser touch gestures; it uses temporary SQLite data.
- `npm run test:pr` is the repeatable check before every PR: typecheck, bounded
  unit checks, local E2E, and the complete UI/hand suite in Classic and 2.5D.
  See `docs/testing.md` for browser setup, ports, coverage and reporting.

## Workflow
- Use `README.md`, `package.json`, `requirements.txt`, and the existing scripts as the source of truth for commands.
- Run `npm run test:pr` before opening or updating a PR. Report exact passing,
  failing and skipped checks, browser/version, viewport/touch emulation, and
  remaining physical-device limitations. Do not count fixtures as live E2E or
  Chrome mobile emulation as iPhone/Safari testing. Keep relevant focused unit
  checks alongside E2E. Never deploy as part of verification.

## GitNexus
- Run `gitnexus_impact` before editing any function, class, or method.
- Warn the user before proceeding if impact analysis returns HIGH or CRITICAL risk.
- Run `gitnexus_detect_changes()` before committing.
- Use `gitnexus_rename` for renames; do not use search-and-replace.
- If GitNexus reports a stale index, run `npx gitnexus analyze`.
