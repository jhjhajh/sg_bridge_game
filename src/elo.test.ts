import { describe, it, expect } from 'vitest';
import { computeEloDeltas } from './elo';

describe('computeEloDeltas', () => {
  it('awards +16 and -16 when teams are equal (K=32)', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 5 }, { telegramId: 2, elo: 1000, gamesPlayed: 5 }],
      [{ telegramId: 3, elo: 1000, gamesPlayed: 5 }, { telegramId: 4, elo: 1000, gamesPlayed: 5 }],
      true,
    );
    expect(result.get(1)).toBe(16);
    expect(result.get(2)).toBe(16);
    expect(result.get(3)).toBe(-16);
    expect(result.get(4)).toBe(-16);
  });

  it('awards smaller gain to heavily favoured team that wins', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1200, gamesPlayed: 5 }, { telegramId: 2, elo: 1200, gamesPlayed: 5 }],
      [{ telegramId: 3, elo: 1000, gamesPlayed: 5 }, { telegramId: 4, elo: 1000, gamesPlayed: 5 }],
      true,
    );
    // favoured team wins: smaller positive delta
    expect(result.get(1)!).toBeGreaterThan(0);
    expect(result.get(1)!).toBeLessThan(16);
    // underdog team loses: smaller negative delta
    expect(result.get(3)!).toBeLessThan(0);
    expect(result.get(3)!).toBeGreaterThan(-16);
  });

  it('awards large gain to underdog team that wins', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 5 }, { telegramId: 2, elo: 1000, gamesPlayed: 5 }],
      [{ telegramId: 3, elo: 1200, gamesPlayed: 5 }, { telegramId: 4, elo: 1200, gamesPlayed: 5 }],
      true,
    );
    // underdog wins: large positive delta
    expect(result.get(1)!).toBeGreaterThan(16);
    expect(result.get(3)!).toBeLessThan(-16);
  });

  it('uses K=16 for players with 30+ games', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 30 }],
      [{ telegramId: 2, elo: 1000, gamesPlayed: 30 }],
      true,
    );
    expect(result.get(1)).toBe(8);
    expect(result.get(2)).toBe(-8);
  });

  it('uses K=32 for players with fewer than 30 games', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 29 }],
      [{ telegramId: 2, elo: 1000, gamesPlayed: 29 }],
      true,
    );
    expect(result.get(1)).toBe(16);
    expect(result.get(2)).toBe(-16);
  });

  it('handles solo bidder (team of one)', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 5 }],
      [{ telegramId: 2, elo: 1000, gamesPlayed: 5 }, { telegramId: 3, elo: 1000, gamesPlayed: 5 }],
      true,
    );
    expect(result.get(1)).toBe(16);
    expect(result.get(2)).toBe(-16);
    expect(result.get(3)).toBe(-16);
  });

  it('negative delta when team A loses', () => {
    const result = computeEloDeltas(
      [{ telegramId: 1, elo: 1000, gamesPlayed: 5 }, { telegramId: 2, elo: 1000, gamesPlayed: 5 }],
      [{ telegramId: 3, elo: 1000, gamesPlayed: 5 }, { telegramId: 4, elo: 1000, gamesPlayed: 5 }],
      false,
    );
    expect(result.get(1)).toBe(-16);
    expect(result.get(2)).toBe(-16);
    expect(result.get(3)).toBe(16);
    expect(result.get(4)).toBe(16);
  });
});
