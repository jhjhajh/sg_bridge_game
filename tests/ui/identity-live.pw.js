const { test, expect } = require('@playwright/test');
const { createHash, createHmac } = require('node:crypto');
const { startWorker } = require('./live-worker.cjs');
const BOT_TOKEN = 'local-identity-signature-test-only';
let worker;
test.setTimeout(45000);
test.beforeAll(async () => { worker = await startWorker(4216, { TELEGRAM_BOT_TOKEN: BOT_TOKEN }); });
test.afterAll(async () => { await worker?.stop(); });
async function login(name) {
  const res = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) });
  expect(res.ok).toBe(true); return res.json();
}
async function room() {
  const res = await fetch(`${worker.origin}/api/create`, { method: 'POST', body: '{}' });
  return (await res.json()).roomCode;
}
async function initialize(page, storage = {}, session = {}) {
  await page.route('**/*', route => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  await page.addInitScript(({ storage, session }) => {
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
    window.joinFrames = []; window.seenNames = []; window.alert = value => { window.lastAlert = value; };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(value) { const msg = JSON.parse(value); if (msg.type === 'join') joinFrames.push(msg); return send.call(this, value); };
    const Native = WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => {
      const msg = JSON.parse(event.data); if (msg.type === 'state') seenNames.push(...msg.state.players.map(p => p.name), ...msg.state.spectators.map(p => p.name));
    }); } };
  }, { storage, session });
}
function signed(fields) {
  const payload = { auth_date: Math.floor(Date.now() / 1000), ...fields };
  const check = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  return { ...payload, hash: createHmac('sha256', createHash('sha256').update(BOT_TOKEN).digest()).update(check).digest('hex') };
}
async function expectNamed(page, name) {
  await expect.poll(() => page.evaluate(() => gameState?.players.find(p => p.seat === gameState.mySeat)?.name)).toBe(name);
  expect(await page.evaluate(() => seenNames.every(name => typeof name === 'string' && name.trim().length > 0))).toBe(true);
}

for (const mode of ['classic', '25d']) test(`profile resolves before deep-link join and survives reload/reconnect ${mode}`, async ({ page }) => {
  const auth = await login(`Verified ${mode}`); const code = await room();
  await initialize(page, { authToken: auth.token, playerName: ' \u200b ', playerId: 'stale-browser-id', 'bridge.tableView': mode });
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/me', async route => { await gate; await route.continue(); });
  await page.goto(`${worker.origin}/bridge/#${code}:old-url-id`);
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => joinFrames)).toEqual([]);
  release();
  await expect(page.locator('#screen-role-choice')).toBeVisible();
  await page.locator('#btn-join-player').click();
  await expectNamed(page, `Verified ${mode}`);
  const identity = await page.evaluate(() => ({ id: playerId, seat: gameState.mySeat }));
  expect(identity.id).toMatch(/^tg_\d+$/);
  // Remove only the stale startup seed so a real reload reads saved identity.
  await page.unroute('**/api/me');
  await page.evaluate(() => { localStorage.setItem('playerName', 'Outdated alias'); });
  // The init script intentionally seeds stale data again, exercising recovery.
  await page.reload(); await expectNamed(page, `Verified ${mode}`);
  expect(await page.evaluate(() => ({ id: playerId, seat: gameState.mySeat }))).toEqual(identity);
  await page.evaluate(() => { ws.onclose = null; ws.close(); ws = null; connect(); });
  await expect.poll(() => page.evaluate(() => ws?.readyState)).toBe(WebSocket.OPEN);
  await expectNamed(page, `Verified ${mode}`);
  expect(await page.evaluate(() => gameState.players.filter(p => p.name === playerName).length)).toBe(1);
});

test('temporary profile failure retains the login and offers retry before a nameless join', async ({ page }) => {
  const auth = await login('Retry Alice'); const code = await room();
  await initialize(page, { authToken: auth.token, playerName: ' ', playerId: 'stable-local-id' }, { roomCode: code, joinRole: 'player' });
  await page.route('**/api/me', route => route.fulfill({ status: 503, json: { error: 'Test outage' } }));
  await page.goto(`${worker.origin}/bridge/`);
  await expect(page.locator('#screen-home')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('authToken'))).toBe(auth.token);
  expect(await page.evaluate(() => joinFrames)).toEqual([]);
  await page.unroute('**/api/me');
  await page.locator('#btn-retry-identity').click(); await expectNamed(page, 'Retry Alice');
});

