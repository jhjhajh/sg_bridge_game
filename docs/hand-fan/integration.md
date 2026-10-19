# Compatibility with the optional table view

The curved hand was tested in a separate temporary combined tree with PR #69 at
`63edd12adc7c1704ad6842cbc14381955d14f410`. No view implementation or commits were
added to this PR. The combined static assets use this PR's final hand renderer
and PR #69's unchanged `view.css`, `view.js` and view controls.

The final changes preserve fan stacking during keyboard focus and use narrower
decorative gutters/index insets in containers under 290px. This keeps 13-card
indices exposed in 270px nested panels without reducing the 52px minimum card
width or 11.8px minimum index font. ResizeObserver continues measuring the actual
container. The existing `#play-hand` element and native button semantics remain.

## Reproduce independently

In a disposable combined checkout of the final PR #68 head and the PR #69 head
above, apply [the test-helper patch](pr69-rotated-corner-tests.patch). It only
changes PR #69's two test helpers to click/swipe at a visible rank/suit center,
verified with `elementFromPoint`, instead of a point in the axis-aligned card
bounding box. The product code requires no view-specific changes.

Run the standard unit tests and type checking. For browser verification, with
Edge and Playwright's FFmpeg helper installed:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
$env:HAND_TABLE_VIEW = '25d'
$env:HAND_FAN_CAPTURE = 'after'
$env:HAND_FAN_RECORD = '1'
$env:HAND_FONT_AUDIT = 'combined-25d'
npm run test:ui -- hand-layout.pw.js table-view.pw.js
```

`HAND_TABLE_VIEW` only initializes a test browser's saved display preference;
without it the normal Classic view is used. Hand tests use localhost port 4184;
view tests use 4186. Run suites sequentially with one browser worker.

The view tests cover switching in both directions, retained DOM/state/socket,
native button semantics, one mouse/touch/keyboard action, invalid/out-of-turn
guards, all phases, practice and spectators. The complete hand suite also runs
under the 2.5D preference, including font inheritance, rotated glyph hit targets,
keyboard focus, swipe/cancellation thresholds and magnifier clearance.

Final results: **71 passed, 1 skipped** in the combined browser run. The skipped
case is PR #69's optional screenshot refresher; the hand capture and video tests
ran successfully. The standalone hand run passed **57 tests/captures**, with its
optional cross-revision font audit skipped because that audit ran separately.
Unit tests passed **111/111**, and type checking and syntax checks passed.
Final visual review added heading/instruction clearance to the magnifier;
all **four targeted tests/captures passed in each view** after that adjustment.

## Actual combined captures

These use deterministic synthetic players/hands in Microsoft Edge with external
requests blocked. They are browser captures of the combined source, not renders
from production. Physical devices, Firefox and WebKit were not tested.

- [2.5D phone, 390px](combined-25d-play-390.png)
- [2.5D desktop, 1024px](combined-25d-play-1024.png)
- [2.5D landscape, 844px](combined-25d-play-844.png)
- [2.5D bidding, 390px](combined-25d-bidding-390.png)
- [2.5D partner selection, 390px](combined-25d-partner-390.png)
- [2.5D rendered-font audit](font-audit-combined-25d.json)
- [2.5D touch recording](combined-25d-touch.webm)

The audit confirms the original desktop font stack, weight, rank/suit sizes and
rendered Segoe UI Bold fallback match the standalone restored and original
revisions. The network font links are unchanged.
