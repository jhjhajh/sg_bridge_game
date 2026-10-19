# Desktop hand layout evidence

Historical evidence for PR #67. The behavior and capture commands below describe
that version. Current fan layout, interactions, tests, and recording instructions
are documented in [hand-fan](../hand-fan/README.md).

At desktop viewport widths (768px and up), bidding, partner selection, and play
use panels up to 860px wide. Suit groups share the available width and cards can
shrink slightly, retaining the existing 6px overlap, font sizes, and a 44px minimum
card width. No overflow is hidden. Below 768px the existing mobile sizing and
horizontal touch scrolling are unchanged.

These are actual headless Microsoft Edge browser screenshots of `static/index.html`,
`static/style.css`, and `static/app.js`, rendered through the app's existing screen
and hand functions. Only synthetic players and deterministic 13-card hands were
injected; APIs and external requests were intercepted. Desktop screenshots show
the first card raised by the existing hover interaction. Before captures use
`master` at `9927555c39fff241b8a1b2183abf80ccb4890f7b`; after captures use this fix.

| Screen / viewport | Before | After |
| --- | --- | --- |
| Play / 768×900 | [Before](before-play-768.png) | [After](after-play-768.png) |
| Play / 1024×900 | [Before](before-play-1024.png) | [After](after-play-1024.png) |
| Play / 1366×900 | [Before](before-play-1366.png) | [After](after-play-1366.png) |
| Bidding / 1024×900 | [Before](before-bidding-1024.png) | [After](after-bidding-1024.png) |
| Partner selection / 1024×1000 | [Before](before-partner-1024.png) | [After](after-partner-1024.png) |
| Mobile play / 390×844 | [Before](before-play-390.png) | [After](after-play-390.png) |

## Automated checks

Run `npm ci`, `npx playwright install chromium`, then `npm run test:ui`.
To use an already installed Microsoft Edge browser instead, set
`PLAYWRIGHT_CHANNEL=msedge` (PowerShell: `$env:PLAYWRIGHT_CHANNEL='msedge'`).
The browser suite uses one worker and an in-process static server on localhost:4174;
it does not start Workers, use production services, or change saved accounts.

Coverage includes:

- Bidding, partner selection, and play at 768, 1024, 1366, and 1920px.
- Four full-hand distributions (4/3/3/3, 10/1/1/1, 13/0/0/0, 0/6/7/0),
  shorter hands, and an empty hand.
- No horizontal overflow or clipped/covered rank and suit glyphs; minimum card
  width; a single row; resize behavior; all 13 hover/click targets; disabled suits.
- Spectator full-board hands in all three desktop panels.
- Existing mobile card widths, scroll access, and last-card selection at 375,
  390, and 767px.

The 1024px play regression fails against the original stylesheet: a 788px scroll
width exceeds the 584px hand viewport. It passes with the desktop layout fix.

Screenshot capture is opt-in. Set `HAND_LAYOUT_CAPTURE=after` and run
`npm run test:ui -- --grep "capture review screenshots"`. For new before captures,
use the original stylesheet and set `HAND_LAYOUT_CAPTURE=before`.
