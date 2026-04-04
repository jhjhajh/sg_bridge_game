import type { D1Database } from '@cloudflare/workers-types';
import type { Player, Hand, TrickLogEntry, BidHistoryEntry } from './types';
import { CARD_SUITS } from './types';

function handToCards(hand: Hand): string[] {
  return CARD_SUITS.flatMap((suit) => hand[suit].map((v) => `${v} ${suit}`));
}

export async function insertGameHands(
  db: D1Database,
  gameId: string,
  players: Player[],
  hands: Hand[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stmts = players.map((p) =>
    db.prepare(
      `INSERT INTO game_hands (game_id, seat, player_name, initial_hand, played_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(gameId, p.seat, p.name, JSON.stringify(handToCards(hands[p.seat])), now),
  );
  await db.batch(stmts);
}

export async function updateGameFinalHands(
  db: D1Database,
  gameId: string,
  players: Player[],
  hands: Hand[],
): Promise<void> {
  const stmts = players.map((p) =>
    db.prepare(
      `UPDATE game_hands SET final_hand = ? WHERE game_id = ? AND seat = ?`,
    ).bind(JSON.stringify(handToCards(hands[p.seat])), gameId, p.seat),
  );
  await db.batch(stmts);
}

export async function insertGameTricks(
  db: D1Database,
  gameId: string,
  trickLog: TrickLogEntry[],
): Promise<void> {
  if (trickLog.length === 0) return;
  const stmts = trickLog.map((e) =>
    db.prepare(
      `INSERT INTO game_tricks (game_id, trick_num, play_order, seat, card)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(gameId, e.trickNum, e.playOrder, e.seat, e.card),
  );
  await db.batch(stmts);
}

export async function insertGameMetadata(
  db: D1Database,
  gameId: string,
  bidderSeat: number,
  bidNum: number,
  trumpSuit: string | null,
  partnerCard: string,
  bidHistory: BidHistoryEntry[],
  players: Player[],
  sets: number[],
  winningTeam: 'bidder' | 'opponents',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const seatMap = players.map((p) => ({ seat: p.seat, name: p.name }));
  await db
    .prepare(
      `INSERT INTO game_metadata
         (game_id, bidder_seat, bid_num, trump_suit, partner_card,
          bid_history, seat_map, tricks_won, winning_team, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      gameId,
      bidderSeat,
      bidNum,
      trumpSuit,
      partnerCard,
      JSON.stringify(bidHistory),
      JSON.stringify(seatMap),
      JSON.stringify(sets),
      winningTeam,
      now,
    )
    .run();
}
