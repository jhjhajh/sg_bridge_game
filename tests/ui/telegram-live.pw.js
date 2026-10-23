// Telegram bot commands end-to-end: updates are POSTed to the real local webhook, and every
// outbound Bot API call is captured (nothing reaches Telegram). Covers both games in one group.
const { test, expect } = require('@playwright/test');
const { Response: MfResponse } = require('miniflare');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(120000);

const GROUP = -100777;
const sent = [];      // captured Bot API calls: { method, body }
const members = new Set();
let worker;

test.beforeAll(async () => {
  worker = await startWorker(4230, { TELEGRAM_BOT_TOKEN: 'test-token' }, {
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'api.telegram.org') return new MfResponse('blocked in tests', { status: 502 });
      const method = url.pathname.split('/').pop();
      const body = await request.json().catch(() => ({}));
      sent.push({ method, body });
      if (method === 'getChatMember') {
        return MfResponse.json({ ok: true, result: { status: members.has(body.user_id) ? 'member' : 'left' } });
      }
      return MfResponse.json({ ok: true, result: true });
    },
  });
});
test.afterAll(async () => { await worker?.stop(); });

const messages = () => sent.filter((c) => c.method === 'sendMessage' && c.body.chat_id === String(GROUP)).map((c) => c.body.text);
async function command(text, chatType = 'supergroup') {
  const before = messages().length;
  const res = await fetch(`${worker.origin}/api/telegram`, {
    method: 'POST',
    body: JSON.stringify({ message: { chat: { id: GROUP, type: chatType, title: 'Card <Club>' }, from: { id: 5, username: 'ana' }, text } }),
  });
  expect(res.status).toBe(200);
  return before;
}
let callbackSequence = 0;
async function chooseGame(data, chatType = 'supergroup') {
  const id = `choice-${++callbackSequence}`;
  const res = await fetch(`${worker.origin}/api/telegram`, {
    method: 'POST',
    body: JSON.stringify({ callback_query: {
      id, data, from: { id: 6, username: 'chooser' },
      message: { message_id: 123, chat: { id: GROUP, type: chatType, title: 'Card <Club>' } },
    } }),
  });
  expect(res.status).toBe(200);
  const answer = sent.find((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id);
  expect(answer).toBeDefined();
  return id;
}
async function login(name) {
  const res = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) });
  return res.json();
}
async function player(browser, auth, room) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  await page.addInitScript((t) => localStorage.setItem('authToken', t), auth.token);
  await page.goto(`${worker.origin}/regicide/#${room}`);
  return { page, context };
}

test('help, aliases and the command menu are all handled in code', async () => {
  let before = await command('/help@funCentral_bot');
  await expect.poll(() => messages().length).toBe(before + 1);
  expect(messages().at(-1)).toContain('/newgame');
  expect(messages().at(-1)).toContain('/newregicide');
  expect(messages().at(-1)).toContain('/newbridge');
  // The "/" menu is registered from code (once per Worker instance): no BotFather step.
  const menu = sent.find((c) => c.method === 'setMyCommands');
  expect(menu?.body.scope).toEqual({ type: 'all_group_chats' });
  expect(menu.body.commands.map((c) => c.command)).toEqual(['newgame', 'leaderboard', 'help']);

  before = await command('/start');
  await expect.poll(() => messages().length).toBe(before + 1);

  // Private chats and unknown commands are ignored.
  before = messages().length;
  await command('/help', 'private');
  await command('/poker');
  expect(messages().length).toBe(before);
});

test('/newgame offers games first, then either button creates the selected group room', async () => {
  const before = await command('/newgame@funCentral_bot');
  await expect.poll(() => messages().length).toBe(before + 1);
  const menu = sent.filter((c) => c.method === 'sendMessage' && c.body.reply_markup).at(-1).body;
  expect(menu.text).toContain('Which game');
  expect(menu.text).not.toMatch(/\/#/);
  expect(menu.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['newgame:bridge', 'newgame:regicide']);
  expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM groups').first('n')).toBe(0);

  for (const game of ['bridge', 'regicide']) {
    const at = sent.length;
    await chooseGame(`newgame:${game}`);
    const calls = sent.slice(at);
    expect(calls[0].method).toBe('answerCallbackQuery'); // spinner stops before room creation
    const post = calls.find((c) => c.method === 'sendMessage').body;
    expect(post.chat_id).toBe(String(GROUP));
    expect(post.text).toContain('@chooser'); // the clicker, not the original menu sender
    const room = new RegExp(`/${game}/#([A-Z0-9]{4})`).exec(post.text)[1];
    if (game === 'bridge') {
      const roomState = await worker.mf.getDurableObjectNamespace('GAME_ROOM');
      const phase = await roomState.get(roomState.idFromName(room)).fetch('https://internal/phase');
      expect((await phase.json()).phase).toBe('lobby');
    } else {
      const rooms = await worker.mf.getDurableObjectNamespace('REGICIDE_ROOM');
      const response = await rooms.get(rooms.idFromName(room)).fetch('https://internal/?playerId=guest_observer', { headers: { Upgrade: 'websocket' } });
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      socket.accept();
      const state = await new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true }));
      expect(state.groupName).toBe('Card <Club>');
      expect(state.game).toBeNull();
      socket.close(1000);
    }
  }
  await command('/newbridge');
  expect(messages().at(-1)).toMatch(/\/bridge\/#[A-Z0-9]{4}/);
});

