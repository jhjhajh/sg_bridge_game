// Room-local Durable Object storage, removed by the room's existing idle cleanup.
// Keeping this separate from gameplay state avoids stale game writes losing chat.
export const CHAT_HISTORY_KEY = 'chatHistory';
export const CHAT_HISTORY_LIMIT = 50;

export interface ChatEntry {
  id: string;
  sequence: number;
  name: string;
  seat: number;
  text: string;
}

export interface ChatHistory {
  roomCode: string;
  epoch: string;
  sequence: number;
  messages: ChatEntry[];
}

export function createChatHistory(roomCode: string): ChatHistory {
  return { roomCode, epoch: crypto.randomUUID(), sequence: 0, messages: [] };
}

export async function readChatHistory(storage: DurableObjectStorage, roomCode: string): Promise<ChatHistory> {
  return storage.transaction(async txn => {
    const current = await txn.get<ChatHistory>(CHAT_HISTORY_KEY);
    if (current?.roomCode === roomCode) return current;
    const history = createChatHistory(roomCode);
    await txn.put(CHAT_HISTORY_KEY, history);
    return history;
  });
}

export async function appendRoomMessage(storage: DurableObjectStorage, roomCode: string,
  name: string, seat: number, text: string): Promise<{ history: ChatHistory; entry: ChatEntry }> {
  return storage.transaction(async txn => {
    const stored = await txn.get<ChatHistory>(CHAT_HISTORY_KEY);
    const history = stored?.roomCode === roomCode ? stored : createChatHistory(roomCode);
    const sequence = ++history.sequence;
    const entry = { id: `${history.epoch}:${sequence}`, sequence, name, seat, text };
    history.messages = [...history.messages, entry].slice(-CHAT_HISTORY_LIMIT);
    await txn.put(CHAT_HISTORY_KEY, history);
    return { history, entry };
  });
}
