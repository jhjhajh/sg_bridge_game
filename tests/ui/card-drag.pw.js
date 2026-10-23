const { test, expect } = require('@playwright/test');
const { createServer } = require('./serve.cjs');
const { tablePoint, dragPoints } = require('./touch-drag.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const origin = 'http://127.0.0.1:4212';
let server;
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.beforeAll(async () => { server = createServer(); await new Promise(resolve => server.listen(4212, '127.0.0.1', resolve)); });
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function initialize(page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(`${origin}/bridge/`);
}
test.beforeEach(async ({ page }) => initialize(page));

async function fixture(page, mode, overrides = {}) {
  await page.evaluate(({ mode, overrides }) => {
    document.querySelector(`[data-table-view="${mode}"]`).click();
    roomCode = 'DEMO'; playerName = 'Alex'; prevTurn = 0; pendingPlay = null;
    window.sentMoves = [];
    ws = { readyState: WebSocket.OPEN, send: value => sentMoves.push(JSON.parse(value)), close() {} };
    handleMessage({ type: 'state', state: {
      phase: 'play', roomCode, gameId: 'drag-fixture', mySeat: 0, turn: 0, bid: 7, bidder: 0,
      hand: { '♣': ['A', 'K', 'Q', '10'], '♦': ['A', 'J', '8'], '♥': ['K', '9', '7'], '♠': ['Q', '8', '2'] },
      trumpSuit: '♥', trumpBroken: true, partnerCard: 'A ♠', partnerSeat: -1,
      playedCards: [null, null, null, null], currentSuit: null, sets: [2, 1, 2, 1], setsNeeded: 8,
      bidHistory: [], isSpectator: false, spectators: [], isPractice: false, readySeats: [],
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })), ...overrides,
    } });
    const space = document.createElement('div'); space.style.height = '900px'; document.body.append(space);
    document.querySelector('#play-hand').scrollIntoView({ block: 'center' });
  }, { mode, overrides });
  await page.locator('#play-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
}

async function point(page, index = 3) {
  return page.locator('#play-hand .hand-card').nth(index).evaluate(card => {
    for (const glyph of card.querySelectorAll('.card-corner > span')) {
      const r = glyph.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === card) return p;
    }
    throw new Error('No exposed card corner');
  });
}
async function input(session, type, p) {
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ ...p, id: 1 }] : [] });
}
async function move(session, start, target) {
  for (const p of dragPoints(start, target)) await input(session, 'touchMove', p);
}

