# Responsive hand and input behavior

All hands use a straight fan with exposed rank/suit corners, including bidding,
partner selection, play, and spectator full-board views. Cards remain 52–76px
wide. Spacing uses the measured hand width and card count: up to one full card
plus a 6px gap for short hands, or `(available width - card width) / (count - 1)`
for crowded hands. Corner text adjusts with that spacing; it stays about 12px or
larger at the tested minimum 320px viewport. Overflow is not concealed.

Touching a card selects it and opens a larger preview. Holding and sliding
horizontally changes the selected card. The preview sits above or below the fan,
stays inside the viewport, and does not cover neighboring corner labels.

## Activation and cancellation

- **Touch or pen:** only release after a deliberate upward swipe plays a card.
  Tapping, holding, horizontal browsing, and releasing without that swipe never
  play. An upward movement of 14px that exceeds horizontal movement by 1.2×
  begins the swipe and freezes selection. Release requires at least **56px up**,
  vertical displacement at least **1.5×** horizontal displacement, and horizontal
  drift at most `max(36px, 0.6 × card width)`. Sliding to a new card first resets
  the swipe origin to that card, so browse-then-swipe works naturally. Returning
  below the threshold before release does not play. Green feedback says
  “Release to play” only when the gesture is armed and the card is legal.
- **Mouse:** hover opens the preview; primary-button click plays. Movement over
  8px between press and release is a drag and does not play. Right clicks do not
  play. Pointer type is evaluated per event so mouse input still works directly
  after touch on hybrid devices.
- **Keyboard:** one card is in the Tab sequence. Left/right arrows and Home/End
  move focus; Enter or Space plays a legal card. Escape dismisses the preview.
  Buttons expose full rank/suit names and `aria-disabled`; reduced motion removes
  hand transitions.
- Pointer cancellation, lost capture, resize/rotation, scrolling, blur, hidden
  document, second pointer, leaving the fan, server rerender, and removal cancel
  an active gesture. Downward movement over 18px also cancels. Compatibility
  clicks are suppressed for one second after touch, including across rerenders.
  Page scrolling outside the interactive hand remains available.

Every activation rechecks the latest authoritative state: play phase, own turn,
non-spectator, trick not complete, no prior card in this trick, card ownership,
legal suit/trump, open WebSocket, fresh state after reconnect, and no pending
play. A pending play stays locked through unrelated state updates and clears on
acknowledgment (card removed, turn/phase/game changed), server error, disconnect,
or leaving. The server remains authoritative.

## Evidence and validation

These are actual Microsoft Edge browser captures of the repository's frontend
using deterministic 13-card synthetic hands and synthetic players only. All
network APIs/external widgets were intercepted. Before uses `master` commit
`5ab300a7358d8a41fe29163a074eb0d2b321e7e6` (PR #67); after uses this change.
Mobile screenshots use real emulated touch input; desktop uses mouse hover.
Landscape images capture the current viewport after scrolling to the hand.

| Viewport / screen | Before | After |
| --- | --- | --- |
| 320×740 play | [Before](before-play-320.png) | [After](after-play-320.png) |
| 390×844 play | [Before](before-play-390.png) | [After](after-play-390.png) |
| 844×390 landscape play | [Before](before-play-844.png) | [After](after-play-844.png) |
| 1024×900 desktop play | [Before](before-play-1024.png) | [After](after-play-1024.png) |
| 390×1000 bidding | [Before](before-bidding-390.png) | [After](after-bidding-390.png) |
| 390×1100 partner selection | [Before](before-partner-390.png) | [After](after-partner-390.png) |

[Recorded tap → slide → upward swipe](touch-select-slide-swipe.webm) shows a tap
that sends nothing, followed by a continuous slide to A♥ and an upward swipe
that sends exactly one play. The preview frame is extracted from the same recording.

Run `npm run test:ui` after `npx playwright install chromium`. An installed Edge
can be used with `PLAYWRIGHT_CHANNEL=msedge`. Tests use one browser worker and
cover 320, 390, 768, 1024, 1366, and 1920px layouts, full/skewed/single-suit/short/
empty hands, portrait/landscape resize, exposed glyph hit tests, all desktop
cards, keyboard, coarse and hybrid input, tap-only, threshold boundaries,
browse-then-swipe, invalid/off-turn/pending actions, cancellations, and magnifier
bounds. Touch tests dispatch actual browser input through CDP, rather than
calling gesture handlers directly. Firefox/WebKit and physical devices were not
tested.

To refresh captures set `HAND_FAN_CAPTURE=after` and run
`npm run test:ui -- --grep "capture review screenshots"`. For a recording install
Playwright's FFmpeg helper (`npx playwright install ffmpeg`), set
`HAND_FAN_RECORD=1`, and run the `record synthetic touch interaction` test.
