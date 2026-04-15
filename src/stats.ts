import type { D1Database } from '@cloudflare/workers-types';
import type { Player } from './types';

/**
 * Returns the seat numbers of the winning team.
 * When partner === bidder (called their own card), bidder wins/loses alone.
 */
export function getWinnerSeats(bidder: number, partner: number, bidderWon: boolean): number[] {
  const bidderTeam = bidder === partner ? [bidder] : [bidder, partner];
  if (bidderWon) return bidderTeam;
  return [0, 1, 2, 3].filter((s) => !bidderTeam.includes(s));
}

/**
 * Increments wins and games_played for all authenticated players.
 * Guests (non-tg_ IDs) are silently skipped.
 */
export async function recordGameResult(
  db: D1Database,
  players: Player[],
  winnerSeats: number[],
): Promise<void> {
  await Promise.all(
    players.map((player) => {
      // Use originalPlayerId if this is a bot replacement, otherwise use player.id
      const playerId = player.originalPlayerId || player.id;
      if (!playerId.startsWith('tg_')) return Promise.resolve();
      const telegramId = Number(playerId.slice(3));
      const won = winnerSeats.includes(player.seat) ? 1 : 0;
      return db
        .prepare(
          'UPDATE users SET games_played = games_played + 1, wins = wins + ? WHERE telegram_id = ?',
        )
        .bind(won, telegramId)
        .run();
    }),
  );
}
