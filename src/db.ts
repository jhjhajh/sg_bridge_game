import type { D1Database } from '@cloudflare/workers-types';
import type { Player } from './types';

export interface UserRow {
  telegram_id: number;
  display_name: string;
  created_at: number;
  wins: number;
  games_played: number;
  elo: number;
}

/**
 * Insert or update a user record. Updates display_name on conflict.
 */
export async function upsertUser(
  db: D1Database,
  telegramId: number,
  displayName: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, display_name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET display_name = excluded.display_name`,
    )
    .bind(telegramId, displayName, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Fetch a user by Telegram ID. Returns null if not found.
 */
export async function getUser(db: D1Database, telegramId: number): Promise<UserRow | null> {
  const row = await db
    .prepare('SELECT telegram_id, display_name, created_at, wins, games_played, elo FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Update the display name for an existing user.
 */
export async function updateDisplayName(
  db: D1Database,
  telegramId: number,
  displayName: string,
): Promise<void> {
  await db
    .prepare('UPDATE users SET display_name = ? WHERE telegram_id = ?')
    .bind(displayName, telegramId)
    .run();
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  elo: number;
  wins: number;
  gamesPlayed: number;
}

/**
 * Returns top 5 players by ELO (min 1 game played) + optionally the caller's rank.
 * If telegramId is provided and not in top 5, their rank is returned separately.
 */
export async function getLeaderboard(
  db: D1Database,
  telegramId?: number,
): Promise<{ top: LeaderboardEntry[]; me: (LeaderboardEntry & { telegramId: number }) | null }> {
  const topRows = await db
    .prepare(
      `SELECT display_name, elo, wins, games_played,
              RANK() OVER (ORDER BY elo DESC) AS rank
       FROM users
       WHERE games_played > 0
       ORDER BY elo DESC
       LIMIT 5`,
    )
    .all<{ display_name: string; elo: number; wins: number; games_played: number; rank: number }>();

  const top: LeaderboardEntry[] = (topRows.results ?? []).map((r) => ({
    rank: r.rank,
    displayName: r.display_name,
    elo: r.elo,
    wins: r.wins,
    gamesPlayed: r.games_played,
  }));

  if (!telegramId) return { top, me: null };

  // Get caller's stats
  const meRow = await db
    .prepare(
      `SELECT display_name, elo, wins, games_played,
              (SELECT COUNT(*) + 1 FROM users WHERE games_played > 0 AND elo > u.elo) AS rank
       FROM users u
       WHERE telegram_id = ?`,
    )
    .bind(telegramId)
    .first<{ display_name: string; elo: number; wins: number; games_played: number; rank: number }>();

  if (!meRow || meRow.games_played === 0) return { top, me: null };

  if (meRow.rank <= 5) return { top, me: null };

  return {
    top,
    me: {
      rank: meRow.rank,
      displayName: meRow.display_name,
      elo: meRow.elo,
      wins: meRow.wins,
      gamesPlayed: meRow.games_played,
      telegramId,
    },
  };
}

/**
 * Insert or replace a group record.
 */
export async function upsertGroup(
  db: D1Database,
  groupId: string,
  groupName: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO groups (group_id, group_name, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET group_name = excluded.group_name',
    )
    .bind(groupId, groupName, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Update group_stats for verified group members after a game ends.
 * Skips guests (non-tg_ IDs) and non-members (isGroupMember !== true).
 */
export async function recordGroupResult(
  db: D1Database,
  groupId: string,
  players: Player[],
  winnerSeats: number[],
): Promise<void> {
  await Promise.all(
    players.map((player) => {
      if (!player.id.startsWith('tg_')) return Promise.resolve();
      if (!player.isGroupMember) return Promise.resolve();
      const telegramId = Number(player.id.slice(3));
      const won = winnerSeats.includes(player.seat) ? 1 : 0;
      return db
        .prepare(
          `INSERT INTO group_stats (group_id, telegram_id, wins, games_played)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(group_id, telegram_id) DO UPDATE SET
             games_played = games_played + 1,
             wins = wins + ?`,
        )
        .bind(groupId, telegramId, won, won)
        .run();
    }),
  );
}

export interface GroupLeaderboardEntry {
  rank: number;
  displayName: string;
  elo: number;
  wins: number;
  gamesPlayed: number;
}

/**
 * Returns top 5 players by ELO in this group + optionally the caller's rank.
 */
export async function getGroupLeaderboard(
  db: D1Database,
  groupId: string,
  telegramId?: number,
): Promise<{ top: GroupLeaderboardEntry[]; me: (GroupLeaderboardEntry & { telegramId: number }) | null }> {
  const topRows = await db
    .prepare(
      `SELECT u.display_name, u.elo, gs.wins, gs.games_played,
              RANK() OVER (ORDER BY u.elo DESC) AS rank
       FROM group_stats gs
       JOIN users u ON u.telegram_id = gs.telegram_id
       WHERE gs.group_id = ? AND gs.games_played > 0
       ORDER BY u.elo DESC
       LIMIT 5`,
    )
    .bind(groupId)
    .all<{ display_name: string; elo: number; wins: number; games_played: number; rank: number }>();

  const top: GroupLeaderboardEntry[] = (topRows.results ?? []).map((r) => ({
    rank: r.rank,
    displayName: r.display_name,
    elo: r.elo,
    wins: r.wins,
    gamesPlayed: r.games_played,
  }));

  if (!telegramId) return { top, me: null };

  const meRow = await db
    .prepare(
      `SELECT u.display_name, u.elo, gs.wins, gs.games_played,
              (SELECT COUNT(*) + 1
               FROM group_stats gs2
               JOIN users u2 ON u2.telegram_id = gs2.telegram_id
               WHERE gs2.group_id = ? AND gs2.games_played > 0 AND u2.elo > u.elo) AS rank
       FROM group_stats gs
       JOIN users u ON u.telegram_id = gs.telegram_id
       WHERE gs.group_id = ? AND gs.telegram_id = ?`,
    )
    .bind(groupId, groupId, telegramId)
    .first<{ display_name: string; elo: number; wins: number; games_played: number; rank: number }>();

  if (!meRow || meRow.games_played === 0) return { top, me: null };
  if (meRow.rank <= 5) return { top, me: null };

  return {
    top,
    me: {
      rank: meRow.rank,
      displayName: meRow.display_name,
      elo: meRow.elo,
      wins: meRow.wins,
      gamesPlayed: meRow.games_played,
      telegramId,
    },
  };
}
