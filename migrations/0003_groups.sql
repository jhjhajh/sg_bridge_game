CREATE TABLE IF NOT EXISTS groups (
  group_id   TEXT    PRIMARY KEY,
  group_name TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_stats (
  group_id     TEXT    NOT NULL,
  telegram_id  INTEGER NOT NULL,
  wins         INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, telegram_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
