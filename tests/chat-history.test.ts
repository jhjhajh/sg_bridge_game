import { describe, expect, it } from 'vitest';
import { appendRoomMessage, CHAT_HISTORY_KEY, readChatHistory } from '../src/chat-history';

function roomStorage() {
  const data = new Map<string, unknown>();
  let queue = Promise.resolve();
  const txn = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
  };
  const storage = { transaction: (callback: (tx: typeof txn) => Promise<unknown>) => {
    const result = queue.then(() => callback(txn));
    queue = result.then(() => undefined);
    return result;
  } } as unknown as DurableObjectStorage;
  return { storage, data };
}

describe('room chat retention', () => {
  it('creates an empty stable history, survives a new reader and retains only the latest fifty', async () => {
    const { storage } = roomStorage();
    const empty = await readChatHistory(storage, 'ROOM');
    expect(empty.messages).toEqual([]);
    for (let i = 1; i <= 75; i++) await appendRoomMessage(storage, 'ROOM', 'Alex', 0, `message-${i}`);
    const reloaded = await readChatHistory(storage, 'ROOM');
    expect(reloaded.epoch).toBe(empty.epoch);
    expect(reloaded.sequence).toBe(75);
    expect(reloaded.messages.map(entry => entry.text)).toEqual(Array.from({ length: 50 }, (_, i) => `message-${i + 26}`));
    expect(new Set(reloaded.messages.map(entry => entry.id)).size).toBe(50);
  });

  it('serializes simultaneous senders without losing messages or reusing ordering IDs', async () => {
    const { storage } = roomStorage();
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendRoomMessage(storage, 'ROOM', `Player${i}`, i % 4, `simultaneous-${i}`)));
    const history = await readChatHistory(storage, 'ROOM');
    expect(history.messages.map(entry => entry.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(history.messages.map(entry => entry.text)).size).toBe(20);
  });

  it('room cleanup/recreation resets the generation and never reuses an old message identity', async () => {
    const { storage, data } = roomStorage();
    const old = await appendRoomMessage(storage, 'SAME', 'Alex', 0, 'old room');
    data.clear(); // The existing GameRoom inactivity alarm calls storage.deleteAll().
    const fresh = await appendRoomMessage(storage, 'SAME', 'Blair', 1, 'new room');
    expect(fresh.history.epoch).not.toBe(old.history.epoch);
    expect(fresh.entry.id).not.toBe(old.entry.id);
    expect(fresh.history.messages.map(entry => entry.text)).toEqual(['new room']);
    expect(data.has(CHAT_HISTORY_KEY)).toBe(true);
  });

  it('never replays a record belonging to a different room', async () => {
    const { storage } = roomStorage();
    await appendRoomMessage(storage, 'FIRST', 'Alex', 0, 'private to first');
    const second = await readChatHistory(storage, 'SECOND');
    expect(second.roomCode).toBe('SECOND');
    expect(second.messages).toEqual([]);
    expect(second.sequence).toBe(0);
  });
});