test('unsupported or private-chat buttons are acknowledged without creating a game', async () => {
  const before = messages().length;
  await chooseGame('newgame:unknown');
  await chooseGame('newgame:constructor');
  await chooseGame('newgame:bridge', 'private');
  expect(messages().length).toBe(before);
  const answers = sent.filter((c) => c.method === 'answerCallbackQuery').slice(-3);
  expect(answers).toHaveLength(3);
  for (const answer of answers) expect(answer.body.text).toContain('/newgame');
});

test('/newregicide: group room, membership-aware lobby, start and result posts, group leaderboard', async ({ browser }) => {
  const ana = await login('Group Ana');
  const ben = await login('Group Ben');
  members.add(ana.telegramId); // Ben is not in the group

  const before = await command('/newregicidegame');
  await expect.poll(() => messages().length).toBe(before + 1);
  const intro = messages().at(-1);
  expect(intro).toContain('started a Regicide game');
  const room = /\/regicide\/#([A-Z0-9]{4})/.exec(intro)[1];

  const a = await player(browser, ana, room);
  await expect.poll(() => messages().some((m) => m.includes('Group Ana</b> joined the Regicide lobby (1/4)'))).toBe(true);
  const b = await player(browser, ben, room);
  await expect.poll(() => messages().some((m) => m.includes('Group Ben</b> joined the Regicide lobby (2/4)'))).toBe(true);
  try {
    // Lobby shows the group and flags the non-member, like Bridge.
    await expect(a.page.locator('#lobby-setup')).toContainText('Card <Club>');
    await expect(a.page.locator('.player-item', { hasText: 'Group Ben' }).locator('.not-ranked-badge')).toHaveText('⚠️ not in group');
    await expect(a.page.locator('.player-item', { hasText: 'Group Ana' }).locator('.not-ranked-badge')).toHaveCount(0);

    await a.page.locator('#btn-start').click();
    await expect.poll(() => messages().some((m) => m.includes('Regicide started — 2 players'))).toBe(true);

    // Jump to the last King and win.
    const patch = await fetch(`${worker.origin}/api/regicide/debug/patch?room=${room}`, {
      method: 'POST',
      body: JSON.stringify({ enemy: 'KH', castle: [], enemyDamage: 30, played: [], currentSeat: 0,
        defeated: ['JC', 'JD', 'JH', 'JS', 'QC', 'QD', 'QH', 'QS', 'KC', 'KD', 'KS'], hands: [['10S', '2C'], ['3C', '4C']] }),
    });
    expect(patch.ok).toBe(true);
    await a.page.evaluate(() => { selected = new Set(['10S']); send({ type: 'play', cards: ['10S'] }); });
    await expect(a.page.locator('#modal-over')).toBeVisible();
    await expect.poll(() => messages().find((m) => m.includes('Victory!')) ?? '').toContain('stormed the castle');
    const victory = messages().find((m) => m.includes('Victory!'));
    expect(victory).toMatch(/Group Ana: \+\d+ → \d+/);
    expect(victory).toMatch(/Group Ben: \+\d+ → \d+/); // both are rated…

    const lb = await command('/leaderboard');
    await expect.poll(() => messages().length).toBe(lb + 1);
    const board = messages().at(-1);
    expect(board).toContain('🃏 <b>Bridge</b>');
    expect(board).toContain('♛ <b>Regicide</b>');
    expect(board).toMatch(/Group Ana — \d+ \(best 12\/12, 1G\)/);
    expect(board).not.toContain('Group Ben'); // …but only group members count on the group board
    // A name with HTML characters is escaped in the group post (Telegram rejects broken HTML).
    await a.page.locator('#btn-again').click();
    const eve = await login('Eve <3');
    const c = await player(browser, eve, room);
    await expect.poll(() => messages().some((m) => m.includes('<b>Eve &lt;3</b> joined the Regicide lobby'))).toBe(true);
    await c.context.close();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
