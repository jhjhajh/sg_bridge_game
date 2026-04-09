import type { D1Database } from '@cloudflare/workers-types';

export interface BettingLeaderboardEntry {
  rank: number;
  displayName: string;
  bettingElo: number;
  totalBets: number;
  correctBets: number;
  accuracyPct: number;
}

/** Get the current user's bet for a specific game (if any). */
export async function getUserBet(
  db: D1Database,
  gameId: string,
  spectatorId: string,
): Promise<{ prediction: 'win' | 'lose'; correct: number | null } | null> {
  const row = await db
    .prepare(`SELECT prediction, correct FROM betting_records WHERE game_id = ? AND spectator_id = ?`)
    .bind(gameId, spectatorId)
    .first<{ prediction: string; correct: number | null }>();
  if (!row) return null;
  return { prediction: row.prediction as 'win' | 'lose', correct: row.correct };
}

/**
 * Place a bet from a spectator. Returns success or conflict error.
 * Uses UNIQUE constraint to prevent duplicate bets per (gameId, spectatorId).
 */
export async function placeBet(
  db: D1Database,
  gameId: string,
  spectatorId: string,
  spectatorName: string,
  watchedSeat: number,
  prediction: 'win' | 'lose',
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO betting_records (game_id, spectator_id, spectator_name, watched_seat, prediction, placed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, spectator_id) DO NOTHING`,
      )
      .bind(gameId, spectatorId, spectatorName, watchedSeat, prediction, Math.floor(Date.now() / 1000))
      .run();

    if (result.meta.changes === 0) {
      return { ok: false, reason: 'You have already placed a bet this game.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Database error.' };
  }
}

/**
 * Settle all pending bets for a game and update betting ELO for authenticated bettors.
 * Should be called once when the game ends.
 */
export async function settleBetsAndUpdateElo(
  db: D1Database,
  gameId: string,
  bidderTeamWon: boolean,
): Promise<void> {
  const pending = await db
    .prepare(
      `SELECT spectator_id, spectator_name, prediction, placed_at
       FROM betting_records
       WHERE game_id = ? AND correct IS NULL`,
    )
    .bind(gameId)
    .all<{ spectator_id: string; spectator_name: string; prediction: string; placed_at: number }>();

  const bets = pending.results ?? [];
  if (bets.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  for (const bet of bets) {
    const isCorrect = (bet.prediction === 'win') === bidderTeamWon;

    if (bet.spectator_id.startsWith('tg_')) {
      const telegramId = Number(bet.spectator_id.slice(3));
      if (Number.isNaN(telegramId)) continue;

      const userRow = await db
        .prepare(
          `SELECT u.betting_elo,
                  (SELECT COUNT(*) FROM betting_records WHERE spectator_id = ? AND correct IS NOT NULL) AS settled_count
           FROM users u
           WHERE u.telegram_id = ?`,
        )
        .bind(bet.spectator_id, telegramId)
        .first<{ betting_elo: number; settled_count: number }>();

      if (!userRow) continue;

      const K = userRow.settled_count < 10 ? 32 : 16;
      const delta = Math.round(K * (isCorrect ? 0.5 : -0.5));
      const eloBefore = userRow.betting_elo;
      const eloAfter = Math.max(100, eloBefore + delta);

      await db
        .prepare(`UPDATE users SET betting_elo = ? WHERE telegram_id = ?`)
        .bind(eloAfter, telegramId)
        .run();

      await db
        .prepare(
          `INSERT INTO betting_elo_history (game_id, telegram_id, elo_before, elo_after, delta, correct, placed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(gameId, telegramId, eloBefore, eloAfter, delta, isCorrect ? 1 : 0, now)
        .run();
    }
  }

  await db
    .prepare(
      `UPDATE betting_records
       SET correct = CASE WHEN (prediction = 'win') = ? THEN 1 ELSE 0 END
       WHERE game_id = ? AND correct IS NULL`,
    )
    .bind(bidderTeamWon ? 1 : 0, gameId)
    .run();
}

/**
 * Get betting leaderboard: top 10 by betting ELO (min 1 settled bet).
 * Returns top 10 + optional caller's rank if not in top 10 (requires 3+ bets).
 */
export async function getBettingLeaderboard(
  db: D1Database,
  telegramId?: number,
): Promise<{ top: BettingLeaderboardEntry[]; me: (BettingLeaderboardEntry & { telegramId: number }) | null }> {
  const topRows = await db
    .prepare(
      `SELECT
         u.display_name,
         u.betting_elo,
         COUNT(*)                                                          AS total_bets,
         SUM(b.correct)                                                    AS correct_bets,
         ROUND(100.0 * SUM(b.correct) / COUNT(*), 1)                      AS accuracy_pct,
         RANK() OVER (ORDER BY u.betting_elo DESC)                         AS rank
       FROM betting_records b
       JOIN users u ON u.telegram_id = CAST(SUBSTR(b.spectator_id, 4) AS INTEGER)
       WHERE b.spectator_id LIKE 'tg_%' AND b.correct IS NOT NULL
       GROUP BY b.spectator_id
       HAVING COUNT(*) >= 1
       ORDER BY u.betting_elo DESC
       LIMIT 10`,
    )
    .all<{ display_name: string; betting_elo: number; total_bets: number; correct_bets: number; accuracy_pct: number; rank: number }>();

  const top: BettingLeaderboardEntry[] = (topRows.results ?? []).map((r) => ({
    rank: r.rank,
    displayName: r.display_name,
    bettingElo: r.betting_elo,
    totalBets: r.total_bets,
    correctBets: r.correct_bets,
    accuracyPct: r.accuracy_pct,
  }));

  if (!telegramId) return { top, me: null };

  const spectatorId = `tg_${telegramId}`;
  const meRow = await db
    .prepare(
      `SELECT
         u.betting_elo,
         COUNT(*)                                      AS total_bets,
         SUM(b.correct)                                AS correct_bets,
         ROUND(100.0 * SUM(b.correct) / COUNT(*), 1)  AS accuracy_pct
       FROM betting_records b
       JOIN users u ON u.telegram_id = ?
       WHERE b.spectator_id = ? AND b.correct IS NOT NULL
       GROUP BY b.spectator_id
       HAVING COUNT(*) >= 3`,
    )
    .bind(telegramId, spectatorId)
    .first<{ betting_elo: number; total_bets: number; correct_bets: number; accuracy_pct: number }>();

  if (!meRow) return { top, me: null };

  const rankRow = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank
       FROM (
         SELECT u.betting_elo
         FROM betting_records b
         JOIN users u ON u.telegram_id = CAST(SUBSTR(b.spectator_id, 4) AS INTEGER)
         WHERE b.spectator_id LIKE 'tg_%' AND b.correct IS NOT NULL
         GROUP BY b.spectator_id
         HAVING COUNT(*) >= 3 AND u.betting_elo > ?
       )`,
    )
    .bind(meRow.betting_elo)
    .first<{ rank: number }>();

  const myRank = rankRow?.rank ?? 1;
  const inTop = top.some((e) => e.rank === myRank);
  if (inTop) return { top, me: null };

  const userRow = await db
    .prepare(`SELECT display_name FROM users WHERE telegram_id = ?`)
    .bind(telegramId)
    .first<{ display_name: string }>();

  if (!userRow) return { top, me: null };

  return {
    top,
    me: {
      rank: myRank,
      displayName: userRow.display_name,
      bettingElo: meRow.betting_elo,
      totalBets: meRow.total_bets,
      correctBets: meRow.correct_bets,
      accuracyPct: meRow.accuracy_pct,
      telegramId,
    },
  };
}
