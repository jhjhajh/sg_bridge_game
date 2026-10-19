# Shared hand and table rendering

The curved hand, original typography, in-place selection lift and optional 2.5D
view are maintained together in PR68. Run the combined tests directly; no helper
patch or second feature branch is required. [Current screenshots, recordings and
reproduction commands](../combined-ui/README.md) describe the final behavior.

`CardHand.render` owns native `.hand-card` buttons inside the persistent
`#bidding-hand`, `#partner-hand` and `#play-hand` containers. Its ResizeObserver
measures each actual container, including nested spectator panels. It retains
52px minimum cards, 11.8px minimum corner text, compact gutters below 290px, and
the original inherited font. Native hit testing follows the rotated/lifted card.

Selection applies `.is-selected` to the existing card. The card translates 8px
along its own upward axis (4px in compact containers); its angle and stacking
order remain unchanged. The layout reserves enough top and side room for this
motion. There is no cloned card, detached preview, or global positioning search.

The table preference only changes `body[data-table-view]` and local storage.
`view.js` leaves native buttons and existing `role`/`tabindex` semantics alone.
The native focus rule preserves `--card-order` even in 2.5D. Reduced motion
disables transitions in both modes.

Test clicks and swipes use a visible rank/suit center verified with
`elementFromPoint`, so they exercise the actual transformed hit region. All
touch thresholds, cancellation, pending-state and server-authoritative guards
remain shared. Switching view while a swipe is armed cancels the gesture and
retains the same game state and socket.
