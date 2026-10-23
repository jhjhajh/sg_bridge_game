# Fun Central PR validation

Run `npm ci --include=dev` using the locked dependencies, then use an already
available Playwright browser. All app tooling is in `devDependencies`. No
test command installs a browser, requires a Cloudflare account, accesses
production D1 or deploys the app. See [development](development.md) for manual
local setup; suites create their own local bindings/data.

## Required runner

For an installed system Chrome, in PowerShell:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:pr
```

Or in a POSIX shell:

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:pr
```

If the matching Playwright Chromium is already installed, omit the environment
variable. Firefox/WebKit require their own supported installed engines and
appropriate test adaptations; CDP touch tests specifically require Chromium.
Changing only the user agent does not establish cross-engine coverage.

`package.json`, `tests/run-pr-checks.cjs` and `playwright.config.js` are the
source of truth. The PR runner stops on failure and runs, in order:

1. `tsc --noEmit`.
2. Vitest with `--maxWorkers=2`.
3. The **complete Chromium Playwright suite**, one browser worker, with
   `HAND_TABLE_VIEW=classic`.
4. The complete `tests/ui/hand-layout.pw.js` suite again with
   `HAND_TABLE_VIEW=25d`.

Some live Bridge cases explicitly exercise both views within the main suite.
The final repeat is the hand-layout suite, not every browser test in 2.5D.

## Coverage and boundaries

| Layer | What is checked |
| --- | --- |
| TypeScript / Vitest | Bridge rules/bots, shared auth/names, statistics/history, persistent chat and storage ordering/lifecycle; Regicide rules, rating calculations and database behavior |
| Regicide runtime persistence | Eight focused regressions in `tests/regicide-persistence.test.ts` and `tests/regicide-concurrency.test.ts`, using `regicide-persistence-harness.ts`: real Miniflare/workerd, D1/SQLite transactions, rollback/retry, overlapping duplicate completions, additive cross-room rating updates, delayed group joins, delayed rating acknowledgements, durable outbox recovery across restart and retention through idle cleanup/retry |
| Bridge live game E2E | Local Worker + SQLite Durable Object + actual WebSockets: four-player create/join, bid/pass, partner selection, legal mouse/touch play until the contract resolves, keyboard illegality guards, results, refresh/reconnect and live view switching |
| Bridge creator regression | A creator with stale spectator state is seated as a player; leaving spectator mode does not contaminate the next created room, including reload/reconnect |
| Identity live E2E | Real profile endpoints, database, signed synthetic auth and WebSockets: name recovery, delayed/stale responses, invalid credentials, reconnect/session replacement |
| Regicide live E2E | Hub links and legacy Bridge redirects; shared leaderboard entry points; dev login and seat authorization; seeded complete 1–4-player UI games; exact rule scenarios, spectators, reloads, results/ratings and stats filters |
| Telegram local integration | Actual local webhook with captured outbound Bot API calls: `/newgame` choices/callbacks, acknowledgement before same-group room creation, unsupported/private selection rejection, typed shortcuts, command registration, membership, lobby/start/result posts and separate group boards. No calls reach Telegram. |
| Missing Regicide schema | `0011_regicide.sql` deliberately skipped: gameplay still finishes, Regicide board/stats stay empty and Bridge room creation/bot board remain available |
| Real local chat | Two browser clients, desktop/mobile, composer send, reconnect replay, order, duplicate joins, empty messages, latest 50, room changes and delayed old-socket frames |
| Browser input / layout | Classic/2.5D, CDP dragging on a scrollable page, finger attachment and damped swing, felt-edge hit testing, single table drop, hand/outside return, pending/illegal/out-of-turn guards, cancellation, resize/blur/scroll, reconnect while dragging, stable hand DOM, typography, keyboard focus, reduced motion and responsive lobby actions |
| Chat fixtures | Snapshot/live races, duplicate replay, scroll position while trimming, newest-message following, long names/text, IME/repeat/offline drafts and synthetic captures; these are not live-server evidence |

The persistence harness uses real local D1 SQL and room code, with test-only
inspection/retry hooks and controlled I/O timing; it is not a full browser
journey. Regicide's targeted rule scenarios use a fixed seed and dev-only
state patching; distinguish these from complete seeded games. Bridge chat
E2E substitutes unrelated auth/leaderboard HTTP requests, not gameplay or
chat frames. Identity and Regicide suites exercise their actual local auth
endpoints with synthetic credentials.

For Telegram chooser changes, keep captured-webhook regressions for
`/newgame`'s inline Bridge/Regicide choices, callback validation and room
creation in the originating group, as well as the typed game shortcuts and
the `newgame`/`leaderboard`/`help` command menu. Static hub tiles and the typed
`src/games.ts` catalog must remain consistent.

## Local ports and storage

| Port | Suite / server |
| --- | --- |
| 4184 | Hand-layout static interaction server |
| 4186 | Table-view static interaction server |
| 4208 | Chat/hand fixture server |
| 4210 | Bridge live games/chat (`live-worker.cjs` default) |
| 4212 | Card-drag interaction server |
| 4214 | UI-polish interaction server |
| 4216 | Identity live Worker |
| 4217 | Bridge creator/spectator-role live Worker |
| 4218 | Regicide live Worker |
| 4222 | Live Worker without Regicide tables |
| 4230 | Telegram chooser/live webhook with outbound capture (replaces the earlier suite's 4220) |

Keep these ports free and run one suite at a time. `tests/ui/live-worker.cjs`
bundles the current checked-out Worker and assets, binds both room classes,
applies local migrations (except deliberate skip scenarios) and creates
isolated temporary D1/room storage under `.wrangler/`. The persistence
harness creates its own OS-temporary SQLite storage and can restart workerd
against it. Helpers dispose their runtimes and remove only their own data.
No production database or real Telegram credentials are needed.

## Focused iteration and reporting

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run test:e2e
npm run test:ui
```

`test:e2e` selects the live game/chat/identity/creator/Regicide/Telegram suites
plus related input checks; `test:ui` runs all Playwright files. Neither replaces
the complete PR runner. Add focused rule/persistence checks alongside E2E for
the affected game and shared paths. A new room class must also be registered
in the relevant local harnesses.

Playwright keeps failure traces in `test-results/`. Review failures rather
than rerunning until green. Record fixes, rerun affected checks, then the
complete PR runner. Generated screenshots are evidence of that run, not
proof of untested environments; retain historical captures as historical.

Each PR report must state the exact commands and actual passing/failing/skipped
counts, browser/version, viewport sizes, touch mechanism and known gaps. Do
not copy counts from an older report. Synthetic screenshots and fixtures do
not replace live E2E. Chrome mobile emulation is not physical iPhone/Android,
Safari or Telegram WebView testing. No automated suite establishes production
network or assistive-technology coverage; report these limitations explicitly.