test('verified Telegram response with no usable name requires manual name, preserves ID and persists it', async ({ page }) => {
  const code = await room(); await initialize(page);
  await page.goto(`${worker.origin}/bridge/#${code}`);
  const payload = signed({ id: 991234501, first_name: ' ', last_name: '', username: '' });
  await page.evaluate(payload => onTelegramAuth(payload), payload);
  await expect(page.locator('#input-name')).toBeEditable();
  await expect(page.locator('#identity-status')).toContainText('display name');
  expect(await page.evaluate(() => joinFrames)).toEqual([]);
  await page.locator('#input-name').fill('  Alex Restored  '); await page.locator('#btn-join').click();
  await page.locator('#btn-join-player').click(); await expectNamed(page, 'Alex Restored');
  expect(await page.evaluate(() => playerId)).toBe('tg_991234501');
  await page.reload(); await expectNamed(page, 'Alex Restored');
  expect(await worker.db.prepare('SELECT display_name FROM users WHERE telegram_id = ?').bind(991234501).first()).toEqual({ display_name: 'Alex Restored' });
});

test('missing/late unsafe SDK data is never treated as verified login', async ({ page }) => {
  const code = await room(); await initialize(page, { playerName: ' ' });
  await page.goto(`${worker.origin}/bridge/#${code}`);
  await page.evaluate(() => { window.Telegram = { WebApp: { initDataUnsafe: { user: { id: 1, first_name: 'Unverified' } } } }; });
  await expect(page.locator('#login-section')).toBeVisible();
  expect(await page.evaluate(() => ({ token: authToken, name: playerName, sent: joinFrames.length }))).toEqual({ token: null, name: '', sent: 0 });
  await page.evaluate(() => onTelegramAuth({ id: 1, first_name: 'Unverified' }));
  expect(await page.evaluate(() => authToken)).toBeNull();
});

test('actual room rejects malformed joins and never blanks an existing player', async ({ page }) => {
  const auth = await login('Server Alice'); const code = await room(); await initialize(page); await page.goto(`${worker.origin}/bridge/`);
  await page.evaluate(({ token, code }) => new Promise(resolve => {
    window.rawMessages = [];
    window.rawSocket = new WebSocket(`${location.origin.replace('http', 'ws')}/api/ws?room=${code}&playerId=ignored&token=${encodeURIComponent(token)}`);
    rawSocket.addEventListener('message', e => rawMessages.push(JSON.parse(e.data)));
    rawSocket.addEventListener('open', resolve);
  }), { token: auth.token, code });
  for (const name of [null, '', '  \t ', '\u200b', {}, 42]) {
    const before = await page.evaluate(() => rawMessages.filter(m => m.type === 'error').length);
    await page.evaluate(name => rawSocket.send(JSON.stringify({ type: 'join', name })), name);
    await expect.poll(() => page.evaluate(() => rawMessages.filter(m => m.type === 'error' && m.code === 'NAME_REQUIRED').length)).toBe(before + 1);
  }
  await page.evaluate(() => rawSocket.send(JSON.stringify({ type: 'join', name: ' Alice ' })));
  await expect.poll(() => page.evaluate(() => rawMessages.filter(m => m.type === 'state').at(-1)?.state.players[0]?.name)).toBe('Alice');
  await page.evaluate(() => rawSocket.send(JSON.stringify({ type: 'join', name: '' })));
  await expect.poll(() => page.evaluate(() => rawMessages.filter(m => m.code === 'NAME_REQUIRED').length)).toBe(7);
  await page.evaluate(() => rawSocket.send(JSON.stringify({ type: 'join', name: 'Alice' })));
  await expect.poll(() => page.evaluate(() => rawMessages.filter(m => m.type === 'state').at(-1)?.state.players[0]?.name)).toBe('Alice');
  expect(await page.evaluate(() => rawMessages.filter(m => m.type === 'state').every(m => m.state.players.every(p => p.name.trim())))).toBe(true);
  await page.evaluate(() => rawSocket.close());
});

test('signed malformed/nameless profiles use safe name recovery without weakening signature checks', async () => {
  for (const fields of [{ id: 991234502, first_name: '', username: '  user_name  ' }, { id: 991234503, last_name: ' Lee ' }]) {
    const res = await fetch(`${worker.origin}/api/auth/telegram`, { method: 'POST', body: JSON.stringify(signed(fields)) });
    expect(res.status).toBe(200); const profile = await res.json(); expect(profile.displayName.trim()).not.toBe(''); expect(profile.nameRequired).toBe(false);
  }
  const badId = await fetch(`${worker.origin}/api/auth/telegram`, { method: 'POST', body: JSON.stringify(signed({ id: 0, first_name: 'Alice' })) });
  expect(badId.status).toBe(400);
  const unsigned = await fetch(`${worker.origin}/api/auth/telegram`, { method: 'POST', body: JSON.stringify({ id: 991234504, first_name: 'Alice' }) });
  expect(unsigned.status).toBe(401);
});

