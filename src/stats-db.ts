import type { D1Database } from '@cloudflare/workers-types';
import type { Player } from './types';
import { BID_SUITS } from './types';
import { computeEloDeltas } from './elo';
import type { EloPlayer } from './elo';

export interface PlayerStatRow {
  telegramId: number;
  displayName: string;
  elo: number;
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

  const playedAt = Math.floor(Date.now() / 1000);

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
        if (!isSoloBidder) {
          const oppPartnerSeat = oppTeam.find((s) => s !== seat) ?? null;
          partnerTgId = oppPartnerSeat !== null ? (seatToTgId[oppPartnerSeat] ?? null) : null;
        }
        // isSoloBidder: no natural pairs, leave partnerTgId as null
      }

      return db
        .prepare(
          `INSERT INTO game_records
           (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          gameId, groupId, playedAt,
          telegramId, role, won, bidLevel, bidSuit, tricksWon, partnerTgId,
        );
    });

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

function pct(wins: number, games: number): number {
  return games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;
}

export async function getPlayerStats(db: D1Database, groupId?: string): Promise<PlayerStatRow[]> {
  const where = groupId ? 'WHERE gr.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId] : [];

  const main = await db
    .prepare(
      `SELECT
         u.telegram_id, u.display_name, u.elo,
         COUNT(*) as games,
         SUM(gr.won) as wins,
         ROUND(100.0 * SUM(gr.won) / COUNT(*), 1) as win_pct,
         SUM(CASE WHEN gr.role = 'bidder' THEN 1 ELSE 0 END) as bidder_games,
         SUM(CASE WHEN gr.role = 'bidder' AND gr.won = 1 THEN 1 ELSE 0 END) as bidder_wins,
         SUM(CASE WHEN gr.role = 'partner' THEN 1 ELSE 0 END) as partner_games,
         SUM(CASE WHEN gr.role = 'partner' AND gr.won = 1 THEN 1 ELSE 0 END) as partner_wins,
         SUM(CASE WHEN gr.role = 'opposition' THEN 1 ELSE 0 END) as opp_games,
         SUM(CASE WHEN gr.role = 'opposition' AND gr.won = 1 THEN 1 ELSE 0 END) as opp_wins
       FROM game_records gr
       JOIN users u ON u.telegram_id = gr.telegram_id
       ${where}
       GROUP BY gr.telegram_id
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{
      telegram_id: number; display_name: string; elo: number;
      games: number; wins: number; win_pct: number;
      bidder_games: number; bidder_wins: number;
      partner_games: number; partner_wins: number;
      opp_games: number; opp_wins: number;
    }>();

  const suitWhere = groupId ? "WHERE role = 'bidder' AND group_id = ?" : "WHERE role = 'bidder'";
  const suits = await db
    .prepare(
      `SELECT telegram_id, bid_suit
       FROM (
         SELECT telegram_id, bid_suit,
                ROW_NUMBER() OVER (PARTITION BY telegram_id ORDER BY COUNT(*) DESC) as rn
         FROM game_records
         ${suitWhere}
         GROUP BY telegram_id, bid_suit
       )
       WHERE rn = 1`,
    )
    .bind(...bindings)
    .all<{ telegram_id: number; bid_suit: string }>();

  const favSuit = new Map((suits.results ?? []).map((r) => [r.telegram_id, r.bid_suit]));

  return (main.results ?? []).map((r) => ({
    telegramId: r.telegram_id,
    displayName: r.display_name,
    elo: r.elo,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
    bidder: { games: r.bidder_games, wins: r.bidder_wins, winPct: pct(r.bidder_wins, r.bidder_games) },
    partner: { games: r.partner_games, wins: r.partner_wins, winPct: pct(r.partner_wins, r.partner_games) },
    opposition: { games: r.opp_games, wins: r.opp_wins, winPct: pct(r.opp_wins, r.opp_games) },
    favBidSuit: favSuit.get(r.telegram_id) ?? null,
  }));
}

