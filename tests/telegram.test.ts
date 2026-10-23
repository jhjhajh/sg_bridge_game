import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseUpdate, parseGameSelection, sendGameMenu, answerGameSelection, setBotCommands, BOT_COMMANDS, escapeHtml } from '../src/telegram';
import { GAME_CATALOG } from '../src/games';

const update = (text: string, chatType = 'supergroup') => ({
  message: { chat: { id: -100123, type: chatType, title: 'Card Club' }, from: { id: 42, username: 'ana' }, text },
});

describe('parseUpdate', () => {
  it.each([
    ['/newgame', 'newgame'], // the original entry point now opens the game chooser
    ['/newgame@funCentral_bot', 'newgame'],
    ['/newbridge', 'newbridge'],
    ['/newregicide', 'newregicide'],
    ['/newregicidegame', 'newregicide'],
    ['/leaderboard', 'leaderboard'],
    ['/help', 'help'],
    ['/start', 'help'],
    ['/NewRegicide@funCentral_bot', 'newregicide'],
    ['/leaderboard now please', 'leaderboard'],
  ])('%s → %s', (text, command) => {
    expect(parseUpdate(update(text))).toMatchObject({ command, chatId: '-100123', groupName: 'Card Club', fromUserId: 42, fromUsername: 'ana' });
  });

  it('ignores private chats, plain text, unknown commands and prototype keys', () => {
    expect(parseUpdate(update('/newregicide', 'private'))).toBeNull();
    expect(parseUpdate(update('newregicide'))).toBeNull();
    expect(parseUpdate(update('/poker'))).toBeNull();
    expect(parseUpdate(update('/constructor'))).toBeNull();
    expect(parseUpdate({})).toBeNull();
  });

  it('menu commands follow Telegram naming rules and are all understood', () => {
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(parseUpdate(update(`/${command}`))).not.toBeNull();
    }
  });

  it('escapes names for HTML messages', () => {
    expect(escapeHtml('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
  });
});

const selection = (data: unknown, chatType = 'supergroup') => ({
  callback_query: {
    id: 'query-123', data,
    from: { id: 81, username: 'chooser' },
    message: { message_id: 9, chat: { id: -100123, type: chatType, title: 'Card Club' } },
  },
});

describe('Telegram game selection', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(GAME_CATALOG)('routes the $id button using the clicker and original chat', (game) => {
    expect(parseGameSelection(selection(`newgame:${game.id}`))).toEqual({
      callbackQueryId: 'query-123',
      command: { command: game.telegramCommand, chatId: '-100123', groupName: 'Card Club', fromUserId: 81, fromUsername: 'chooser' },
    });
  });

  it.each(['newgame:unknown', 'newgame:constructor', 'newgame:__proto__', '/newbridge', null, 10])('acknowledges but never routes invalid data %s', (data) => {
    expect(parseGameSelection(selection(data))).toEqual({ callbackQueryId: 'query-123', command: null });
  });

  it('does not create rooms for private, inaccessible-context, or malformed selections', () => {
    expect(parseGameSelection(selection('newgame:bridge', 'private'))?.command).toBeNull();
    expect(parseGameSelection({ callback_query: { id: 'q', data: 'newgame:bridge' } })?.command).toBeNull();
    const malformed = selection('newgame:bridge');
    (malformed.callback_query.from as any).id = '81';
    expect(parseGameSelection(malformed)?.command).toBeNull();
    expect(parseGameSelection({ callback_query: { id: 9 } })).toBeNull();
    expect(parseGameSelection(null)).toBeNull();
  });

  it('sends one callback button per catalogued game within Telegram payload limits', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
    await sendGameMenu('test-only', '-100123');
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string);
    expect(body.chat_id).toBe('-100123');
    expect(body.text).toContain('Fun Central');
    expect(body.reply_markup.inline_keyboard).toEqual(GAME_CATALOG.map((game) => [{
      text: `${game.emoji} ${game.name} (${game.players})`, callback_data: `newgame:${game.id}`,
    }]));
    expect(new Set(GAME_CATALOG.map((game) => game.id)).size).toBe(GAME_CATALOG.length);
    for (const game of GAME_CATALOG) {
      expect(new TextEncoder().encode(`newgame:${game.id}`).length).toBeLessThanOrEqual(64);
      expect(game.path).toMatch(/^\/[a-z]+\/$/);
    }
  });

  it('detects Bot API failure even when Telegram returns HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"ok":false}'));
    expect(await setBotCommands('test-only')).toBe(false);
    await expect(sendGameMenu('test-only', '-100123')).rejects.toThrow('could not be sent');
  });

  it('stops the button spinner and tolerates an expired acknowledgement', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
    await answerGameSelection('test-only', 'query-123', false);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      callback_query_id: 'query-123', text: 'This game menu is no longer available. Send /newgame to choose a game.',
    });
    fetch.mockRejectedValue(new Error('unavailable'));
    await expect(answerGameSelection('test-only', 'query-123', true)).resolves.toBeUndefined();
  });
});
