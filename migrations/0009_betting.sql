-- Betting system for spectators
CREATE TABLE betting_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT    NOT NULL,
  spectator_id   TEXT    NOT NULL,
  spectator_name TEXT    NOT NULL,
  watched_seat   INTEGER NOT NULL,
  prediction     TEXT    NOT NULL CHECK(prediction IN ('win', 'lose')),
  correct        INTEGER CHECK(correct IN (0, 1)),
  placed_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_betting_records_game_spectator ON betting_records(game_id, spectator_id);
CREATE INDEX idx_betting_records_game_id ON betting_records(game_id);
CREATE INDEX idx_betting_records_spectator ON betting_records(spectator_id);

-- Betting ELO on users
ALTER TABLE users ADD COLUMN betting_elo INTEGER NOT NULL DEFAULT 1000;

-- Per-game ELO change history for betting
CREATE TABLE betting_elo_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT    NOT NULL,
  telegram_id INTEGER NOT NULL,
  elo_before  INTEGER NOT NULL,
  elo_after   INTEGER NOT NULL,
  delta       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  placed_at   INTEGER NOT NULL
);

CREATE INDEX idx_bet_elo_hist_user ON betting_elo_history(telegram_id, placed_at DESC);
CREATE INDEX idx_bet_elo_hist_game ON betting_elo_history(game_id);
