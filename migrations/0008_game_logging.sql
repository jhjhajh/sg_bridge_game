-- Game logging tables for hand display and future replay

CREATE TABLE IF NOT EXISTS game_hands (
  game_id      TEXT    NOT NULL,
  seat         INTEGER NOT NULL,
  player_name  TEXT    NOT NULL,
  initial_hand TEXT    NOT NULL,  -- JSON array of card strings e.g. ["A ♠","K ♥"]
  final_hand   TEXT,              -- JSON array of remaining cards; NULL until game ends
  played_at    INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);

CREATE TABLE IF NOT EXISTS game_tricks (
  game_id    TEXT    NOT NULL,
  trick_num  INTEGER NOT NULL,  -- 1-based trick number
  play_order INTEGER NOT NULL,  -- 1 = lead, 4 = last card in trick
  seat       INTEGER NOT NULL,
  card       TEXT    NOT NULL,  -- e.g. "A ♠"
  PRIMARY KEY (game_id, trick_num, play_order)
);

CREATE TABLE IF NOT EXISTS game_metadata (
  game_id      TEXT    NOT NULL PRIMARY KEY,
  bidder_seat  INTEGER NOT NULL,
  bid_num      INTEGER NOT NULL,
  trump_suit   TEXT,             -- NULL for no-trump
  partner_card TEXT    NOT NULL,
  bid_history  TEXT    NOT NULL, -- JSON array of BidHistoryEntry
  seat_map     TEXT    NOT NULL, -- JSON array [{seat, name}]
  tricks_won   TEXT    NOT NULL, -- JSON array [n0,n1,n2,n3] indexed by seat
  winning_team TEXT    NOT NULL, -- 'bidder' | 'opponents'
  played_at    INTEGER NOT NULL
);
