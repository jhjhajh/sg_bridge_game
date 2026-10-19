# Validation — 19 October 2026

Base: merged PR68, `ceed5b579b36bc7993d81d8242969ac8c5fa4aae`.
Command: `PLAYWRIGHT_CHANNEL=chrome npm run test:pr` (PowerShell equivalent in
[the testing guide](../testing.md)). Final run exited **0**, without retries.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Vitest, two workers | 115 passed, 8 files |
| Main browser suite, one worker | 82 passed, 4 optional checks skipped |
| Complete hand suite repeated in 2.5D | 57 passed, 3 optional checks skipped |
| Total browser cases | **139 passed; 7 optional skips; 0 failures** |

The seven skips are existing opt-in font-audit, screenshot and video capture
jobs (three hand jobs in each view plus one table screenshot job). Chat
before/after capture tests did run; all eight PNGs are in the
[review gallery](README.md). Syntax and staged whitespace checks also passed.

Runtime: Windows, Node 22.23.1, Playwright 1.64.1, system Chrome
**155.0.8059.80**, Wrangler/Miniflare from the locked Wrangler 4.79.0 dependencies.
No new browser engines or system software were installed.

## Actual server coverage

The four live E2E cases are included in the 139 browser passes. They run the
production Worker and SQLite Durable Object locally on port 4210, with actual
WebSocket joins/gameplay/chat and local schema migrations. Synthetic numeric
player identities exist only in that temporary database. Unrelated browser
HTTP auth/leaderboard calls are substituted; Telegram and production services
are not exercised.

| Game | Accepted cards | Completed tricks | Illegal keyboard attempts blocked |
| --- | --- | --- | --- |
| Classic start, live view switch | 44 | 11 | 26 |
| 2.5D start, live view switch | 40 | 10 | 17 |

Both games run create/join, randomized seating, bidding/passes, partner selection,
legal keyboard/touch play until the contract resolves, and results. They check
unchanged hand nodes/positions during actual bid/reconnect broadcasts, reload
during play without losing cards/game ID, reconnect, out-of-turn guards, tap
without play, follow-suit guards, one frame per accepted play, chat across
lobby/play/results, and history after reloading results.

Two-client live chat cases cover composer Enter/touch Send, refresh/reconnect,
messages sent while disconnected, repeated join snapshots, simultaneous senders,
sequence order and matching IDs, empty messages, the latest-50 cap, moving the
same browser to an empty second room, and delayed frames from the old socket.

## Browser interaction coverage and limits

Live clients mix desktop 1366 × 900 and Chrome mobile emulation 390 × 844 in
both views. Separate CDP touch tests use an actually scrollable 390 × 620 page:
tap does not play, an upward swipe survives unrelated state updates, the page
does not scroll from a card gesture, pending swipes do not duplicate an action,
and swiping outside the cards does scroll. The full existing hand suite repeats
legality/cancellation, hybrid mouse/touch, keyboard, reduced motion, multiple
hand distributions, 320–1920px widths and 844 × 390 landscape checks in both
views. Chat tests additionally check 320px wrapping, reading anchors while
trimming old rows, bottom-follow, snapshot/live races, IME/repeat guards and
retaining an offline draft.

During development, the hand stability regression failed against the old
renderer, and the first live game stalled after one trick. The fixes retain
unchanged card nodes and allow the completed trick's winner to lead, matching
the existing server transition. Harness assumptions about randomized seating
and closing sockets were corrected; the final serial run above is clean.

Physical iPhone/Android, Safari, Telegram WebViews, screen readers, production
networks, and forced Durable Object eviction/restart were not tested. The
matching Playwright Firefox/WebKit engines were unavailable. Room-history
cleanup/recreation is unit tested using the same storage deletion convention;
the real five-minute inactivity period was not awaited. Earlier messages lost
before this implementation cannot be recovered retroactively.
