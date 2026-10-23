// Production may deploy before the Regicide migration runs. Prove that is safe: with the
// Regicide tables missing, games still play to the end and Bridge (incl. the bot) is unaffected.
const { test, expect } = require('@playwright/test');
const { Response: MfResponse } = require('miniflare');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(120000);

const sent = [];
let worker;
test.beforeAll(async () => {
  worker = await startWorker(4222, { TELEGRAM_BOT_TOKEN: 'test-token' }, {
    skipMigrations: ['0011_regicide.sql'],
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'api.telegram.org') return new MfResponse('blocked in tests', { status: 502 });
      sent.push({ method: url.pathname.split('/').pop(), body: await request.json().catch(() => ({})) });
      return MfResponse.json({ ok: true, result: { status: 'member' } });
    },
  });
});
test.afterAll(async () => { await worker?.stop(); });

test('without the Regicide tables: Regicide still plays, boards are empty, Bridge is untouched', async ({ browser }) => {
  const tables = await worker.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'regicide_%'").all();
  expect(tables.results).toEqual([]);

  // Regicide APIs answer "nothing yet" instead of erroring.
  expect(await (await fetch(`${worker.origin}/api/regicide/leaderboard`)).json()).toEqual({ top: [], me: null });
  expect(await (await fetch(`${worker.origin}/api/regicide/stats`)).json()).toEqual([]);

  // The bot's /leaderboard still posts Bridge's board.
  await fetch(`${worker.origin}/api/telegram`, { method: 'POST', body: JSON.stringify({ message: { chat: { id: -1009, type: 'group', title: 'G' }, from: { id: 5, username: 'ana' }, text: '/leaderboard' } }) });
  await expect.poll(() => sent.filter((c) => c.method === 'sendMessage').length).toBe(1);
  expect(sent.find((c) => c.method === 'sendMessage').body.text).toContain('No games played in this group yet');

  // A Regicide solo game runs to the end; the game-over panel just has no rating section.
  const { token } = await (await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: 'No Table Ana' }) })).json();
  const { roomCode } = await (await fetch(`${worker.origin}/api/regicide/create`, { method: 'POST', body: '{"seed":5}' })).json();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.addInitScript((t) => localStorage.setItem('authToken', t), token);
  await page.goto(`${worker.origin}/regicide/#${roomCode}`);
  await page.locator('#btn-start').click();
  await expect(page.locator('#screen-game')).toHaveClass(/active/);
  await fetch(`${worker.origin}/api/regicide/debug/patch?room=${roomCode}`, { method: 'POST', body: JSON.stringify({
    enemy: 'KH', castle: [], enemyDamage: 30, played: [], hands: [['10S']],
    defeated: ['JC', 'JD', 'JH', 'JS', 'QC', 'QD', 'QH', 'QS', 'KC', 'KD', 'KS'] }) });
  await page.evaluate(() => send({ type: 'play', cards: ['10S'] }));
  await expect(page.locator('#over-title')).toContainText('Victory');
  await expect(page.locator('#over-rating')).toBeHidden();
  await page.locator('#btn-again').click();
  await expect(page.locator('#screen-lobby')).toHaveClass(/active/);
  expect(errors).toEqual([]);
  await context.close();

  // Bridge still creates rooms as usual.
  expect((await fetch(`${worker.origin}/api/create`, { method: 'POST', body: '{}' })).ok).toBe(true);
});
