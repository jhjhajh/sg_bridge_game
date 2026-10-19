# Drag/drop validation — 19 October 2026

Base: master `f1bd8cb359f3a69becf482f018db9548b9ade309`, which merged PR70.
Command: `PLAYWRIGHT_CHANNEL=chrome npm run test:pr`.
Runtime: Windows, Node 22.23.1, Playwright 1.64.1, system Chrome 155.0.8059.80.
Both final recordings decode at 390 × 844: Classic 5.04s and 2.5D 5.32s.

| Final check | Result |
| --- | --- |
| TypeScript | Passed |
| Unit tests, two workers | 115 passed, 8 files |
| Main browser suite, one worker | 116 passed, 5 optional jobs skipped |
| Complete hand suite repeated in 2.5D | 57 passed, 3 optional jobs skipped |
| Total browser checks | **173 passed; 8 optional skips; 0 failures; exit 0** |
| Separate screenshot/gesture recording capture | 1 passed, both views |

The main suite includes 34 new drag/drop cases and four actual local
Worker/SQLite/WebSocket E2E cases. Capture runs separately with
`DRAG_CAPTURE=1` and an isolated output directory. The eight optional skips
are opt-in capture/audit jobs, including that separately executed capture.
No browser engines or system software were installed. Existing system Chrome
and the already available Playwright FFmpeg runtime produced the recordings.

## Real multiplayer and interaction evidence

| Live game | Accepted cards | Completed tricks | Illegal keyboard attempts blocked |
| --- | --- | --- | --- |
| Classic start, mid-game view switch | 48 | 12 | 20 |
| 2.5D start, mid-game view switch | 32 | 8 | 18 |

Both games use actual room creation/join, randomized seating, bidding/passes,
partner selection, keyboard and real CDP touch dragging, legal table drops to
contract results, refresh and reconnect. A card is held while its client opens
a replacement connection; the drag returns without sending a play. Other
clients keep unchanged hand nodes. Existing live chat replay/order/isolation
cases also pass. Unrelated HTTP auth/leaderboard calls are substituted; all
gameplay and chat frames use the actual local server and temporary data.

The new scrollable-page cases check exact grab-point attachment, bounded tilt
that settles, original source/proxy font metrics, unchanged hand nodes during
unrelated state updates, table release once, return over hand/outside/corner,
pending/illegal/out-of-turn/spectator guards, lost capture, pointer cancellation,
multi-touch, turn/hand/phase/view changes, Escape and reduced motion. Existing
tests retain outside-card page scrolling, mouse hover/click, keyboard controls,
320–1920px layouts, exposed ranks/suits and landscape coverage in both views.

Live desktop clients use 1366 × 900; mobile emulation uses 390 × 844. The
scrolling regression uses 390 × 620, and the landscape drag uses 844 × 390.
The landscape test stages the grabbed corner and table visibly before touch;
it does not fake a hit target or relax the legal drop test.

## Failures resolved during development

The first complete run had one 2.5D landscape setup failure: centering the
entire wide fan scrolled the felt behind the fixed header. The test now stages
both real targets in the viewport and asserts the full grabbed corner is
visible. The focused portrait/landscape cases and the final complete run pass.
A recording refresh overlapped another runner's trace cleanup; the final
capture passed separately in `.wrangler/card-drag-capture`. No failed run was
treated as a passing verification.

See the [actual screenshot gallery and recordings](README.md). Recordings use
synthetic game data and an explicit synthetic authoritative acknowledgement;
they are visual demonstrations alongside the separate real-server E2E.

Physical iPhone/Android, Safari, Telegram WebViews, screen readers and production
networks remain untested. Browser touch emulation is not physical device
coverage. No merge or deployment forms part of this verification.
