import { GAME_CATALOG, type GameCommand } from './games';

const TG_API = 'https://api.telegram.org';

/**
 * Post a plain-text message to a Telegram chat.
 * Fire-and-forget — errors are swallowed (notifications are non-critical).
 */
export async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    // swallow — never block game flow on a failed notification
  }
}

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Check if a Telegram user is a member of a chat.
 * Returns false on any error (fail-safe: unknown = non-member).
 */
export async function isChatMember(
  token: string,
  chatId: string,
  userId: number,
): Promise<boolean> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
    });
    if (!res.ok) return false;
    const data = await res.json<{ ok: boolean; result?: { status: string } }>();
    if (!data.ok || !data.result) return false;
    return ['member', 'administrator', 'creator'].includes(data.result.status);
  } catch {
    return false;
  }
}

/** Commands the bot handles, after aliases are resolved. */
export type CommandName = GameCommand | 'newgame' | 'leaderboard' | 'help';

/** What people can type (lowercase letters, digits, underscores — Telegram's rules). */
const ALIASES: Record<string, CommandName> = {
  newgame: 'newgame', // choose a game; direct game commands remain shortcuts
  newbridge: 'newbridge',
  newregicide: 'newregicide',
  newregicidegame: 'newregicide',
  leaderboard: 'leaderboard',
  help: 'help',
  start: 'help',
};

/**
 * The "/" menu Telegram shows in groups — registered from code, no BotFather step needed.
 * Individual game commands remain available as typed shortcuts.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'newgame', description: 'Choose a game to start with your group' },
  { command: 'leaderboard', description: "This group's Bridge and Regicide leaderboards" },
  { command: 'help', description: 'Fun Central games and commands' },
];

/** Sets the bot's command menu for group chats. Fire-and-forget like sendMessage. */
export async function setBotCommands(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS, scope: { type: 'all_group_chats' } }),
    });
    const body = await res.json<{ ok?: boolean }>().catch(() => null);
    return res.ok && body?.ok === true;
  } catch {
    return false;
  }
}

/** Sends a reusable game chooser without changing shared gameplay notifications. */
export async function sendGameMenu(token: string, chatId: string): Promise<void> {
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '🎪 <b>Fun Central</b>\nWhich game would you like to start?',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: GAME_CATALOG.map((game) => [{
        text: `${game.emoji} ${game.name} (${game.players})`,
        callback_data: `newgame:${game.id}`,
      }]) },
    }),
  });
  const body = await res.json<{ ok?: boolean }>().catch(() => null);
  if (!res.ok || body?.ok !== true) throw new Error('Telegram game menu could not be sent');
}

/** Always stop Telegram's button spinner, including unsupported/stale selections. */
export async function answerGameSelection(token: string, queryId: string, accepted: boolean): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: queryId,
        ...(accepted ? {} : { text: 'This game menu is no longer available. Send /newgame to choose a game.' }),
      }),
    });
  } catch {
    // An expired acknowledgement must not prevent a valid game from starting.
  }
}

export interface TelegramCommand {
  command: CommandName;
  chatId: string;
  groupName: string;
  fromUserId: number;
  fromUsername: string;
}

export interface GameSelection {
  callbackQueryId: string;
  command: TelegramCommand | null;
}

/** Only catalogued callback data in group messages may create a room. */
export function parseGameSelection(body: unknown): GameSelection | null {
  const callback = (body as { callback_query?: {
    id?: unknown; data?: unknown;
    message?: { chat?: { id?: unknown; type?: unknown; title?: unknown } };
    from?: { id?: unknown; username?: unknown; first_name?: unknown };
  } } | null)?.callback_query;
  if (!callback || typeof callback.id !== 'string' || !callback.id.trim()) return null;
  const selection: GameSelection = { callbackQueryId: callback.id, command: null };
  const game = GAME_CATALOG.find((entry) => callback.data === `newgame:${entry.id}`);
  const chat = callback.message?.chat;
  const from = callback.from;
  if (!game || !chat || !['group', 'supergroup'].includes(String(chat.type)) ||
      typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id) || chat.id === 0 ||
      typeof from?.id !== 'number' || !Number.isSafeInteger(from.id) || from.id <= 0) return selection;
  selection.command = {
    command: game.telegramCommand,
    chatId: String(chat.id),
    groupName: typeof chat.title === 'string' ? chat.title : 'Group',
    fromUserId: from.id,
    fromUsername: typeof from.username === 'string' && from.username
      ? from.username : typeof from.first_name === 'string' && from.first_name ? from.first_name : String(from.id),
  };
  return selection;
}

/**
 * Parse a Telegram Update payload.
 * Returns null for non-group messages, non-commands, or unsupported commands.
 */
export function parseUpdate(body: unknown): TelegramCommand | null {
  try {
    const update = body as {
      message?: {
        chat?: { id: number; type: string; title?: string };
        from?: { id: number; username?: string; first_name?: string };
        text?: string;
      };
    };
    const msg = update?.message;
    if (!msg) return null;

    const chat = msg.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type)) return null;

    const text = msg.text?.trim() ?? '';
    if (!text.startsWith('/')) return null;

    // Strip bot mention: /newgame@BotName → newgame
    const cmdRaw = text.split(/\s/)[0].split('@')[0].slice(1).toLowerCase();
    const command = Object.prototype.hasOwnProperty.call(ALIASES, cmdRaw) ? ALIASES[cmdRaw] : null;
    if (!command) return null;

    const from = msg.from;
    if (!from) return null;

    return {
      command,
      chatId: String(chat.id),
      groupName: chat.title ?? 'Group',
      fromUserId: from.id,
      fromUsername: from.username ?? from.first_name ?? String(from.id),
    };
  } catch {
    return null;
  }
}
