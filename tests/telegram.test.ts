import { describe, it, expect } from 'vitest';
import { parseUpdate, BOT_COMMANDS, escapeHtml } from '../src/telegram';

const update = (text: string, chatType = 'supergroup') => ({
  message: { chat: { id: -100123, type: chatType, title: 'Card Club' }, from: { id: 42, username: 'ana' }, text },
});

describe('parseUpdate', () => {
  it.each([
    ['/newgame', 'newbridge'], // original command keeps working
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
