-- Regicide results per Telegram group, mirroring Bridge's group_stats: only
-- players verified as members of the group when they joined are counted.

CREATE TABLE IF NOT EXISTS regicide_group_stats (
  group_id       TEXT    NOT NULL,
  telegram_id    INTEGER NOT NULL,
  games_played   INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  best_defeated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, telegram_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
