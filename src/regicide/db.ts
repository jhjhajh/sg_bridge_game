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
  /** Verified group members, committed atomically with the global result. */
  groupId?: string | null;
  memberIds?: number[];
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
  const ids = [...new Set(result.telegramIds)];
  const rows = ids.length ? await db
    .prepare(`SELECT telegram_id, rating, games_played FROM regicide_ratings WHERE telegram_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ telegram_id: number; rating: number; games_played: number }>() : { results: [] };
  const existing = new Map((rows.results ?? []).map((r) => [r.telegram_id, r]));
  const team: RatedPlayer[] = ids.map((id) => ({
    telegramId: id,
    rating: existing.get(id)?.rating ?? START_RATING,
    gamesPlayed: existing.get(id)?.games_played ?? 0,
  }));
  const won = result.outcome === 'won';
  const deltas = computeRegicideDeltas(team, result.defeated, won);

  // D1 batches are transactions. Gate every write on the completion marker and
  // insert that marker LAST, so failures roll back and concurrent retries are no-ops.
  // Deltas may use the earlier read, but history and arithmetic use the rating
  // actually present in this transaction (another room may have just rated it).
  const statements = team.flatMap((p) => {
    const delta = deltas.get(p.telegramId) ?? 0;
    return [
      db.prepare(
        `INSERT INTO regicide_rating_history (game_id, telegram_id, rating_before, rating_after, delta, played_at)
         SELECT ?, ?, COALESCE(r.rating, ?), COALESCE(r.rating, ?) + ?, ?, ?
         FROM (SELECT 1) LEFT JOIN regicide_ratings r ON r.telegram_id = ?
         WHERE NOT EXISTS (SELECT 1 FROM regicide_games WHERE game_id = ?)
         RETURNING telegram_id AS telegramId, rating_before AS before, rating_after AS after, delta`,
      ).bind(result.gameId, p.telegramId, START_RATING, START_RATING, delta, delta, now, p.telegramId, result.gameId),
      db.prepare(
        `INSERT INTO regicide_ratings (telegram_id, rating, games_played, wins, best_defeated, updated_at)
         SELECT ?, ?, 1, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM regicide_games WHERE game_id = ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           rating = regicide_ratings.rating + ?,
           games_played = games_played + 1,
           wins = wins + excluded.wins,
           best_defeated = MAX(best_defeated, excluded.best_defeated),
           updated_at = excluded.updated_at`,
      ).bind(p.telegramId, START_RATING + delta, won ? 1 : 0, result.defeated, now, result.gameId, delta),
    ];
  });
  if (result.groupId) {
    for (const id of new Set(result.memberIds ?? [])) {
      statements.push(db.prepare(
        `INSERT INTO regicide_group_stats (group_id, telegram_id, games_played, wins, best_defeated)
         SELECT ?, ?, 1, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM regicide_games WHERE game_id = ?)
         ON CONFLICT(group_id, telegram_id) DO UPDATE SET
           games_played = games_played + 1,
           wins = wins + excluded.wins,
           best_defeated = MAX(best_defeated, excluded.best_defeated)`,
      ).bind(result.groupId, id, won ? 1 : 0, result.defeated, result.gameId));
    }
  }
  statements.push(db.prepare(
    `INSERT OR IGNORE INTO regicide_games (game_id, room_code, num_players, defeated, outcome, jesters_used, played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(result.gameId, result.roomCode, result.numPlayers, result.defeated, result.outcome, result.jestersUsed, now));
  const committed = await db.batch<RatingChange>(statements);
  return team.flatMap((_, i) => committed[i * 2].results ?? []);
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

export interface RegicidePlayerStats {
  displayName: string;
  elo: number;
  games: number;
  wins: number;
  winPct: number;
  bestDefeated: number;
  /** Mean royals defeated per rated game, one decimal. */
  avgDefeated: number;
}

/** Every rated Regicide player, for the full stats table (the client filters by min games, like Bridge). */
export async function getRegicideStats(db: D1Database): Promise<RegicidePlayerStats[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.games_played, r.wins, r.best_defeated,
              (SELECT ROUND(AVG(g.defeated), 1)
                 FROM regicide_rating_history h JOIN regicide_games g ON g.game_id = h.game_id
                WHERE h.telegram_id = r.telegram_id) AS avg_defeated
       FROM regicide_ratings r JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.games_played > 0
       ORDER BY r.rating DESC
       LIMIT 500`,
    )
    .all<{ display_name: string; rating: number; games_played: number; wins: number; best_defeated: number; avg_defeated: number | null }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name,
    elo: r.rating,
    games: r.games_played,
    wins: r.wins,
    winPct: r.games_played ? Math.round((r.wins / r.games_played) * 100) : 0,
    bestDefeated: r.best_defeated,
    avgDefeated: r.avg_defeated ?? 0,
  }));
}

/** Counts a finished game for the group, for players verified as members (like Bridge's recordGroupResult). */
export async function recordRegicideGroupResult(db: D1Database, groupId: string, memberIds: number[], defeated: number, won: boolean): Promise<void> {
  if (memberIds.length === 0) return;
  await db.batch([...new Set(memberIds)].map((id) =>
    db.prepare(
      `INSERT INTO regicide_group_stats (group_id, telegram_id, games_played, wins, best_defeated)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(group_id, telegram_id) DO UPDATE SET
         games_played = games_played + 1,
         wins = wins + excluded.wins,
         best_defeated = MAX(best_defeated, excluded.best_defeated)`,
    ).bind(groupId, id, won ? 1 : 0, defeated),
  ));
}

export interface RegicideGroupEntry {
  displayName: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  bestDefeated: number;
}

/** Group members who have played Regicide in this group, ranked by their (global) Regicide rating — as Bridge's group board ranks by ELO. */
export async function getRegicideGroupLeaderboard(db: D1Database, groupId: string, limit = 5): Promise<RegicideGroupEntry[]> {
  const rows = await db
    .prepare(
      `SELECT u.display_name, COALESCE(r.rating, 1000) AS rating, gs.games_played, gs.wins, gs.best_defeated
       FROM regicide_group_stats gs
       JOIN users u ON u.telegram_id = gs.telegram_id
       LEFT JOIN regicide_ratings r ON r.telegram_id = gs.telegram_id
       WHERE gs.group_id = ? AND gs.games_played > 0
       ORDER BY rating DESC, gs.games_played DESC
       LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<{ display_name: string; rating: number; games_played: number; wins: number; best_defeated: number }>();
  return (rows.results ?? []).map((r) => ({
    displayName: r.display_name, rating: r.rating, gamesPlayed: r.games_played, wins: r.wins, bestDefeated: r.best_defeated,
  }));
}
