# Curved card hands and input

Hands follow a curved arc with exposed rank/suit corners in bidding, partner
selection, play and spectator views. Cards remain 52–76px wide; a full hand rotates
progressively from -24 to +24 degrees. The measured container width determines
the radius and overlap. Corner text fits the exposed strip, including both digits
of "10", with an 11.8px minimum in the tested narrow panels.

Hover, touch selection and keyboard focus lift the actual card slightly along its
existing angle. The card keeps its position in the arc, rotation and stacking
order, so neighboring indices remain exposed. Selection moves 8px, reduced to
4px in containers under 290px. No duplicate card or detached preview is created.

## Original typography

Cards inherit `Inter, system-ui, -apple-system, sans-serif`, weight 700, the
original responsive size, 1.1x suit size and suit colors. Crowded corner indices
scale to their available space; selection does not enlarge or change the font.
The network font links are unchanged.

CDP audits with external requests blocked compare the computed stack, weight,
size, color and actual rendered font with the original baseline. Desktop ranks
and suits use the same Segoe UI Bold fallback at 27.2/29.92px. See the
[original audit](font-audit-baseline.json) and current combined evidence linked
below. Live clients can load the original web font normally.

## Input behavior

- **Touch/pen:** hold and slide to select; only a deliberate upward swipe followed
  by release plays a legal card. Taps, holds, horizontal browsing and mouse-style
  compatibility clicks never play. Swipe recognition begins at 14px up with a
  1.2x vertical direction bias; release requires at least 56px up, a 1.5x vertical
  bias and horizontal drift at most `max(36px, 0.6 × card width)`.
- **Mouse:** hover lifts the card; a primary click plays. Drags over 8px and right
  clicks do not play. Mouse works immediately after touch on hybrid devices.
- **Keyboard:** roving Tab focus; arrows and Home/End move between cards. Enter
  or Space plays a legal card once; Escape clears selection. Native labels and
  `aria-disabled` remain with the renderer.
- **Cancellation:** pointer cancellation, lost capture, resize, scroll, blur,
  authoritative rerender, a second pointer and changing view cancel armed input.
- **Legality:** turn, phase, hand membership, follow-suit, trick completion,
  spectator, connection and pending-play guards remain authoritative. Unrelated
  state messages do not unlock a pending play. Server rejection permits retry.
- **Reduced motion:** selection remains immediate and transitions are disabled.

[Current screenshots, recordings, validation and reproduction](../combined-ui/README.md).
[Shared rendering hooks](integration.md).
