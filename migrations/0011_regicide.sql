-- Regicide (co-op) ratings and group stats — everything Regicide needs, in one file.
-- Kept apart from Bridge's users.elo / game_records / group_stats so the boards never mix.
-- Only CREATE ... IF NOT EXISTS: safe to run more than once, touches no Bridge data.

CREATE TABLE IF NOT EXISTS regicide_ratings (
  telegram_id    INTEGER PRIMARY KEY,
  rating         INTEGER NOT NULL DEFAULT 1000,
  games_played   INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  best_defeated  INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regicide_ratings_rating ON regicide_ratings(rating DESC);

-- One row per rated game: outcome is 'won', 'lost' or 'abandoned'.
CREATE TABLE IF NOT EXISTS regicide_games (
  game_id       TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL,
  num_players   INTEGER NOT NULL,
  defeated      INTEGER NOT NULL,
  outcome       TEXT NOT NULL,
  jesters_used  INTEGER NOT NULL DEFAULT 0,
  played_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regicide_rating_history (
  game_id        TEXT NOT NULL,
  telegram_id    INTEGER NOT NULL,
  rating_before  INTEGER NOT NULL,
  rating_after   INTEGER NOT NULL,
  delta          INTEGER NOT NULL,
  played_at      INTEGER NOT NULL,
  PRIMARY KEY (game_id, telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_regicide_history_player ON regicide_rating_history(telegram_id, played_at DESC);

-- Results per Telegram group, mirroring Bridge's group_stats: only players
-- verified as members of the group when they joined are counted.

CREATE TABLE IF NOT EXISTS regicide_group_stats (
  group_id       TEXT    NOT NULL,
  telegram_id    INTEGER NOT NULL,
  games_played   INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  best_defeated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, telegram_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
