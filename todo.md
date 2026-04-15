# Next tasks (requirement specs)

## SPEC — Lobby: player vs spectator on join (invite link)

### Goal

Anyone entering the room via **invite link** must **explicitly choose** **Player** (take a seat) or **Spectator** before entering the lobby experience, so status is never ambiguous.

### Acceptance

- Invite / deep-link flow shows a **modal or step**: “Join as player” vs “Join as spectator” (copy can be tuned).
- Choice is persisted for that session / reconnect where applicable.

### Open questions

- If all four seats are full, should “Join as player” be disabled with explanation, or queue?

---

## SPEC — Lobby: start only when all seats connected

### Goal

The match **must not** auto-advance from lobby until **every seated player** is in **connected** state (WebSocket live).

### Acceptance

- “Start” / transition to bidding (or next phase) is blocked until `connected === true` for all four seats (or document rule if bots count as always connected).
- UI shows who is still connecting (optional but useful).

---

## SPEC — Kick: allow while waiting on “Play again”

### Goal

Players who **have not** pressed **Play again** after game over should **still** be kickable from the lobby (same as others). Today kick may be gated on ready state — remove that asymmetry.

### Acceptance

- Kick / remove-seat works for any occupied seat in lobby regardless of `readySeats` / play-again acknowledgement.
- Document edge case: mid-rematch if one person never readies.

---

## SPEC — Clickable names → Telegram @ ping (lobby + bidding)

### Goal

On **game lobby** and **bidding** screens, **player names** are **clickable**. Click sends a **Telegram @ mention** to ping that player (room must be linked to a Telegram group / bot as today).

### Rate limit

- **Per target player:** at most one successful ping every **10 seconds** (cooldown is per **recipient**, not global).
- **Per clicker:** can ping **up to 3 other players** (not self); after using all three, each of those three cooldowns ticks independently — after 10s from each ping, that recipient can be pinged again (so “10 sec later tag 3 of them again” = per-recipient 10s cooldown).

### Acceptance

- Cooldown is enforced **server-side** so clients cannot spam.
- Disabled state or toast when on cooldown; never @ self.

### Open questions

- If room is **not** Telegram-linked, hide links or show “Link Telegram group” only?

---

## SPEC — Spectator chat on game table

### Goal

- **Spectators** who send chat during **play** see their messages as **bubbles** in the same chat UI as players (or clearly unified thread).
- Add a **chat area fixed at the bottom** of the page during play (and optionally other phases) so input is always reachable.

### Acceptance

- Spectator messages appear in-thread with correct sender label (e.g. “Spectator: Name”).
- Layout: bottom chat strip does not obscure critical table controls; scrollback works.

### Open questions

- Should spectators be **read-only** until play starts, or chat anytime in lobby too?

