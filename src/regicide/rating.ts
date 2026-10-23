// Regicide team rating: Elo against "the castle", scored by how far the team got.
// Separate from Bridge's ELO (users.elo) — stored in regicide_ratings.

export const START_RATING = 1000;
/** The castle's fixed rating. A new 1000-rated team is expected to defeat ~3 of 12 royals. */
export const CASTLE_RATING = 1200;
export const ROYALS = 12;

export interface RatedPlayer {
  telegramId: number;
  rating: number;
  gamesPlayed: number;
}

/** 0..1: share of the castle defeated; a win always scores 1. */
export function progressScore(defeated: number, won: boolean): number {
  return won ? 1 : Math.max(0, Math.min(ROYALS, defeated)) / ROYALS;
}

/** Expected progress for a team with this average rating. */
export function expectedScore(teamAverage: number): number {
  return 1 / (1 + Math.pow(10, (CASTLE_RATING - teamAverage) / 400));
}

/**
 * Rating change per player. The whole team shares one score and one expectation;
 * K follows Bridge's elo.ts (32 for a player's first 30 games, then 16).
 */
export function computeRegicideDeltas(team: RatedPlayer[], defeated: number, won: boolean): Map<number, number> {
  const deltas = new Map<number, number>();
  if (team.length === 0) return deltas;
  const average = team.reduce((sum, p) => sum + p.rating, 0) / team.length;
  const diff = progressScore(defeated, won) - expectedScore(average);
  for (const player of team) {
    const k = player.gamesPlayed < 30 ? 32 : 16;
    deltas.set(player.telegramId, Math.round(k * diff));
  }
  return deltas;
}
