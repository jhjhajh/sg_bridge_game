// src/telegram.ts
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
export type CommandName = 'newbridge' | 'newregicide' | 'leaderboard' | 'help';

/** What people can type (lowercase letters, digits, underscores — Telegram's rules). */
const ALIASES: Record<string, CommandName> = {
  newgame: 'newbridge', // the original command, kept for existing groups
  newbridge: 'newbridge',
  newregicide: 'newregicide',
  newregicidegame: 'newregicide',
  leaderboard: 'leaderboard',
  help: 'help',
  start: 'help',
};

/**
 * The "/" menu Telegram shows in groups — registered from code, no BotFather step needed.
 * Kept to three; /help and the aliases still work when typed.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'newbridge', description: 'Start a Floating Bridge game (4 players)' },
  { command: 'newregicide', description: 'Start a Regicide game (co-op, 1–4 players)' },
  { command: 'leaderboard', description: "This group's Bridge and Regicide leaderboards" },
];

/** Sets the bot's command menu for group chats. Fire-and-forget like sendMessage. */
export async function setBotCommands(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS, scope: { type: 'all_group_chats' } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TelegramCommand {
  command: CommandName;
  chatId: string;
  groupName: string;
  fromUserId: number;
  fromUsername: string;
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