export async function getPairStats(db: D1Database, groupId?: string): Promise<PairStatRow[]> {
  const where = groupId ? 'WHERE gr1.group_id = ? AND gr2.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId, groupId] : [];

  const rows = await db
    .prepare(
      `SELECT
         u1.display_name as player1,
         u2.display_name as player2,
         COUNT(*) as games,
         SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) as wins,
         ROUND(100.0 * SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct
       FROM game_records gr1
       JOIN game_records gr2
         ON gr1.game_id = gr2.game_id
        AND gr1.telegram_id < gr2.telegram_id
        AND gr1.won = gr2.won
       JOIN users u1 ON u1.telegram_id = gr1.telegram_id
       JOIN users u2 ON u2.telegram_id = gr2.telegram_id
       ${where}
       GROUP BY gr1.telegram_id, gr2.telegram_id
       HAVING COUNT(*) >= 2
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{ player1: string; player2: string; games: number; wins: number; win_pct: number }>();

  return (rows.results ?? []).map((r) => ({
    player1: r.player1,
    player2: r.player2,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
  }));
}

/**
 * Computes pair ELO deltas after a game and updates users.elo + elo_history.
 * Only authenticated players (tg_ IDs) are included. Guests and bots are skipped.
 * All DB writes are batched in a single db.batch() call.
 */
export interface EloResult {
  seat: number;
  name: string;
  delta: number;
  eloAfter: number;
}

export async function recordEloUpdate(
  db: D1Database,
  gameId: string,
  players: Player[],
  bidderSeat: number,
  partnerSeat: number,
  winnerSeats: number[],
): Promise<EloResult[]> {
  const authPlayers = players.filter((p) => p.id.startsWith('tg_'));
  if (authPlayers.length < 2) return [];

  const telegramIds = authPlayers.map((p) => Number(p.id.slice(3)));
  const placeholders = telegramIds.map(() => '?').join(',');
  const userRows = await db
    .prepare(`SELECT telegram_id, elo, games_played FROM users WHERE telegram_id IN (${placeholders})`)
    .bind(...telegramIds)
    .all<{ telegram_id: number; elo: number; games_played: number }>();

  const userMap = new Map(
    (userRows.results ?? []).map((r) => [r.telegram_id, r]),
  );

  const seatToPlayer = new Map<number, EloPlayer>();
  for (const p of authPlayers) {
    const tgId = Number(p.id.slice(3));
    const row = userMap.get(tgId);
    if (row) seatToPlayer.set(p.seat, { telegramId: tgId, elo: row.elo, gamesPlayed: row.games_played });
  }

  const isSoloBid = bidderSeat === partnerSeat;
  const bidderTeamSeats = isSoloBid ? [bidderSeat] : [bidderSeat, partnerSeat];
  const oppTeamSeats = [0, 1, 2, 3].filter((s) => !bidderTeamSeats.includes(s));

  const teamA = bidderTeamSeats.map((s) => seatToPlayer.get(s)).filter(Boolean) as EloPlayer[];
  const teamB = oppTeamSeats.map((s) => seatToPlayer.get(s)).filter(Boolean) as EloPlayer[];

  if (teamA.length === 0 || teamB.length === 0) return [];

  const teamAWon = winnerSeats.includes(bidderSeat);
  const deltas = computeEloDeltas(teamA, teamB, teamAWon);

  const playedAt = Math.floor(Date.now() / 1000);
  const allPlayers = [...teamA, ...teamB];

  const results: EloResult[] = [];
  const stmts = allPlayers.flatMap((player) => {
    const delta = deltas.get(player.telegramId) ?? 0;
    const newElo = player.elo + delta;
    const p = players.find((pl) => pl.id === `tg_${player.telegramId}`);
    if (p) results.push({ seat: p.seat, name: p.name, delta, eloAfter: newElo });
    return [
      db
        .prepare('UPDATE users SET elo = ? WHERE telegram_id = ?')
        .bind(newElo, player.telegramId),
      db
        .prepare(
          `INSERT INTO elo_history (game_id, telegram_id, elo_before, elo_after, delta, played_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(gameId, player.telegramId, player.elo, newElo, delta, playedAt),
    ];
  });

  await db.batch(stmts);
  return results;
}