test('two verified clients retain names and seats across reload and socket replacement', async ({ browser }) => {
  const code = await room(); const clients = [];
  try {
    for (const name of ['Identity Alice', 'Identity Blair']) {
      const auth = await login(name); const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); clients.push(page);
      await initialize(page, { authToken: auth.token, playerName: ' \u200b ', playerId: 'stale-id' }, { roomCode: code, joinRole: 'player' });
      await page.goto(`${worker.origin}/bridge/`); await expectNamed(page, name);
    }
    for (const page of clients) await expect.poll(() => page.evaluate(() => gameState.players.length)).toBe(2);
    const identities = await Promise.all(clients.map(page => page.evaluate(() => ({ id: playerId, seat: gameState.mySeat }))));
    await clients[0].reload(); await expectNamed(clients[0], 'Identity Alice');
    await clients[1].evaluate(() => { ws.onclose = null; ws = null; connect(); });
    for (let i = 0; i < clients.length; i++) {
      await expect.poll(() => clients[i].evaluate(() => gameState.players.every(p => p.connected))).toBe(true);
      expect(await clients[i].evaluate(() => ({ id: playerId, seat: gameState.mySeat }))).toEqual(identities[i]);
      expect(await clients[i].evaluate(() => gameState.players.map(p => p.name))).toEqual(['Identity Alice', 'Identity Blair']);
      expect(await clients[i].evaluate(() => seenNames.every(name => typeof name === 'string' && name.trim()))).toBe(true);
    }
  } finally { for (const page of clients) await page.close(); }
});

test('invalid saved credential stops auto-join and preserves the room for sign-in', async ({ page }) => {
  const code = await room(); await initialize(page, { authToken: 'invalid-synthetic-token', playerName: 'Old name', playerId: 'tg_991234599' }, { roomCode: code, joinRole: 'player' });
  await page.goto(`${worker.origin}/bridge/`); await expect(page.locator('#login-section')).toBeVisible();
  expect(await page.evaluate(() => ({ token: authToken, sent: joinFrames.length, code: roomCode }))).toEqual({ token: null, sent: 0, code });
});

test('profile recovery repairs a legacy blank account name from verified claims', async ({ page }) => {
  const auth = await login('Profile Alice'); const code = await room();
  const row = await worker.db.prepare('SELECT telegram_id FROM users WHERE display_name = ?').bind('Profile Alice').first();
  await worker.db.prepare('UPDATE users SET display_name = ? WHERE telegram_id = ?').bind(' ', row.telegram_id).run();
  await initialize(page, { authToken: auth.token, playerName: ' ', playerId: 'old' }, { roomCode: code, joinRole: 'player' });
  await page.goto(`${worker.origin}/bridge/`); await expectNamed(page, 'Profile Alice');
  expect(await worker.db.prepare('SELECT display_name FROM users WHERE telegram_id = ?').bind(row.telegram_id).first()).toEqual({ display_name: 'Profile Alice' });
});

test('a late profile response cannot replace a newer verified login', async ({ page }) => {
  const auth = await login('Earlier Alice'); const code = await room();
  await initialize(page, { authToken: auth.token, playerName: 'Earlier Alice' }, { roomCode: code, joinRole: 'player' });
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/me', async route => { await gate; await route.continue(); });
  await page.goto(`${worker.origin}/bridge/`); await page.waitForTimeout(50);
  await page.evaluate(payload => onTelegramAuth(payload), signed({ id: 991234588, first_name: 'Later Blair' }));
  await expectNamed(page, 'Later Blair'); release();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => ({ id: playerId, name: playerName }))).toEqual({ id: 'tg_991234588', name: 'Later Blair' });
});

test('bidding/partner browser fixture keeps seat identity through duplicate and repaired names', async ({ page }) => {
  await initialize(page); await page.goto(`${worker.origin}/bridge/`);
  for (const firstName of ['Earlier name', 'Alex']) {
    for (const phase of ['bidding', 'partner']) {
      await page.evaluate(({ firstName, phase }) => {
        roomCode = 'FIXT'; playerName = 'Alex';
        handleMessage({ type: 'state', state: { phase, roomCode, gameId: 'name-fixture', mySeat: 0, turn: 3,
          bid: 0, bidder: 2, hand: { '♣': ['A'], '♦': [], '♥': [], '♠': [] }, currentSuit: null,
          trumpSuit: '♠', trumpBroken: false, partnerCard: null, partnerSeat: -1, playedCards: [null, null, null, null],
          sets: [0, 0, 0, 0], bidHistory: [{ seat: 2, name: firstName, bidNum: 0 }], spectators: [], isSpectator: false,
          players: ['Alex', 'Blair', 'Alex', 'Drew'].map((name, seat) => ({ name, seat, connected: true })) } });
      }, { firstName, phase });
      await expect(page.locator(phase === 'bidding' ? '#bid-history th' : '#partner-bid-history th')).toHaveText(['Alex', 'Drew', 'Alex', 'Blair']);
    }
  }
});
