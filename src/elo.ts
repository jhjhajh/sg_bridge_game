export interface EloPlayer {
  telegramId: number;
  elo: number;
  gamesPlayed: number;
}

/**
 * Computes ELO deltas for a pair team game.
 * teamA is the bidder team, teamB is the opposition.
 * teamAWon indicates whether teamA won.
 * Returns a Map of telegramId → delta (positive = gain, negative = loss).
 */
export function computeEloDeltas(
  teamA: EloPlayer[],
  teamB: EloPlayer[],
  teamAWon: boolean,
): Map<number, number> {
  const avgA = teamA.reduce((sum, p) => sum + p.elo, 0) / teamA.length;
  const avgB = teamB.reduce((sum, p) => sum + p.elo, 0) / teamB.length;

  const eA = 1 / (1 + Math.pow(10, (avgB - avgA) / 400));
  const eB = 1 - eA;

  const deltas = new Map<number, number>();

  for (const player of teamA) {
    const k = player.gamesPlayed < 30 ? 32 : 16;
    const score = teamAWon ? 1 : 0;
    deltas.set(player.telegramId, Math.round(k * (score - eA)));
  }

  for (const player of teamB) {
    const k = player.gamesPlayed < 30 ? 32 : 16;
    const score = teamAWon ? 0 : 1;
    deltas.set(player.telegramId, Math.round(k * (score - eB)));
  }

  return deltas;
}
