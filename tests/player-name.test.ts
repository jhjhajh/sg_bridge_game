import { describe, expect, it } from 'vitest';
import { normalizePlayerName, repairRoomNames, telegramDisplayName } from '../src/player-name';
import type { GameState } from '../src/types';

describe('player display names', () => {
  it.each([undefined, null, {}, [], 42, '', ' \t\n ', '\u200b\u200d\ufeff'])('rejects invisible/non-text name %j', value => {
    expect(normalizePlayerName(value)).toBe('');
  });
  it('normalizes spacing, limits length and preserves meaningful Unicode', () => {
    expect(normalizePlayerName('  Alice\n  李 🎴 ')).toBe('Alice 李 🎴');
    expect(normalizePlayerName('🎴'.repeat(90))).toBe('🎴'.repeat(64));
  });
  it('uses nonempty first/last name or username, and never stringifies malformed data', () => {
    expect(telegramDisplayName({ first_name: ' ', last_name: ' Lee ', username: 'other' })).toBe('Lee');
    expect(telegramDisplayName({ first_name: null, last_name: {}, username: ' alice ' })).toBe('alice');
    expect(telegramDisplayName({ first_name: ' ', last_name: '\u200b', username: '' })).toBe('');
  });
  it('repairs legacy room names without changing IDs, seats or roles', () => {
    const state = { players: [{ id: 'tg_123', name: ' ', seat: 0 }, { id: 'tg_456', name: ' Alice ', seat: 1 }],
      spectators: [{ id: 'tg_789', name: null, watchingSeat: -1 }] } as unknown as GameState;
    expect(repairRoomNames(state)).toBe(true);
    expect(state.players.map(p => [p.id, p.seat, p.name])).toEqual([['tg_123', 0, 'Player 1'], ['tg_456', 1, 'Alice']]);
    expect(state.spectators[0]).toEqual({ id: 'tg_789', name: 'Spectator 1', watchingSeat: -1 });
    expect(repairRoomNames(state)).toBe(false);
  });
});
