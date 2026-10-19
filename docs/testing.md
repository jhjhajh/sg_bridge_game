# PR validation

Run `npm ci` using the locked dependencies, then use an already available
Playwright browser. No test command installs a browser, requires a Cloudflare
account, accesses production D1, or deploys the app.

For an installed system Chrome:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:pr
```

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:pr
```

If the matching Playwright Chromium is already installed, omit the environment
variable. Firefox/WebKit require their own supported installed engines and
appropriate test adaptations; CDP touch tests specifically require Chromium.
Do not claim cross-engine coverage by changing only the user agent.

The runner stops on failure, uses two unit workers and one browser worker,
and repeats the full hand suite with `HAND_TABLE_VIEW=25d`. It covers:

| Layer | What is checked |
| --- | --- |
| TypeScript / Vitest | Rules/bots, auth, statistics, bounded persistent chat and storage ordering/lifecycle |
| Real local E2E | Worker + SQLite Durable Object + actual WebSockets; create/join four-player rooms, bid/pass, choose a partner, legal keyboard/touch play until the contract resolves, results, refresh/reconnect, live view switch |
| Real local chat | Two browser clients, desktop and mobile, send via composer, refresh/reconnect replay, order, duplicate joins, empty messages, latest 50, moving the same client to another room, delayed old-socket frames |
| Browser input / layout | Classic and 2.5D; real CDP dragging on a scrollable page, finger attachment, table drop plays once, hand/outside return, invalid drop zones, pending/illegal/out-of-turn guards, pointer cancellation, resize/blur/scroll, live reconnect while dragging, stable hand DOM/positions on unrelated updates, original card typography, keyboard focus, reduced motion, narrow layouts |
| Chat fixtures | Snapshot/live race and duplicate replay, reading position while older messages are trimmed, following newest messages, long names/text, IME/repeat/offline draft guards, synthetic before/after captures |

The live test server uses loopback port **4210**, current production source and
assets, local schema migrations, and temporary room storage. It substitutes
only unrelated HTTP auth/leaderboard requests in browser tests. Gameplay,
room joins, card legality and all chat frames use the actual server. No
Telegram messages are sent. The static interaction suites use **4184**, **4186**,
**4208** and **4212**. Keep those ports free and run one suite at a time.

Focused iteration:

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run test:e2e
npm run test:ui
```

Playwright keeps failure traces in `test-results/`. Review failures instead of
rerunning until green. Record code/test fixes and rerun affected checks, then
the complete PR runner. For changes outside these paths, add an E2E regression
that exercises the affected user journey against the actual local server.

Every PR report should include the command, counts (including skips/failures),
browser version, desktop/mobile viewport sizes, touch mechanism and any known
gaps. Synthetic screenshots help visual review but do not replace E2E. Device
emulation is not physical iPhone, Android or Safari verification. No automated
suite establishes production network, Telegram WebView or assistive-technology
coverage; report those limitations explicitly when relevant.
