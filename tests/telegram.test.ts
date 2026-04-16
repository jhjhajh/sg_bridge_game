import { describe, it, expect } from 'vitest';
import { parseUpdate } from '../src/telegram';

describe('parseUpdate', () => {
  it('parses a valid /newgame command', () => {
    const body = {
      message: {
        chat: { id: -100123, type: 'group', title: 'Test Group' },
        from: { id: 456, username: 'alice', first_name: 'Alice' },
        text: '/newgame'
      }
    };
    const result = parseUpdate(body);
    expect(result).toEqual({
      command: 'newgame',
      chatId: '-100123',
      groupName: 'Test Group',
      fromUserId: 456,
      fromUsername: 'alice'
    });
  });

  it('parses a valid /leaderboard command', () => {
    const body = {
      message: {
        chat: { id: -100123, type: 'supergroup', title: 'Test Supergroup' },
        from: { id: 456, username: 'bob' },
        text: '/leaderboard'
      }
    };
    const result = parseUpdate(body);
    expect(result).toEqual({
      command: 'leaderboard',
      chatId: '-100123',
      groupName: 'Test Supergroup',
      fromUserId: 456,
      fromUsername: 'bob'
    });
  });

  it('handles commands with bot mentions', () => {
    const body = {
      message: {
        chat: { id: -100123, type: 'group', title: 'Test Group' },
        from: { id: 456, username: 'alice' },
        text: '/newgame@MyBot'
      }
    };
    const result = parseUpdate(body);
    expect(result?.command).toBe('newgame');
  });

  it('handles commands with arguments and bot mentions', () => {
    const body = {
      message: {
        chat: { id: -100123, type: 'group', title: 'Test Group' },
        from: { id: 456, username: 'alice' },
        text: '/leaderboard@MyBot some args'
      }
    };
    const result = parseUpdate(body);
    expect(result?.command).toBe('leaderboard');
  });

  it('returns null if message is missing', () => {
    expect(parseUpdate({})).toBeNull();
  });

  it('returns null for non-group chats', () => {
    const body = {
      message: {
        chat: { id: 123, type: 'private' },
        from: { id: 456, username: 'alice' },
        text: '/newgame'
      }
    };
    expect(parseUpdate(body)).toBeNull();
  });

  it('returns null if text does not start with /', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 456, username: 'alice' },
        text: 'newgame'
      }
    };
    expect(parseUpdate(body)).toBeNull();
  });

  it('returns null for unsupported commands', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 456, username: 'alice' },
        text: '/help'
      }
    };
    expect(parseUpdate(body)).toBeNull();
  });

  it('returns null if from is missing', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        text: '/newgame'
      }
    };
    expect(parseUpdate(body)).toBeNull();
  });

  it('uses default group name if title is missing', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 456, username: 'alice' },
        text: '/newgame'
      }
    };
    const result = parseUpdate(body);
    expect(result?.groupName).toBe('Group');
  });

  it('falls back to first_name if username is missing', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 456, first_name: 'Alice' },
        text: '/newgame'
      }
    };
    const result = parseUpdate(body);
    expect(result?.fromUsername).toBe('Alice');
  });

  it('falls back to id string if both username and first_name are missing', () => {
    const body = {
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 456 },
        text: '/newgame'
      }
    };
    const result = parseUpdate(body);
    expect(result?.fromUsername).toBe('456');
  });
});
