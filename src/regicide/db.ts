import type { D1Database } from '@cloudflare/workers-types';
import { computeRegicideDeltas, START_RATING, type RatedPlayer } from './rating';

export type RegicideOutcome = 'won' | 'lost' | 'abandoned';

export interface RegicideGameResult {
  gameId: string;
  roomCode: string;
  numPlayers: number;
  defeated: number;
  outcome: RegicideOutcome;
  jestersUsed: number;
  telegramIds: number[];
}

export interface RatingChange {
  telegramId: number;
  before: number;
  after: number;
  delta: number;
}

/**
 * Rates a finished game for every signed-in player and records it.
 * Idempotent per gameId: a second call for the same game changes nothing and returns [].
 */
export async function recordRegicideGame(db: D1Database, result: RegicideGameResult, now = Math.floor(Date.now() / 1000)): Promise<RatingChange[]> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO regicide_games (game_id, room_code, num_players, defeated, outcome, jesters_used, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(result.gameId, result.roomCode, result.numPlayers, result.defeated, result.outcome, result.jestersUsed, now)
    .run();
  if (!inserted.meta.changes) return [];

  const ids = [...new Set(result.telegramIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .prepare(`SELECT telegram_id, rating, games_played FROM regicide_ratings WHERE telegram_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ telegram_id: number; rating: number; games_played: number }>();
  const existing = new Map((rows.results ?? []).map((r) => [r.telegram_id, r]));
  const team: RatedPlayer[] = ids.map((id) => ({
    telegramId: id,
    rating: existing.get(id)?.rating ?? START_RATING,
    gamesPlayed: existing.get(id)?.games_played ?? 0,
  }));
  const won = result.outcome === 'won';
  const deltas = computeRegicideDeltas(team, result.defeated, won);

  const changes: RatingChange[] = team.map((p) => {
    const delta = deltas.get(p.telegramId) ?? 0;
    return { telegramId: p.telegramId, before: p.rating, after: p.rating + delta, delta };
  });
  await db.batch(changes.flatMap((c) => [
    db.prepare(
      `INSERT INTO regicide_ratings (telegram_id, rating, games_played, wins, best_defeated, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         rating = excluded.rating,
         games_played = games_played + 1,
         wins = wins + excluded.wins,
         best_defeated = MAX(best_defeated, excluded.best_defeated),
         updated_at = excluded.updated_at`,
    ).bind(c.telegramId, c.after, won ? 1 : 0, result.defeated, now),
    db.prepare(
      `INSERT OR IGNORE INTO regicide_rating_history (game_id, telegram_id, rating_before, rating_after, delta, played_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(result.gameId, c.telegramId, c.before, c.after, c.delta, now),
  ]));
  return changes;
}

export interface RegicideLeaderboardEntry {
  rank: number;
  displayName: string;
  elo: number;
  wins: number;
  gamesPlayed: number;
  bestDefeated: number;
}

type Row = { display_name: string; rating: number; wins: number; games_played: number; best_defeated: number; rank: number };
const toEntry = (r: Row): RegicideLeaderboardEntry => ({
  rank: r.rank, displayName: r.display_name, elo: r.rating, wins: r.wins, gamesPlayed: r.games_played, bestDefeated: r.best_defeated,
});

/** Same shape as Bridge's getLeaderboard ({ top, me }) so one leaderboard card can render both. */
export async function getRegicideLeaderboard(
  db: D1Database,
  telegramId?: number,
  limit = 5,
): Promise<{ top: RegicideLeaderboardEntry[]; me: RegicideLeaderboardEntry | null }> {
  const top = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.wins, r.games_played, r.best_defeated,
              RANK() OVER (ORDER BY r.rating DESC) AS rank
       FROM regicide_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC, r.games_played DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Row>();
  const entries = (top.results ?? []).map(toEntry);
  if (!telegramId) return { top: entries, me: null };

  const me = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.wins, r.games_played, r.best_defeated,
              (SELECT COUNT(*) + 1 FROM regicide_ratings o WHERE o.games_played > 0 AND o.rating > r.rating) AS rank
       FROM regicide_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.telegram_id = ? AND r.games_played > 0`,
    )
    .bind(telegramId)
    .first<Row>();
  if (!me || me.rank <= limit) return { top: entries, me: null };
  return { top: entries, me: toEntry(me) };
}
