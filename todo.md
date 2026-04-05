# Next tasks

## Bots / card play (memory & inference)

- [x] **Track played cards and voids**  
  `getAllPlayedCards`, `isBossCard`, `getVoids` — boss cards always played; lead avoids ruffable suits.

- [x] **Trick order & threats**  
  `getPlayersAfter` — teammate last → dump; opponent after → highestCard(winning); bidder-team after opposition → highestCard(winning).

## Game over screen

- [x] **Hands ordered by play sequence**  
  `PlayerGameView.trickLog` at game over; `renderGameoverHands` lays out each seat’s cards by `trickNum` / `playOrder`. Falls back to suit layout if the log is missing or incomplete.

---

*Add notes, links to issues, or sub-bullets under each item as you refine scope.*
