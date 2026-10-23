import type { Env } from './types';
import { verifyTelegramAuth, signJwt, verifyJwt } from './auth';
import { upsertUser, getUser, updateDisplayName, getLeaderboard, upsertGroup, getGroupLeaderboard } from './db';
import { sendMessage, parseUpdate, parseGameSelection, sendGameMenu, answerGameSelection, setBotCommands, escapeHtml, type TelegramCommand } from './telegram';
import { GAME_CATALOG } from './games';
import { getPlayerStats, getPairStats } from './stats-db';
import { placeBet, getUserBet, getBettingLeaderboard } from './betting-db';
import { listUserGames, getGameReplay } from './history';
import { normalizePlayerName, telegramDisplayName, UNNAMED_TELEGRAM_USER } from './player-name';
import { getRegicideLeaderboard, getRegicideStats, getRegicideGroupLeaderboard } from './regicide/db';

export { GameRoom } from './game-room';
export { RegicideRoom } from './regicide/room';

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

/** Creates a Regicide room (retrying on the rare code collision). Returns null if none could be allocated. */
async function createRegicideRoom(env: Env, extra: Record<string, unknown> = {}): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const roomCode = generateRoomCode();
    const res = await env.REGICIDE_ROOM.getByName(roomCode).fetch(
      new Request('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode, ...extra }) }),
    );
    if (res.ok) return roomCode;
  }
  return null;
}

const MEDALS = ['🥇', '🥈', '🥉'];
const HELP_TEXT = [
  '🎪 <b>Fun Central</b> — card games for this group',
  '',
  '/newgame — choose a game to start',
  ...GAME_CATALOG.map((game) => `/${game.telegramCommand} — start ${game.name} (${game.players})`),
  '/leaderboard — this group\'s Bridge and Regicide leaderboards',
  '/help — this message',
  '',
  'Sign in with Telegram on the game page so your results count for this group.',
].join('\n');

/** Handles one bot command from a group chat. */
async function handleTelegramCommand(cmd: TelegramCommand, env: Env, origin: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const who = `<b>@${escapeHtml(cmd.fromUsername)}</b>`;
  switch (cmd.command) {
    case 'newgame':
      await sendGameMenu(token, cmd.chatId);
      return;
    case 'newbridge': {
      await upsertGroup(env.DB, cmd.chatId, cmd.groupName);
      const roomCode = generateRoomCode();
      await env.GAME_ROOM.getByName(roomCode).fetch(
        new Request('https://internal/create', {
          method: 'POST',
          body: JSON.stringify({ roomCode, groupId: cmd.chatId, groupName: cmd.groupName, origin }),
        }),
      );
      await sendMessage(token, cmd.chatId, `🃏 ${who} started a new Bridge game!\nJoin → ${origin}/bridge/#${roomCode}\n\n<i>Fancy co-op instead? /newregicide</i>`);
      return;
    }
    case 'newregicide': {
      await upsertGroup(env.DB, cmd.chatId, cmd.groupName);
      const roomCode = await createRegicideRoom(env, { groupId: cmd.chatId, groupName: cmd.groupName, origin });
      await sendMessage(token, cmd.chatId, roomCode
        ? `♛ ${who} started a Regicide game — storm the castle together (1–4 players)!\nJoin → ${origin}/regicide/#${roomCode}`
        : '♛ Could not start a Regicide game right now — please try again.');
      return;
    }
    case 'leaderboard': {
      // A missing/broken Regicide table must never take the Bridge board down with it.
      const [bridge, regicide] = await Promise.all([
        getGroupLeaderboard(env.DB, cmd.chatId),
        getRegicideGroupLeaderboard(env.DB, cmd.chatId).catch((err) => { console.error('Regicide group board unavailable', err); return []; }),
      ]);
      if (bridge.top.length === 0 && regicide.length === 0) {
        await sendMessage(token, cmd.chatId, '🏆 No games played in this group yet! Try /newbridge or /newregicide.');
        return;
      }
      const rank = (i: number) => MEDALS[i] ?? `${i + 1}.`;
      const bridgeRows = bridge.top.length
        ? bridge.top.map((e) => `${MEDALS[e.rank - 1] ?? `${e.rank}.`} ${escapeHtml(e.displayName)} — ELO ${e.elo} (${e.wins}W / ${e.gamesPlayed}G)`).join('\n')
        : '<i>No games yet — /newbridge</i>';
      const regicideRows = regicide.length
        ? regicide.map((e, i) => `${rank(i)} ${escapeHtml(e.displayName)} — ${e.rating} (best ${e.bestDefeated}/12, ${e.gamesPlayed}G)`).join('\n')
        : '<i>No games yet — /newregicide</i>';
      await sendMessage(token, cmd.chatId, `🏆 <b>Group Leaderboard</b>\n\n🃏 <b>Bridge</b>\n${bridgeRows}\n\n♛ <b>Regicide</b>\n${regicideRows}`);
      return;
    }
    case 'help':
      await sendMessage(token, cmd.chatId, HELP_TEXT);
      return;
  }
  const unsupported: never = cmd.command;
  throw new Error(`Unimplemented game command: ${unsupported}`);
}

