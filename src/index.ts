import type { Env } from './types';
import { verifyTelegramAuth, signJwt, verifyJwt } from './auth';
import { upsertUser, getUser, updateDisplayName, getLeaderboard, upsertGroup, getGroupLeaderboard } from './db';
import { sendMessage, parseUpdate } from './telegram';
import { getPlayerStats, getPairStats } from './stats-db';

export { GameRoom } from './game-room';

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function getAuthClaims(
  request: Request,
  secret: string,
): Promise<{ sub: string; name: string; exp: number } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJwt(auth.slice(7), secret);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public bot username for the Telegram Login Widget
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return Response.json({ botUsername: env.TELEGRAM_BOT_USERNAME });
    }

    // Telegram Login Widget callback → verify, upsert user, return JWT
    if (url.pathname === '/api/auth/telegram' && request.method === 'POST') {
      const body = await request.json<Record<string, string | number>>();
      const valid = await verifyTelegramAuth(body, env.TELEGRAM_BOT_TOKEN);
      if (!valid) return Response.json({ error: 'Invalid Telegram auth' }, { status: 401 });

      const telegramId = Number(body.id);
      const firstName = String(body.first_name ?? '');
      const lastName = body.last_name ? ` ${body.last_name}` : '';
      const displayName = (firstName + lastName).trim() || String(body.username ?? telegramId);

      await upsertUser(env.DB, telegramId, displayName);

      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
      const token = await signJwt({ sub: String(telegramId), name: displayName, exp }, env.JWT_SECRET);
      return Response.json({ token, displayName });
    }

    // Get authenticated user's profile
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const user = await getUser(env.DB, Number(claims.sub));
      if (!user) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ telegramId: user.telegram_id, displayName: user.display_name });
    }

    // Update authenticated user's display name
    if (url.pathname === '/api/me' && request.method === 'PATCH') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const body = await request.json<{ displayName?: string }>();
      const name = body.displayName?.trim();
      if (!name) return Response.json({ error: 'displayName required' }, { status: 400 });
      await updateDisplayName(env.DB, Number(claims.sub), name);
      return new Response(null, { status: 204 });
    }

    // Get leaderboard (optionally with authenticated user's rank)
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET).catch(() => null);
      const telegramId = claims ? Number(claims.sub) : undefined;
      const groupId = url.searchParams.get('groupId');

      if (groupId) {
        const data = await getGroupLeaderboard(env.DB, groupId, telegramId);
        return Response.json(data);
      }

      const data = await getLeaderboard(env.DB, telegramId);
      return Response.json(data);
    }

    if (url.pathname === '/api/create' && request.method === 'POST') {
      const body = await request.json<{ groupId?: string | null; groupName?: string | null; sendInvite?: boolean; fromName?: string }>().catch(() => ({} as { groupId?: string | null; groupName?: string | null; sendInvite?: boolean; fromName?: string }));
      const roomCode = generateRoomCode();
      const stub = env.GAME_ROOM.getByName(roomCode);
      const origin = new URL(request.url).origin;
      await stub.fetch(
        new Request('https://internal/create', {
          method: 'POST',
          body: JSON.stringify({ roomCode, groupId: body.groupId ?? null, groupName: body.groupName ?? null, origin }),
        }),
      );
      if (body.sendInvite && body.groupId) {
        const fromName = body.fromName ?? 'Someone';
        sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          body.groupId,
          `🃏 <b>${fromName}</b> started a new game!\nJoin → ${origin}/#${roomCode}`,
        ).catch(() => {});
      }
      return Response.json({ roomCode });
    }

    if (url.pathname === '/api/send-group-invite' && request.method === 'POST') {
      const body = await request.json<{ room: string }>().catch(() => null);
      if (!body?.room) return new Response('Missing room', { status: 400 });
      const stub = env.GAME_ROOM.getByName(body.room.toUpperCase());
      const origin = new URL(request.url).origin;
      await stub.fetch(
        new Request('https://internal/send-group-invite', {
          method: 'POST',
          body: JSON.stringify({ origin }),
        }),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/ws') {
      const roomCode = url.searchParams.get('room');
      if (!roomCode) return new Response('Missing room code', { status: 400 });

      // If a JWT token is present and valid, override playerId with the stable tg_ id
      const token = url.searchParams.get('token');
      let forwardRequest = request;
      if (token) {
        const claims = await verifyJwt(token, env.JWT_SECRET);
        if (claims) {
          const newUrl = new URL(request.url);
          newUrl.searchParams.set('playerId', `tg_${claims.sub}`);
          newUrl.searchParams.delete('token'); // don't forward the token to the DO
          forwardRequest = new Request(newUrl.toString(), request);
        }
      }

      const stub = env.GAME_ROOM.getByName(roomCode);
      return stub.fetch(forwardRequest);
    }

    if (url.pathname === '/api/telegram' && request.method === 'POST') {
      // Always respond 200 immediately — Telegram retries on non-200
      const body = await request.json().catch(() => null);
      const origin = new URL(request.url).origin;

      const cmd = parseUpdate(body);
      if (!cmd) return new Response(null, { status: 200 });

      if (cmd.command === 'newgame') {
        await upsertGroup(env.DB, cmd.chatId, cmd.groupName);
        const roomCode = generateRoomCode();
        const stub = env.GAME_ROOM.getByName(roomCode);
        await stub.fetch(
          new Request('https://internal/create', {
            method: 'POST',
            body: JSON.stringify({ roomCode, groupId: cmd.chatId, groupName: cmd.groupName, origin }),
          }),
        );
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          cmd.chatId,
          `🃏 <b>@${cmd.fromUsername}</b> started a new game!\nJoin → ${origin}/#${roomCode}`,
        );
      }

      if (cmd.command === 'leaderboard') {
        const data = await getGroupLeaderboard(env.DB, cmd.chatId);
        if (data.top.length === 0) {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            cmd.chatId,
            '🏆 No games played in this group yet!',
          );
        } else {
          const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
          const rows = data.top
            .map((e) => `${medals[e.rank - 1] ?? `${e.rank}.`} ${e.displayName} — ELO ${e.elo} (${e.wins}W / ${e.gamesPlayed}G)`)
            .join('\n');
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            cmd.chatId,
            `🏆 <b>Group Leaderboard</b>\n${rows}`,
          );
        }
      }

      return new Response(null, { status: 200 });
    }

    if (url.pathname === '/api/elo-deltas' && request.method === 'GET') {
      const gameId = url.searchParams.get('gameId');
      if (!gameId) return Response.json([], { status: 200 });
      const rows = await env.DB
        .prepare(
          `SELECT u.display_name, eh.delta, eh.elo_before, eh.elo_after
           FROM elo_history eh
           JOIN users u ON u.telegram_id = eh.telegram_id
           WHERE eh.game_id = ?`,
        )
        .bind(gameId)
        .all<{ display_name: string; delta: number; elo_before: number; elo_after: number }>();
      const result = (rows.results ?? []).map((r) => ({
        name: r.display_name,
        delta: r.delta,
        eloBefore: r.elo_before,
        eloAfter: r.elo_after,
      }));
      return Response.json(result);
    }

    if (url.pathname === '/api/play-time-today' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const telegramId = Number(claims.sub);
      // Start of today in SGT (UTC+8)
      const SGT_OFFSET = 8 * 3600;
      const nowUnix = Math.floor(Date.now() / 1000);
      const startOfDay = nowUnix - ((nowUnix + SGT_OFFSET) % 86400);
      const row = await env.DB
        .prepare(
          `SELECT COALESCE(SUM(gm.played_at - gh.start_time), 0) AS total_seconds
           FROM (
             SELECT DISTINCT game_id FROM game_records WHERE telegram_id = ?
           ) gr
           JOIN game_metadata gm ON gm.game_id = gr.game_id AND gm.played_at >= ?
           JOIN (
             SELECT game_id, MIN(played_at) AS start_time
             FROM game_hands WHERE played_at >= ?
             GROUP BY game_id
           ) gh ON gh.game_id = gr.game_id`,
        )
        .bind(telegramId, startOfDay, startOfDay)
        .first<{ total_seconds: number }>();
      return Response.json({ totalSeconds: row?.total_seconds ?? 0 });
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      const groupId = url.searchParams.get('groupId') ?? undefined;
      const data = await getPlayerStats(env.DB, groupId);
      return Response.json(data);
    }

    if (url.pathname === '/api/stats/pairs' && request.method === 'GET') {
      const groupId = url.searchParams.get('groupId') ?? undefined;
      const data = await getPairStats(env.DB, groupId);
      return Response.json(data);
    }

    if (url.pathname === '/api/groups' && request.method === 'GET') {
      const rows = await env.DB
        .prepare('SELECT group_id, group_name FROM groups ORDER BY group_name ASC')
        .all<{ group_id: string; group_name: string }>();
      const groups = (rows.results ?? []).map((r) => ({
        groupId: r.group_id,
        groupName: r.group_name,
      }));
      return Response.json(groups);
    }

    return new Response(null, { status: 404 });
  },
};