for (const mode of ['classic', '25d']) {
  test(`card follows its grab point and table release plays once ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    const p = await point(page); const target = await tablePoint(page);
    const scroll = await page.evaluate(() => scrollY + document.body.scrollTop);
    const session = await page.context().newCDPSession(page);
    await input(session, 'touchStart', p);
    await move(session, p, target);
    await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
    await expect(page.locator('#play-hand')).toHaveClass(/drop-ready/);
    expect(await page.locator('.drag-proxy').evaluate((el, target) => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      const origin = getComputedStyle(el).transformOrigin.split(' ').map(Number.parseFloat);
      return Math.hypot(matrix.e + origin[0] - target.x, matrix.f + origin[1] - target.y);
    }, target)).toBeLessThan(1);
    expect(await page.evaluate(() => sentMoves)).toEqual([]);
    await input(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '10 ♣' }]);
    await expect(page.locator('.card-drag-layer')).toHaveCount(0);
    await input(session, 'touchStart', p); await move(session, p, target); await input(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves.length)).toBe(1);
    expect(await page.evaluate(() => scrollY + document.body.scrollTop)).toBe(scroll);
    await session.detach();
  });

  test(`table hover then hand/elsewhere release returns without play ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    await page.evaluate(() => { window.handNodes = [...document.querySelectorAll('#play-hand .hand-card')]; });
    for (const destination of ['hand', 'elsewhere', 'outside-edge']) {
      const p = await point(page); const target = await tablePoint(page);
      const session = await page.context().newCDPSession(page);
      await input(session, 'touchStart', p); await move(session, p, target);
      await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
      const end = destination === 'hand' ? p : destination === 'elsewhere' ? { x: 4, y: p.y - 100 }
        : await page.locator('#play-table').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left - 1, y: Math.max(60, r.top + 3) }; });
      await move(session, target, end);
      await expect(page.locator('#play-table')).not.toHaveClass(/card-drop-ready/);
      await input(session, 'touchEnd');
      await expect(page.locator('.card-drag-layer')).toHaveCount(0);
      await expect(page.locator('#play-hand .is-drag-source')).toHaveCount(0);
      expect(await page.evaluate(() => sentMoves)).toEqual([]);
      expect(await page.evaluate(() => handNodes.every((node, i) => document.querySelectorAll('#play-hand .hand-card')[i] === node))).toBe(true);
      await session.detach();
    }
  });

  test(`unrelated states preserve the drag and original card typography ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    const p = await point(page); const target = await tablePoint(page);
    const session = await page.context().newCDPSession(page);
    await input(session, 'touchStart', p); await move(session, p, { x: p.x + 50, y: p.y - 30 });
    await page.evaluate(() => {
      window.proxyNode = document.querySelector('.drag-proxy');
      window.sourceNodes = [...document.querySelectorAll('#play-hand .hand-card')];
      window.sourceStyles = sourceNodes.map(card => card.style.cssText);
      for (let i = 0; i < 6; i++) {
        handleMessage({ type: i % 2 ? 'playerDisconnected' : 'playerReconnected', seat: 2, name: 'Casey' });
        handleMessage({ type: 'state', state: structuredClone(gameState) });
      }
    });
    expect(await page.evaluate(() => sourceNodes.every((card, i) => document.querySelectorAll('#play-hand .hand-card')[i] === card
      && card.style.cssText === sourceStyles[i]) && document.querySelector('.drag-proxy') === proxyNode)).toBe(true);
    expect(await page.evaluate(() => {
      const source = document.querySelector('#play-hand .is-drag-source'); const proxy = document.querySelector('.drag-proxy');
      const font = el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.fontWeight, s.color]; };
      return JSON.stringify(font(source)) === JSON.stringify(font(proxy))
        && JSON.stringify(font(source.querySelector('.card-corner'))) === JSON.stringify(font(proxy.querySelector('.card-corner')))
        && proxy.closest('.card-drag-layer').inert && proxy.closest('[aria-hidden="true"]') !== null;
    })).toBe(true);
    await move(session, { x: p.x + 50, y: p.y - 30 }, target); await input(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '10 ♣' }]);
    await session.detach();
  });

  for (const overrides of [{ turn: 1 }, { currentSuit: '♦' }, { isSpectator: true }, { trickComplete: true }]) {
    test(`invalid card/turn cannot enable a table drop ${mode} ${JSON.stringify(overrides)}`, async ({ page }) => {
      await fixture(page, mode, overrides);
      const p = await point(page); const target = await tablePoint(page);
      const session = await page.context().newCDPSession(page);
      await input(session, 'touchStart', p); await move(session, p, target);
      await expect(page.locator('.drag-proxy')).toHaveCount(1);
      await expect(page.locator('#play-table')).not.toHaveClass(/card-drop-available|card-drop-ready/);
      await input(session, 'touchEnd'); await expect(page.locator('.card-drag-layer')).toHaveCount(0);
      expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
    });
  }

  for (const cancellation of ['pointercancel', 'lostcapture', 'second-pointer', 'turn', 'hand', 'phase', 'view', 'escape']) {
    test(`eligible drag cancels safely on ${cancellation} ${mode}`, async ({ page }) => {
      await fixture(page, mode);
      const p = await point(page); const target = await tablePoint(page);
      await page.locator('#play-hand').evaluate(el => el.addEventListener('pointerdown', e => { window.pointerId = e.pointerId; }, { once: true }));
      const session = await page.context().newCDPSession(page);
      await input(session, 'touchStart', p); await move(session, p, target);
      await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
      if (cancellation === 'pointercancel') await input(session, 'touchCancel');
      else if (cancellation === 'lostcapture') await page.locator('#play-hand').evaluate(el => el.releasePointerCapture(pointerId));
      else if (cancellation === 'second-pointer') await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...target, id: 1 }, { x: target.x + 40, y: target.y, id: 2 }] });
      else if (cancellation === 'view') await page.evaluate(() => document.querySelector('#top-bar [aria-pressed="false"]').click());
      else if (cancellation === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(cancellation => {
        const s = structuredClone(gameState);
        if (cancellation === 'turn') s.turn = 1;
        if (cancellation === 'hand') s.hand['♣'].shift();
        if (cancellation === 'phase') s.phase = 'bidding';
        handleMessage({ type: 'state', state: s });
      }, cancellation);
      if (cancellation !== 'pointercancel') await input(session, 'touchEnd');
      await expect(page.locator('.card-drag-layer')).toHaveCount(0);
      await expect(page.locator('#play-table')).not.toHaveClass(/card-drop-available|card-drop-ready/);
      expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
    });
  }

  test(`reduced motion keeps direct tracking and instant return ${mode}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await fixture(page, mode);
    const p = await point(page); const target = await tablePoint(page);
    const session = await page.context().newCDPSession(page);
    await input(session, 'touchStart', p); await move(session, p, target);
    const matrix = await page.locator('.drag-proxy').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return [m.a, m.b, m.c, m.d]; });
    expect(matrix).toEqual([1, 0, 0, 1]);
    await move(session, target, p); await input(session, 'touchEnd');
    expect(await page.locator('.card-drag-layer').count()).toBe(0);
    expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
  });

  test(`tilt stays bounded and settles while the grab point stays attached ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    const p = await point(page); const end = { x: Math.min(340, p.x + 110), y: p.y - 45 };
    const session = await page.context().newCDPSession(page);
    await input(session, 'touchStart', p); await move(session, p, end);
    const angle = () => page.locator('.drag-proxy').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return Math.atan2(m.b, m.a) * 180 / Math.PI; });
    expect(Math.abs(await angle())).toBeLessThanOrEqual(38.01);
    // An off-center grip settles at a hanging angle rather than forcing the
    // card upright. Check decay by observing its actual motion at rest.
    await page.waitForTimeout(1400);
    const settled = [];
    for (let i = 0; i < 5; i++) { settled.push(await angle()); await page.waitForTimeout(50); }
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(0.5);
    expect(await page.locator('.drag-proxy').evaluate((el, end) => {
      const m = new DOMMatrix(getComputedStyle(el).transform); const o = getComputedStyle(el).transformOrigin.split(' ').map(Number.parseFloat);
      return Math.hypot(m.e + o[0] - end.x, m.f + o[1] - end.y);
    }, end)).toBeLessThan(1);
    await move(session, end, p); await input(session, 'touchEnd');
    await expect(page.locator('.card-drag-layer')).toHaveCount(0);
    expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
  });
}

test('capture synthetic drag, return and table drop in both views', async ({ browser }) => {
  test.skip(!process.env.DRAG_CAPTURE, 'Opt-in screenshot and browser gesture recording.');
  const directory = path.join(__dirname, '../../docs/card-drag'); await fs.mkdir(directory, { recursive: true });
  for (const mode of ['classic', '25d']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      recordVideo: { dir: path.join(directory, 'recording'), size: { width: 390, height: 844 } } });
    const page = await context.newPage(); await initialize(page); await fixture(page, mode);
    await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTop = 0; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(directory, `${mode}-resting.png`) });
    const p = await point(page); const target = await tablePoint(page);
    const session = await context.newCDPSession(page);
    await input(session, 'touchStart', p);
    const lifted = { x: Math.min(330, p.x + 90), y: p.y - 55 };
    for (const step of dragPoints(p, lifted, 8)) { await input(session, 'touchMove', step); await page.waitForTimeout(35); }
    await page.screenshot({ path: path.join(directory, `${mode}-dragging.png`) });
    for (const step of dragPoints(lifted, target, 10)) { await input(session, 'touchMove', step); await page.waitForTimeout(35); }
    await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
    await page.screenshot({ path: path.join(directory, `${mode}-table-ready.png`) });
    await page.waitForTimeout(400);
    for (const step of dragPoints(target, p, 10)) { await input(session, 'touchMove', step); await page.waitForTimeout(35); }
    await input(session, 'touchEnd'); await expect(page.locator('.card-drag-layer')).toHaveCount(0);
    await page.waitForTimeout(350);
    await input(session, 'touchStart', p);
    for (const step of dragPoints(p, target, 12)) { await input(session, 'touchMove', step); await page.waitForTimeout(35); }
    await input(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '10 ♣' }]);
    await page.waitForTimeout(180);
    // Synthetic authoritative acknowledgement for the visual demo. Live E2E
    // separately exercises the actual Worker/WebSocket acceptance path.
    await page.evaluate(() => {
      const s = structuredClone(gameState); s.hand['♣'] = s.hand['♣'].filter(v => v !== '10');
      s.playedCards[0] = '10 ♣'; s.currentSuit = '♣'; s.turn = 1; handleMessage({ type: 'state', state: s });
    });
    await page.screenshot({ path: path.join(directory, `${mode}-played.png`) }); await page.waitForTimeout(700);
    await session.detach(); const video = page.video(); await context.close();
    await video.saveAs(path.join(directory, `${mode}-drag-return-drop.webm`)); await video.delete();
  }
});
