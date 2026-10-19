# Validation and limits

Validated on Windows with existing Chrome **155.0.8059.80**, Playwright
**1.64.1**, Node **22.23.1** and Vitest **3.2.4**. Browser suites use one worker;
unit tests use two. No browser engine or software was installed.

The full `PLAYWRIGHT_CHANNEL=chrome npm run test:pr` completed with exit 0:

| Check | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| TypeScript | Clean | — | 0 |
| Vitest, eight files | 115 | 0 | 0 |
| All browser suites, Classic default; view-specific suites exercise both modes | 134 | 6 | 0 |
| Complete hand suite repeated with `HAND_TABLE_VIEW=25d` | 57 | 3 | 0 |
| Total test cases | 306 | 9 | 0 |

All nine skips are optional captures/audits: the saved-revision font audit,
hand screenshots and hand video in each hand-suite pass (six), the existing
table-view capture, the existing card-drag capture, and the new UI-polish
capture. The new before/after capture was run separately and passed for both
stages. No functional check is skipped.

Final live games accepted 32 cards / 8 tricks in Classic and 44 cards / 11
tricks in 2.5D, with respectively 16 and 22 illegal keyboard attempts rejected
without emitting a play. The earlier focused `npm run test:e2e` also completed
with 62 passes and two optional capture skips before the last label/spacing
polish; the final full run covers that code and the two added quoted-name
regressions. `git diff --check` is clean.

The focused regression file covers both views:

- Actual mouse click and authoritative card removal retain surviving nodes.
  Twenty rendered frames check stable table/hand placement and bounded fan
  reflow, rather than a new fan appearing flat and rotating again.
- Keyboard focus moves to the nearest surviving card; arrow navigation and
  out-of-turn protection continue to work.
- Native CDP direction reversals produce over 10 degrees of visible swing,
  bounded to 38 degrees, while the finger grip stays within 1 pixel. The
  existing drag suite also measures damping at rest and reduced motion.
- Native hit testing checks four points just inside the felt edge and four
  rounded corners outside it, on desktop and mobile. Releasing outside cannot
  emit a play. The drop label clears the top seat in both views.
- Lobby names, statistics and action edges align at 320, 390 and 1366 pixels;
  seat circles do not overlap status dots, long names wrap without horizontal
  overflow, and actual remove/ping buttons retain their actions. Quoted names
  remain text in accessible labels.

Local multiplayer tests use the production Worker, migrations and temporary
SQLite Durable Object storage, with actual browser WebSockets. Four clients
bid/pass, choose a partner, and play through contract resolution. Desktop
players use actual mouse input; mobile players use CDP touch dragging. Every
desktop acknowledgement checks that surviving hand nodes retain identity.
Tests also cover illegal keyboard attempts, no duplicate play frames, pending
locks, reconnect while holding a card, reload in play/results and mid-game
view switching. Only unrelated HTTP auth and leaderboard requests are mocked.

Desktop viewport is 1366 × 900; touch gameplay is Chrome mobile emulation at
390 × 844, with scroll ownership also exercised at 390 × 620. The full layout
suite includes 320, 390, 768, 1024, 1366 and 1920-pixel widths and narrow nested
panels. These are not physical iPhone, Android or Safari tests.

The screenshot/recording case ran separately for `before` and `after` using
synthetic state and actual browser input. It produced twelve PNGs and six WebM
recordings. The before source is immutable merged base
`caf89d0033f37b8e43e0cabda3eb1711cd1e353a`; private user references are excluded.
All six videos decoded and sought successfully in existing Chrome. Mobile
recordings are 390 × 844; desktop recordings are 1366 × 900, about 4–5 seconds.

Remaining coverage limits: Firefox/WebKit engines are not installed; physical
iPhone/Safari, Android, Telegram WebView, screen-reader interaction and
production network behavior were not tested. No deployment or production
database access is part of validation. A real-device touch review remains
useful for subjective swing feel.
