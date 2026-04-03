import type { D1Database } from '@cloudflare/workers-types';
import type { Player } from './types';

const BID_SUITS = ['♣', '♦', '♥', '♠', '🚫'] as const;

export interface PlayerStatRow {
  telegramId: number;
  displayName: string;
  games: number;
  wins: number;
  winPct: number;
  bidder: { games: number; wins: number; winPct: number };
  partner: { games: number; wins: number; winPct: number };
  opposition: { games: number; wins: number; winPct: number };
  favBidSuit: string | null;
}

export interface PairStatRow {
  player1: string;
  player2: string;
  games: number;
  wins: number;
  winPct: number;
}

/**
 * Inserts one game_records row per authenticated player.
 * Guests (non-tg_ IDs) and bots are silently skipped.
 */
export async function recordGameStats(
  db: D1Database,
  gameId: string,
  groupId: string | null,
  players: Player[],
  bidderSeat: number,
  partnerSeat: number,
  bid: number,
  sets: number[],
  winnerSeats: number[],
): Promise<void> {
  const bidLevel = Math.floor(bid / 5) + 1;
  const bidSuit = BID_SUITS[bid % 5];
  const isSoloBidder = bidderSeat === partnerSeat;
  const bidderTeam = isSoloBidder ? [bidderSeat] : [bidderSeat, partnerSeat];
  const oppTeam = [0, 1, 2, 3].filter((s) => !bidderTeam.includes(s));

  const bidderTricksWon = bidderTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);
  const oppTricksWon = oppTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);

  // seat → telegram_id lookup (null for guests)
  const seatToTgId: Record<number, number | null> = {};
  for (const p of players) {
    seatToTgId[p.seat] = p.id.startsWith('tg_') ? Number(p.id.slice(3)) : null;
  }

  const stmts = players
    .filter((p) => p.id.startsWith('tg_'))
    .map((player) => {
      const telegramId = Number(player.id.slice(3));
      const { seat } = player;
      const won = winnerSeats.includes(seat) ? 1 : 0;
      const tricksWon = bidderTeam.includes(seat) ? bidderTricksWon : oppTricksWon;

      let role: 'bidder' | 'partner' | 'opposition';
      let partnerTgId: number | null = null;

      if (seat === bidderSeat) {
        role = 'bidder';
        partnerTgId = isSoloBidder ? null : (seatToTgId[partnerSeat] ?? null);
      } else if (!isSoloBidder && seat === partnerSeat) {
        role = 'partner';
        partnerTgId = seatToTgId[bidderSeat] ?? null;
      } else {
        role = 'opposition';
        const oppPartnerSeat = oppTeam.find((s) => s !== seat) ?? null;
        partnerTgId = oppPartnerSeat !== null ? (seatToTgId[oppPartnerSeat] ?? null) : null;
      }

      return db
        .prepare(
          `INSERT INTO game_records
           (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          gameId, groupId, Math.floor(Date.now() / 1000),
          telegramId, role, won, bidLevel, bidSuit, tricksWon, partnerTgId,
        );
    });

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}
