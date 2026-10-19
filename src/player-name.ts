import type { GameState } from './types';

export const UNNAMED_TELEGRAM_USER = 'Telegram player';

/** Display text only: this never establishes or changes a player's identity. */
export function normalizePlayerName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(clean) ? Array.from(clean).slice(0, 64).join('') : '';
}

export function telegramDisplayName(data: Record<string, unknown>): string {
  return normalizePlayerName([normalizePlayerName(data.first_name), normalizePlayerName(data.last_name)].filter(Boolean).join(' '))
    || normalizePlayerName(data.username);
}

/** Repair legacy display names before any stored room state is emitted. */
export function repairRoomNames(state: GameState): boolean {
  let changed = false;
  for (const [index, player] of [...state.players, ...state.spectators].entries()) {
    const fallback = index < state.players.length ? `Player ${index + 1}` : `Spectator ${index - state.players.length + 1}`;
    const name = normalizePlayerName(player.name) || fallback;
    if (player.name !== name) { player.name = name; changed = true; }
  }
  return changed;
}
