import { describe, it, expect } from 'vitest';
import { computeRegicideDeltas, expectedScore, progressScore, CASTLE_RATING } from '../src/regicide/rating';

const player = (telegramId: number, rating = 1000, gamesPlayed = 0) => ({ telegramId, rating, gamesPlayed });

describe('regicide rating', () => {
  it('scores progress as royals defeated out of 12, a win as 1', () => {
    expect(progressScore(0, false)).toBe(0);
    expect(progressScore(6, false)).toBe(0.5);
    expect(progressScore(11, false)).toBeCloseTo(11 / 12);
    expect(progressScore(12, true)).toBe(1);
    expect(progressScore(99, false)).toBe(1);
  });

  it('expects a new team to get about a quarter of the way', () => {
    expect(expectedScore(1000)).toBeCloseTo(0.24, 2);
    expect(expectedScore(CASTLE_RATING)).toBe(0.5);
  });

  it('a new team breaks even at 3 royals, gains for going further, loses for falling short', () => {
    expect(computeRegicideDeltas([player(1)], 3, false).get(1)).toBe(0);
    expect(computeRegicideDeltas([player(1)], 12, true).get(1)).toBe(24);
    expect(computeRegicideDeltas([player(1)], 0, false).get(1)).toBe(-8);
    expect(computeRegicideDeltas([player(1)], 8, false).get(1)).toBeGreaterThan(0);
  });

  it('shares one result across the team, with Bridge-style K per player', () => {
    const deltas = computeRegicideDeltas([player(1, 1000, 0), player(2, 1000, 50)], 12, true);
    expect(deltas.get(1)).toBe(24); // K=32, still placing
    expect(deltas.get(2)).toBe(12); // K=16 after 30 games
  });

  it('expects more from a stronger team', () => {
    const strong = computeRegicideDeltas([player(1, 1500, 40), player(2, 1500, 40)], 6, false);
    expect(strong.get(1)).toBeLessThan(0);
  });
});
