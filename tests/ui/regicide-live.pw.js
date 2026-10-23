const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(60000);
let worker;
test.beforeAll(async () => { worker = await startWorker(4218); });
test.afterAll(async () => { await worker?.stop(); });

async function client(browser, name, { mobile = false, hash = '' } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  await page.addInitScript(({ name }) => {
    localStorage.setItem('playerName', name);
    window.confirm = () => true;
  }, { name });
  await page.goto(`${worker.origin}/regicide/${hash}`);
  return { page, context };
}

test('hub links to both games and old bridge invites redirect', async ({ browser }) => {
  const { page, context } = await client(browser, 'Hub', { mobile: true });
  try {
    await page.goto(worker.origin);
    await expect(page.getByRole('link', { name: /Floating Bridge/ })).toHaveAttribute('href', '/bridge/');
    await expect(page.getByRole('link', { name: /Regicide/ })).toHaveAttribute('href', '/regicide/');
    await page.goto(`${worker.origin}/#ABCD`);
    await expect(page).toHaveURL(/\/bridge\/#ABCD/);
    // No horizontal scroll on a phone.
    await page.goto(worker.origin);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('two players: lobby, start, play a card, take damage, back to lobby', async ({ browser }) => {
  const host = await client(browser, 'Ada');
  const guest = await client(browser, 'Bea', { mobile: true });
  try {
    await host.page.getByRole('button', { name: 'Create a room' }).click();
    await expect(host.page.locator('#screen-lobby')).toBeVisible();
    const code = (await host.page.locator('#lobby-code').textContent()).trim();
    expect(code).toMatch(/^[A-Z0-9]{4}$/);

    await guest.page.goto(`${worker.origin}/regicide/#${code}`);
    await expect(host.page.locator('#lobby-players .lobby-slot:not(.empty)')).toHaveCount(2);
    await expect(guest.page.locator('#lobby-wait')).toContainText('Waiting for Ada');
    await host.page.getByRole('button', { name: 'Start game (2 players)' }).click();

    for (const { page } of [host, guest]) {
      await expect(page.locator('#screen-game')).toBeVisible();
      await expect(page.locator('#hand .hand-card')).toHaveCount(7);
      await expect(page.locator('#enemy-name')).toContainText('Jack of');
    }

    // Whoever's turn it is plays their highest single card.
    const turn = await host.page.evaluate(() => view.game.currentSeat);
    const active = turn === 0 ? host : guest;
    const idle = turn === 0 ? guest : host;
    await expect(idle.page.locator('#btn-act')).toBeDisabled();
    const card = await active.page.evaluate(() => [...view.game.hand].filter(c => !c.startsWith('X')).sort((a, b) => valueOf(b) - valueOf(a))[0]);
    await active.page.locator(`#hand .hand-card[data-card="${card}"]`).click();
    await expect(active.page.locator('#preview')).toContainText('dmg');
    await active.page.locator('#btn-act').click();

    // The other player sees the attack (or the kill, if it was e.g. 10♣ = 20 exactly).
    await expect.poll(() => idle.page.evaluate(() => view.game.log.some(e => e.t === 'play'))).toBe(true);
    const killed = await idle.page.evaluate(() => view.game.defeated.length === 1);
    if (!killed) await expect(idle.page.locator('#played-cards .rc-card')).toHaveCount(1);
    const phase = await active.page.evaluate(() => view.game.phase);
    if (phase === 'discard') {
      await expect(active.page.locator('#turn-banner')).toContainText('Take');
      await active.page.getByRole('button', { name: '✨ Best fit' }).click();
      await active.page.locator('#btn-act').click();
      await expect.poll(() => idle.page.evaluate(() => view.game.currentSeat)).toBe(1 - turn);
    }

    // Mobile layout: hand and actions are on screen without horizontal scroll.
    expect(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Host ends the game early → everyone back in the lobby with the same roster.
    await host.page.evaluate(() => send({ type: 'backToLobby' }));
    for (const { page } of [host, guest]) {
      await expect(page.locator('#screen-lobby')).toBeVisible();
      await expect(page.locator('#lobby-players .lobby-slot:not(.empty)')).toHaveCount(2);
    }
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('unknown room code returns to home with an error', async ({ browser }) => {
  const { page, context } = await client(browser, 'Cy', { hash: '#ZZZZ' });
  try {
    await expect(page.locator('.toast.error')).toContainText("doesn't exist");
    await expect(page.locator('#screen-home')).toBeVisible();
  } finally { await context.close(); }
});
