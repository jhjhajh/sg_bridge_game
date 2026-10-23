const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
let worker;
test.setTimeout(45000);
test.beforeAll(async () => { worker = await startWorker(4217); });
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
    if (sessionStorage.getItem('seeded')) return;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
    sessionStorage.setItem('seeded', '1');
    window.alert = value => { window.lastAlert = value; };
    window.confirm = () => true;
  }, { storage, session });
}
async function expectCreatorSeated(page, name) {
  await expect(page.locator('#screen-lobby')).toBeVisible();
  await expect.poll(() => page.evaluate(() => gameState?.roomCode === roomCode && gameState.mySeat)).toBe(0);
  expect(await page.evaluate(() => ({ players: gameState.players.map(p => p.name), spectators: gameState.spectators.length, isSpectator: gameState.isSpectator })))
    .toEqual({ players: [name], spectators: 0, isSpectator: false });
}

test('creating a game seats the creator even when the tab remembers a spectator role', async ({ page }) => {
  const auth = await login('Creator Stale');
  await initialize(page, { authToken: auth.token, playerName: 'Creator Stale' }, { joinRole: 'spectator' });
  await page.goto(`${worker.origin}/bridge/`);
  await expect(page.locator('#game-section')).toBeVisible();
  await page.locator('#btn-create').click();
  await expectCreatorSeated(page, 'Creator Stale');
  // Reconnects keep the creator's seat rather than reverting to the old role.
  await page.reload();
  await expectCreatorSeated(page, 'Creator Stale');
});

test('spectating one room then leaving does not make the next created room spectate', async ({ page }) => {
  const auth = await login('Creator Watcher'); const watched = await room();
  await initialize(page, { authToken: auth.token, playerName: 'Creator Watcher' });
  await page.goto(`${worker.origin}/bridge/#${watched}`);
  await page.locator('#btn-join-spectator').click();
  await expect.poll(() => page.evaluate(() => gameState?.isSpectator)).toBe(true);
  await page.locator('#btn-leave-global').click();
  await expect(page.locator('#screen-home')).toBeVisible();
  expect(await page.evaluate(() => ({ joinAs, stored: sessionStorage.getItem('joinRole') }))).toEqual({ joinAs: null, stored: null });
  await page.locator('#btn-create').click();
  await expectCreatorSeated(page, 'Creator Watcher');
});