/** The "/" command menu is registered from code once per Worker instance (no BotFather step). */
let botCommandsRegistered = false;

async function getAuthClaims(
  request: Request,
  secret: string,
): Promise<{ sub: string; name: string; exp: number } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJwt(auth.slice(7), secret);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public bot username for the Telegram Login Widget
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return Response.json({ botUsername: env.TELEGRAM_BOT_USERNAME });
    }

    // DEV ONLY: mint a JWT for a fake user without Telegram verification.
    // Gated by ALLOW_DEV_LOGIN env flag (set in .dev.vars for local dev).
    if (url.pathname === '/api/auth/dev' && request.method === 'POST' && env.ALLOW_DEV_LOGIN === '1') {
      const body = await request.json<{ displayName?: string }>().catch(() => ({} as { displayName?: string }));
      const displayName = (body.displayName ?? '').trim() || 'Dev User';
      // Deterministic fake telegram_id derived from name, so repeat logins hit the same row.
      let hash = 0;
      for (let i = 0; i < displayName.length; i++) hash = ((hash << 5) - hash + displayName.charCodeAt(i)) | 0;
      const telegramId = 900_000_000 + Math.abs(hash) % 90_000_000;
      await upsertUser(env.DB, telegramId, displayName);
      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
      const token = await signJwt({ sub: String(telegramId), name: displayName, exp }, env.JWT_SECRET);
      return Response.json({ token, displayName, telegramId, nameRequired: false });
    }

    // Telegram Login Widget callback → verify, upsert user, return JWT
    if (url.pathname === '/api/auth/telegram' && request.method === 'POST') {
      const body = await request.json<Record<string, string | number>>().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid Telegram auth' }, { status: 400 });
      const valid = await verifyTelegramAuth(body, env.TELEGRAM_BOT_TOKEN);
      if (!valid) return Response.json({ error: 'Invalid Telegram auth' }, { status: 401 });

      const telegramId = Number(body.id);
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return Response.json({ error: 'Invalid Telegram identity' }, { status: 400 });
      const telegramName = telegramDisplayName(body);
      const displayName = telegramName || UNNAMED_TELEGRAM_USER;

      await upsertUser(env.DB, telegramId, displayName);

      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
      const token = await signJwt({ sub: String(telegramId), name: displayName, exp }, env.JWT_SECRET);
      return Response.json({ token, displayName, telegramId, nameRequired: !telegramName });
    }

    // Get authenticated user's profile
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const user = await getUser(env.DB, Number(claims.sub));
      if (!user) return Response.json({ error: 'Not found' }, { status: 404 });
      const displayName = normalizePlayerName(user.display_name) || normalizePlayerName(claims.name);
      if (displayName && displayName !== user.display_name) await updateDisplayName(env.DB, user.telegram_id, displayName);
      return Response.json({ telegramId: user.telegram_id, displayName, nameRequired: !displayName || displayName === UNNAMED_TELEGRAM_USER });
    }

    // Update authenticated user's display name
    if (url.pathname === '/api/me' && request.method === 'PATCH') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const body = await request.json<{ displayName?: unknown }>().catch(() => null);
      const name = normalizePlayerName(body?.displayName);
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
          `🃏 <b>${fromName}</b> started a new game!\nJoin → ${origin}/bridge/#${roomCode}`,
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

    // --- Regicide (co-op, 1–4 players) ---
    if (url.pathname === '/api/regicide/create' && request.method === 'POST') {
      // A fixed shuffle seed is a dev/test-only convenience.
      const body = await request.json<{ seed?: unknown }>().catch(() => ({} as { seed?: unknown }));
      const seed = env.ALLOW_DEV_LOGIN === '1' && Number.isInteger(body.seed) ? body.seed : undefined;
      const roomCode = await createRegicideRoom(env, { seed });
      return roomCode ? Response.json({ roomCode }) : Response.json({ error: 'Could not allocate a room' }, { status: 503 });
    }

    if (url.pathname === '/api/regicide/ws') {
      const roomCode = url.searchParams.get('room')?.toUpperCase();
      if (!roomCode || !/^[A-Z0-9]{4}$/.test(roomCode)) return new Response('Missing room code', { status: 400 });
      // Only a verified JWT yields a tg_ id (which the room requires to take a seat and be rated).
      // Anyone else connects as a guest and can only watch.
      const forward = new URL(request.url);
      const token = forward.searchParams.get('token');
      const claims = token ? await verifyJwt(token, env.JWT_SECRET) : null;
      forward.searchParams.delete('token');
      forward.searchParams.delete('name');
      if (claims) {
        forward.searchParams.set('playerId', `tg_${claims.sub}`);
        const user = await getUser(env.DB, Number(claims.sub)).catch(() => null);
        const name = normalizePlayerName(user?.display_name) || normalizePlayerName(claims.name);
        if (name) forward.searchParams.set('name', name);
      } else {
        const guest = (forward.searchParams.get('playerId') ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
        forward.searchParams.set('playerId', `guest_${guest || crypto.randomUUID()}`);
      }
      return env.REGICIDE_ROOM.getByName(roomCode).fetch(new Request(forward.toString(), request));
    }

    if (url.pathname === '/api/regicide/leaderboard' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET).catch(() => null);
      // Empty (not an error) if the Regicide tables haven't been created yet.
      return Response.json(await getRegicideLeaderboard(env.DB, claims ? Number(claims.sub) : undefined).catch(() => ({ top: [], me: null })));
    }

    if (url.pathname === '/api/regicide/stats' && request.method === 'GET') {
      return Response.json(await getRegicideStats(env.DB).catch(() => []));
    }

    // DEV ONLY: patch a live Regicide game to set up an exact scenario in tests.
    if (url.pathname === '/api/regicide/debug/patch' && request.method === 'POST' && env.ALLOW_DEV_LOGIN === '1') {
      const room = url.searchParams.get('room')?.toUpperCase();
      if (!room) return new Response('Missing room', { status: 400 });
      return env.REGICIDE_ROOM.getByName(room).fetch(new Request('https://internal/debug/patch', { method: 'POST', body: await request.text() }));
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
      // Always respond 200 — Telegram retries on non-200
      const body = await request.json().catch(() => null);
      const selection = parseGameSelection(body);
      const cmd = selection ? selection.command : parseUpdate(body);
      if (!cmd && !selection) return new Response(null, { status: 200 });
      if (!botCommandsRegistered) {
        botCommandsRegistered = true;
        ctx.waitUntil(setBotCommands(env.TELEGRAM_BOT_TOKEN).then((registered) => {
          botCommandsRegistered = registered; // retry on a later update if Telegram rejected the menu
        }));
      }
      if (selection) await answerGameSelection(env.TELEGRAM_BOT_TOKEN, selection.callbackQueryId, !!cmd);
      if (cmd) await handleTelegramCommand(cmd, env, new URL(request.url).origin).catch((err) => console.error('Telegram command failed', err));
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
      // Accept comma-separated telegram IDs (e.g. ?players=123,456,789)
      const playersParam = url.searchParams.get('players') ?? claims.sub;
      const telegramIds = playersParam.split(',').map(Number).filter((n) => n > 0);
      if (telegramIds.length === 0 || telegramIds.length > 8) return Response.json({});
      // Start of today in SGT (UTC+8)
      const SGT_OFFSET = 8 * 3600;
      const nowUnix = Math.floor(Date.now() / 1000);
      const startOfDay = nowUnix - ((nowUnix + SGT_OFFSET) % 86400);
      const placeholders = telegramIds.map(() => '?').join(',');
      const rows = await env.DB
        .prepare(
          `SELECT gr.telegram_id, COALESCE(SUM(gm.played_at - gh.start_time), 0) AS total_seconds
           FROM (
             SELECT DISTINCT game_id, telegram_id
             FROM game_records WHERE telegram_id IN (${placeholders})
           ) gr
           JOIN game_metadata gm ON gm.game_id = gr.game_id AND gm.played_at >= ?
           JOIN (
             SELECT game_id, MIN(played_at) AS start_time
             FROM game_hands WHERE played_at >= ?
             GROUP BY game_id
           ) gh ON gh.game_id = gr.game_id
           GROUP BY gr.telegram_id`,
        )
        .bind(...telegramIds, startOfDay, startOfDay)
        .all<{ telegram_id: number; total_seconds: number }>();
      const result: Record<string, number> = {};
      for (const r of rows.results ?? []) {
        result[String(r.telegram_id)] = r.total_seconds;
      }
      return Response.json(result);
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

    // --- Game history / replay endpoints ---

    // GET /api/games/mine?limit=20&before=<unix_ts>  (auth required)
    if (url.pathname === '/api/games/mine' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const limitRaw = Number(url.searchParams.get('limit') ?? '20');
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100);
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null;
      const games = await listUserGames(env.DB, Number(claims.sub), limit, before);
      return Response.json(games);
    }

    // GET /api/games/:gameId  (auth required; caller must have participated)
    {
      const match = url.pathname.match(/^\/api\/games\/([^/]+)$/);
      if (match && request.method === 'GET') {
        const claims = await getAuthClaims(request, env.JWT_SECRET);
        if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const gameId = decodeURIComponent(match[1]);
        const replay = await getGameReplay(env.DB, gameId, Number(claims.sub));
        if (!replay) return Response.json({ error: 'Not found' }, { status: 404 });
        return Response.json(replay);
      }
    }

    // --- Betting endpoints ---

    // GET /api/betting/leaderboard
    if (url.pathname === '/api/betting/leaderboard' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET).catch(() => null);
      const telegramId = claims ? Number(claims.sub) : undefined;
      const data = await getBettingLeaderboard(env.DB, telegramId);
      return Response.json(data);
    }

    // GET /api/betting/my-bet?room=XXXX
    if (url.pathname === '/api/betting/my-bet' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });

      const room = url.searchParams.get('room');
      if (!room) return Response.json({ error: 'Missing room' }, { status: 400 });

      const stub = env.GAME_ROOM.getByName(room.toUpperCase());
      const phaseRes = await stub.fetch(new Request('https://internal/phase'));
      const { gameId } = await phaseRes.json<{ phase: string | null; gameId: string | null }>();

      if (!gameId) return Response.json({ bet: null });

      const bet = await getUserBet(env.DB, gameId, `tg_${claims.sub}`);
      return Response.json({ bet });
    }

    // POST /api/betting/place
    if (url.pathname === '/api/betting/place' && request.method === 'POST') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Login required to bet' }, { status: 401 });

      const body = await request.json<{ room: string; prediction: string; watchedSeat: number }>().catch(() => null);
      if (!body?.room || !body.prediction) {
        return Response.json({ error: 'Missing room or prediction' }, { status: 400 });
      }
      if (body.prediction !== 'win' && body.prediction !== 'lose') {
        return Response.json({ error: 'prediction must be "win" or "lose"' }, { status: 400 });
      }

      const room = body.room.toUpperCase();
      const stub = env.GAME_ROOM.getByName(room);
      const phaseRes = await stub.fetch(new Request('https://internal/phase'));
      const { phase, gameId } = await phaseRes.json<{ phase: string | null; gameId: string | null }>();

      if (phase !== 'bidding') {
        return Response.json({ error: 'Bets can only be placed during the bidding phase' }, { status: 409 });
      }
      if (!gameId) {
        return Response.json({ error: 'Game not found' }, { status: 404 });
      }

      const displayName = claims.name ?? `tg_${claims.sub}`;
      const result = await placeBet(
        env.DB,
        gameId,
        `tg_${claims.sub}`,
        displayName,
        body.watchedSeat ?? -1,
        body.prediction as 'win' | 'lose',
      );

      if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
      return Response.json({ ok: true, gameId });
    }

    return new Response(null, { status: 404 });
  },
};
