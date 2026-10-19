# Player name recovery

The login callback and saved-profile path previously updated the name input
without updating the name used by room connections. Startup also restored the
room before the asynchronous profile request completed. A whitespace-only
cached name could therefore be sent on reconnect, and the server accepted it
as a replacement for the current room name. The Telegram display-name fallback
also treated an explicitly empty username as usable.

The client now waits for profile resolution before automatically entering a
room. Successful server responses synchronize the display name and stable
player ID in memory and browser storage. Late profile responses cannot replace
a newer login. Temporary network/server failures preserve the saved credential
and provide retry; definitive invalid/expired credentials return to sign-in.
Profile lookup has an eight-second timeout.

A verified account without a usable name receives an explicit editable-name
flow before joining. The name is saved through the authenticated profile
endpoint before connecting. Unicode names remain supported; names are trimmed,
spacing/control characters normalized, and capped at 64 Unicode code points.
Non-text and invisible-only values are rejected. Room joins enforce the same
rule for players and spectators, including reconnects and reclaimed bot seats.
Bad reconnect data cannot erase an existing name.

Legacy stored room names are repaired before emitting state, using generic
`Player N` / `Spectator N` labels only when no usable display name exists.
These are display labels, not fabricated Telegram identities. IDs, seats,
hands and game progress are retained; a subsequent valid join restores the
player's supplied name. Blank account profiles can recover a name from their
own previously verified token claims.
Bid-history columns use the existing seat ID, so repaired or duplicate names
cannot change player attribution or interrupt bidding/partner rendering.

Socket replacement also ignores late close/error callbacks from the old
connection. The accepted connection clears its obsolete disconnect timer.

The supported Telegram sign-in path remains the verified Login Widget. Plain
chat/deep links and late/missing Mini App SDK data do not prove identity and
are never used as authorization. When no verified session is available, the
app clearly asks for Telegram sign-in. This change does not add Mini App
`initData` authentication or modify signature validation.

Validation is in `tests/player-name.test.ts`, `tests/identity-room.test.ts` and
`tests/ui/identity-live.pw.js` (loopback port 4216). It uses the real local
Worker, migrations, database, signed synthetic login payloads and WebSockets;
no Telegram service or production data is used. Browser coverage includes
both table views, delayed profile loading, stale stored/URL identity, manual
name recovery, retry, invalid credentials, account-name repair, two-client
reload/reconnect, malformed joins and late responses from an earlier login.
The complete PR runner also exercises full four-player games in both views.

Actual Telegram WebViews and physical iPhone/Android devices remain untested.
Chrome desktop/mobile emulation does not establish those compatibility claims.
