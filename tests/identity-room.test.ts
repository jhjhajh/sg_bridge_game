import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

// Execute the actual room implementation with transport/storage shims. No
// Cloudflare account, external fetches, or copied state-machine implementation.
function load(file: string, globals: Record<string, unknown> = {}) {
  const exports = {};
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, crypto: webcrypto, structuredClone, setTimeout, clearTimeout, ...globals }, { filename: file });
  return exports as any;
}
const { GameRoom } = load('src/game-room.ts', { ...load('src/types.ts'), ...load('src/player-name.ts'),
  DurableObject: class { constructor(public ctx: any, public env: any) {} }, WebSocketRequestResponsePair: class {} });
function roomFixture() {
  const values = new Map<string, any>(); let alarm: number | null = null;
  const storage = { get: async (key: string) => structuredClone(values.get(key)),
    put: vi.fn(async (key: string, value: any) => { values.set(key, structuredClone(value)); }),
    getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } };
  const room = new GameRoom({ storage, getWebSockets: () => [], setWebSocketAutoResponse() {}, waitUntil() {} }, {});
  const state = room.createInitialState('LOCAL');
  state.phase = 'bidding'; state.players = [{ id: 'tg_1', name: 'Alice', seat: 0, connected: true }];
  values.set('state', state);
  return { room, values, storage, alarm: () => alarm };
}
describe('identity state and connection lifecycle', () => {
  it('repairs legacy names in persisted state before building the initial view', async () => {
    const { room, values, storage } = roomFixture(); const state = values.get('state');
    state.players[0].name = ' \u200b '; state.spectators = [{ id: 'tg_2', name: null, watchingSeat: -1 }];
    const repaired = await room.getState();
    expect(repaired.players[0].name).toBe('Player 1');
    expect(repaired.spectators[0].name).toBe('Spectator 1');
    expect(values.get('state').players[0].id).toBe('tg_1');
    expect(room.buildStateMessage(repaired, 'tg_1').state.players[0].name).toBe('Player 1');
    await room.getState(); expect(storage.put).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('ignores a replaced socket close (old map entry=%s)', async oldMapped => {
    const { room, values, alarm } = roomFixture();
    const old = { deserializeAttachment: () => ({ playerId: 'tg_1' }) };
    const active = { send() {} };
    if (oldMapped) room.sessions.set(old, { playerId: 'tg_1' });
    room.sessions.set(active, { playerId: 'tg_1' });
    await room.webSocketClose(old, 1000);
    expect(values.get('state').players[0].connected).toBe(true);
    expect(values.get('state').disconnectTimers).toEqual({});
    expect(room.sessions.has(active)).toBe(true); expect(alarm()).toBeNull();
  });
  it('handles the active socket error once and ignores its later close', async () => {
    const { room, values } = roomFixture();
    const socket = { send() {}, deserializeAttachment: () => ({ playerId: 'tg_1' }) };
    room.sessions.set(socket, { playerId: 'tg_1' });
    await room.webSocketError(socket);
    const timer = values.get('state').disconnectTimers[0];
    expect(values.get('state').players[0].connected).toBe(false); expect(timer).toBeGreaterThan(0);
    await room.webSocketClose(socket, 1006);
    expect(values.get('state').disconnectTimers[0]).toBe(timer);
  });
});
