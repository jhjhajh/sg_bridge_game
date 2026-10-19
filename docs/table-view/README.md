# Optional 2.5D table

Choose **Classic / 2.5D** on home or in the game top bar. Classic is the default.
The locally saved `bridge.tableView` preference changes presentation without
resetting the game, reconnecting, replacing the hand or sending a move.

2.5D adds a perspective felt surface, layered rim, upright player seats, shallow
card depth and matching raised panels for home, lobby, bidding, partner selection,
results and shared controls. Narrow screens place the last-trick panel below the
table. The decorative surface is tilted; labels and controls stay upright.

Both modes use the same curved hand and original typography. Hover, touch
selection and keyboard focus lift the selected card within its existing fan
position. Native hit testing, keyboard controls, swipe-only touch play and game
guards are shared. Reduced motion disables transitions; no rendering loop or new
runtime dependency is added.

The view stylesheet is scoped to `body[data-table-view="25d"]`; `view.js` retains
native card semantics. The combined implementation and tests now live together
in PR68. No manual test patch is needed.

[Current before/after screenshots, phase gallery, recordings and validation](../combined-ui/README.md).
[Shared hand behavior](../hand-fan/README.md).
