const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('./serve.cjs');
const suits = ['♣', '♦', '♥', '♠'];
const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const fullHand = [4, 3, 3, 3];
const distributions = [fullHand, [10, 1, 1, 1], [13, 0, 0, 0], [0, 6, 7, 0], [1, 1, 1, 0], [0, 0, 0, 1], [0, 0, 0, 0]];
let server;
let gameNumber = 0;
test.beforeAll(async () => { server = createServer(); await new Promise(resolve => server.listen(4174, '127.0.0.1', resolve)); });
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function initializePage(page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4174') return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: {} });
    return route.continue();
  });
  await page.addInitScript(() => { window.alert = message => { window.lastAlert = message; }; });
  await page.goto('/');
}
test.beforeEach(async ({ page }) => initializePage(page));

async function showHand(page, screen = 'play', counts = fullHand, overrides = {}) {
  const hand = Object.fromEntries(suits.map((suit, i) => [suit, ranks.slice(0, counts[i])]));
  await page.evaluate(({ screen, hand, overrides, gameId }) => {
    const state = {
      phase: screen, gameId, roomCode: 'TEST', hand, currentSuit: null, mySeat: 0, turn: 0, bid: 7, bidder: 0,
      trumpSuit: '♠', trumpBroken: true, partnerCard: '2 ♠', partnerSeat: -1,
      playedCards: [null, null, null, null], sets: [0, 0, 0, 0], bidHistory: [],
      isSpectator: false, watchingSeat: 0, spectators: [], isPractice: false,
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })), ...overrides,
    };
    window.sentCards = [];
    ws = { readyState: WebSocket.OPEN, send: message => window.sentCards.push(JSON.parse(message)), close() {} };
    prevTurn = 0;
    playerName = 'Alex';
    handleMessage({ type: 'state', state });
  }, { screen, hand, overrides, gameId: `fixture-${++gameNumber}` });
  await page.mouse.move(0, 0);
  const container = page.locator(`#${screen}-hand`);
  if (await container.isVisible()) await container.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return container;
}

async function expectHandFits(hand, count) {
  await expect(hand.locator('.hand-card')).toHaveCount(count);
  await expect.poll(() => hand.evaluate(el => [...el.querySelectorAll('.hand-card')].every(card => card.style.left !== ''))).toBe(true);
  const layout = await hand.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll('.hand-card')];
    return {
      client: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).overflowX,
      pageFits: document.documentElement.scrollWidth <= innerWidth,
      cards: cards.map((card, i) => {
        const rect = card.getBoundingClientRect();
        const next = cards[i + 1]?.getBoundingClientRect();
        return {
          width: rect.width,
          inside: rect.left >= bounds.left && rect.right <= bounds.right && rect.left >= 0 && rect.right <= innerWidth,
          font: parseFloat(getComputedStyle(card.querySelector('.card-corner')).fontSize),
          glyphsVisible: [...card.querySelector('.card-corner').children].every(glyph => {
            const g = glyph.getBoundingClientRect();
            const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
            return g.left >= rect.left && g.right <= rect.right && (!next || g.right <= next.left)
              && hit?.closest('.hand-card') === card;
          }),
        };
      }),
    };
  });
  expect(layout.scroll).toBeLessThanOrEqual(layout.client);
  expect(layout.pageFits).toBe(true);
  expect(['hidden', 'clip']).not.toContain(layout.overflow);
  for (const card of layout.cards) {
    expect(card.width).toBeGreaterThanOrEqual(52);
    expect(card.font).toBeGreaterThanOrEqual(11.8);
    expect(card.inside).toBe(true);
    expect(card.glyphsVisible).toBe(true);
  }
}

async function point(page, index) {
  return page.locator('#play-hand .hand-card').nth(index).evaluate(card => {
    const r = card.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height * 0.65 };
  });
}
async function sent(page) { return page.evaluate(() => window.sentCards); }
async function touch(page, points, end = 'touchEnd', delay = 20) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...points[0], id: 1 }] });
  for (const p of points.slice(1)) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
    await page.waitForTimeout(delay);
  }
  await session.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
  await session.detach();
}
function upward(p, distance = 72) { return [p, { x: p.x, y: p.y - 20 }, { x: p.x, y: p.y - distance }]; }

for (const screen of ['bidding', 'partner', 'play']) for (const width of [320, 390, 768, 1024, 1366, 1920]) {
  test(`${screen}: exposed corners and all cards fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const counts of distributions) {
      const hand = await showHand(page, screen, counts);
      await expectHandFits(hand, counts.reduce((sum, n) => sum + n, 0));
    }
  });
}

test('overlap increases with hand size and adjusts on resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overlap = () => page.locator('#play-hand').evaluate(el => {
    const cards = el.querySelectorAll('.hand-card'); return cards[0].getBoundingClientRect().right - cards[1].getBoundingClientRect().left;
  });
  await showHand(page, 'play', [1, 1, 1, 0]);
  const short = await overlap();
  const hand = await showHand(page);
  expect(await overlap()).toBeGreaterThan(short);
  for (const [width, height] of [[320, 844], [844, 390], [768, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await hand.scrollIntoViewIfNeeded();
    await expectHandFits(hand, 13);
  }
});

test('spectator full-board fans fit and cannot play', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const allHands = distributions.slice(0, 4).map(counts => Object.fromEntries(suits.map((s, i) => [s, ranks.slice(0, counts[i])])));
  for (const screen of ['bidding', 'partner', 'play']) {
    await showHand(page, screen, fullHand, { isSpectator: true, watchingSeat: -2, allHands });
    const hands = page.locator(`#${screen}-fullboard .card-hand`);
    await expect(hands).toHaveCount(4);
    for (let i = 0; i < 4; i++) { await hands.nth(i).scrollIntoViewIfNeeded(); await expectHandFits(hands.nth(i), 13); }
    expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(false);
    expect(await sent(page)).toEqual([]);
  }
});

for (const width of [768, 1024]) test(`desktop hover magnifies and each exposed card clicks once at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  for (let i = 0; i < 13; i++) {
    const hand = await showHand(page);
    const card = hand.locator('.hand-card').nth(i);
    const expected = await card.evaluate(el => `${el.dataset.value} ${el.dataset.suit}`);
    const p = await point(page, i);
    await page.mouse.move(p.x, p.y);
    await expect(hand.locator('.hand-preview')).toBeVisible();
    expect((await hand.locator('.hand-preview').boundingBox()).width).toBeGreaterThan((await card.boundingBox()).width);
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    expect(await sent(page)).toEqual([{ type: 'playCard', card: expected }]);
  }
});

test('mouse drags, right clicks and invalid cards do not play', async ({ page }) => {
  await showHand(page, 'play', fullHand, { currentSuit: '♣' });
  const p = await point(page, 0);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + 50, p.y - 20, { steps: 4 }); await page.mouse.up();
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const invalid = await point(page, 4); await page.mouse.click(invalid.x, invalid.y);
  expect(await sent(page)).toEqual([]);
});

test('keyboard arrows, Home/End, Escape and Enter/Space are accessible', async ({ page }) => {
  const hand = await showHand(page);
  await hand.locator('.hand-card').first().focus();
  await page.keyboard.press('ArrowRight'); await expect(hand.locator('.hand-card').nth(1)).toBeFocused();
  await page.keyboard.press('End'); await expect(hand.locator('.hand-card').last()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(hand.locator('.hand-preview')).toBeHidden();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  expect(await sent(page)).toEqual([{ type: 'playCard', card: 'A ♣' }]);
  await showHand(page); await hand.locator('.hand-card').first().focus(); await page.keyboard.press('Space');
  expect(await sent(page)).toHaveLength(1);
});

test('authoritative guards cover pending, unrelated states, errors, turn, membership and connection', async ({ page }) => {
  await showHand(page);
  expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(true);
  await page.evaluate(() => handleMessage({ type: 'state', state: { ...gameState, players: gameState.players.map(p => ({ ...p })) } }));
  expect(await page.evaluate(() => onPlayCard('K', '♣'))).toBe(false);
  await page.evaluate(() => handleMessage({ type: 'error', message: 'Rejected test action' }));
  expect(await page.evaluate(() => onPlayCard('K', '♣'))).toBe(true);
  await page.evaluate(() => {
    handleMessage({ type: 'state', state: { ...gameState, turn: 1,
      hand: { ...gameState.hand, '♣': gameState.hand['♣'].filter(value => value !== 'K') } } });
    handleMessage({ type: 'state', state: { ...gameState, turn: 0 } });
  });
  expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(true);
  for (const overrides of [{ turn: 1 }, { isSpectator: true }, { trickComplete: true }, { currentSuit: '♦' }, { playedCards: ['A ♣', null, null, null] }]) {
    await showHand(page, 'play', fullHand, overrides);
    expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(false); expect(await sent(page)).toEqual([]);
  }
  await showHand(page); expect(await page.evaluate(() => onPlayCard('2', '♣'))).toBe(false);
  await page.evaluate(() => { ws.readyState = WebSocket.CLOSED; }); expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(false);
  await page.evaluate(() => { ws.readyState = WebSocket.OPEN; awaitingGameState = true; });
  expect(await page.evaluate(() => onPlayCard('A', '♣'))).toBe(false);
});

test('reduced motion disables hand transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const hand = await showHand(page);
  expect(await hand.locator('.hand-card').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
});

test.describe('real touch and hybrid pointer flows', () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({ page }) => page.setViewportSize({ width: 390, height: 844 }));

  test('tap selects and magnifies; release and compatibility clicks never play', async ({ page }) => {
    const hand = await showHand(page); const p = await point(page, 0);
    await page.touchscreen.tap(p.x, p.y); await expect(hand.locator('.hand-preview')).toBeVisible();
    await hand.locator('.hand-card').first().dispatchEvent('click', { detail: 1 });
    await hand.locator('.hand-card').first().dispatchEvent('click', { detail: 0 });
    expect(await sent(page)).toEqual([]);
  });
  test('touch compatibility clicks stay blocked across a server rerender', async ({ page }) => {
    await showHand(page);
    const p = await point(page, 0);
    await page.touchscreen.tap(p.x, p.y);
    await page.evaluate(() => handleMessage({ type: 'state', state: { ...gameState } }));
    await page.locator('#play-hand .hand-card').first().dispatchEvent('click', { detail: 0 });
    expect(await sent(page)).toEqual([]);
  });
  test('hold, slide to another card, then swipe up plays the newly selected card once', async ({ page }) => {
    await showHand(page); const start = await point(page, 0); const target = await point(page, 7);
    await touch(page, [start, { x: start.x + 25, y: start.y }, target, ...upward(target).slice(1)]);
    expect(await sent(page)).toEqual([{ type: 'playCard', card: 'A ♥' }]);
    await page.locator('#play-hand .hand-card').nth(7).dispatchEvent('click', { detail: 1, pointerType: 'touch' });
    expect(await sent(page)).toHaveLength(1);
  });
  for (const distance of [0, 12, 40, 55]) test(`upward movement of ${distance}px does not play`, async ({ page }) => {
    await showHand(page); const p = await point(page, 0);
    await touch(page, [p, { x: p.x, y: p.y - distance }]); expect(await sent(page)).toEqual([]);
  });
  test('a 56px upward swipe plays on release', async ({ page }) => {
    await showHand(page); const p = await point(page, 0); p.y = Math.round(p.y);
    await touch(page, upward(p, 56)); expect(await sent(page)).toEqual([{ type: 'playCard', card: 'A ♣' }]);
  });
  test('horizontal browse, downward scroll and off-axis drags do not play', async ({ page }) => {
    for (const direction of ['horizontal', 'down', 'diagonal', 'return']) {
      await showHand(page); const p = await point(page, 0);
      const points = direction === 'horizontal' ? [p, await point(page, 10)] : direction === 'down' ? [p, { x: p.x, y: p.y + 70 }]
        : direction === 'diagonal' ? [...upward(p).slice(0, 2), { x: p.x + 65, y: p.y - 80 }]
          : [...upward(p), { x: p.x, y: p.y - 10 }];
      await touch(page, points); expect(await sent(page)).toEqual([]);
    }
  });
  for (const overrides of [{ currentSuit: '♦' }, { turn: 1 }, { isSpectator: true }, { trickComplete: true }]) {
    test(`upward swipe respects ${JSON.stringify(overrides)}`, async ({ page }) => {
      await showHand(page, 'play', fullHand, overrides); await touch(page, upward(await point(page, 0)));
      expect(await sent(page)).toEqual([]);
    });
  }
  for (const cancellation of ['pointercancel', 'lostcapture', 'resize', 'scroll', 'blur', 'new-state', 'second-pointer']) {
    test(`${cancellation} cancels an armed gesture`, async ({ page }) => {
      const hand = await showHand(page); const p = await point(page, 0);
      await hand.evaluate(element => element.addEventListener('pointerdown', event => { window.testPointerId = event.pointerId; }, { once: true }));
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y - 72, id: 1 }] });
      await expect(hand).toHaveClass(/swipe-ready/);
      if (cancellation === 'pointercancel') await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      else if (cancellation === 'lostcapture') await hand.evaluate(element => element.releasePointerCapture(window.testPointerId));
      else if (cancellation === 'resize') await page.setViewportSize({ width: 844, height: 390 });
      else if (cancellation === 'scroll') await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
      else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (cancellation === 'new-state') await page.evaluate(() => handleMessage({ type: 'state', state: { ...gameState, turn: 1 } }));
      else await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y - 72, id: 1 }, { x: p.x + 50, y: p.y, id: 2 }] });
      if (cancellation !== 'pointercancel') await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
      expect(await sent(page)).toEqual([]); await expect(hand).not.toHaveClass(/swipe-ready/);
    });
  }
  test('mouse clicks still work immediately after touch on a hybrid device', async ({ page }) => {
    await showHand(page); const p = await point(page, 0); await page.touchscreen.tap(p.x, p.y);
    expect(await sent(page)).toEqual([]); const mouse = await point(page, 1); await page.mouse.click(mouse.x, mouse.y);
    expect(await sent(page)).toEqual([{ type: 'playCard', card: 'K ♣' }]);
  });
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
    test(`magnifier stays on screen without covering corners at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const hand = await showHand(page);
      for (const index of [0, 6, 12]) {
        const p = await point(page, index);
        await page.touchscreen.tap(p.x, p.y);
        const preview = await hand.locator('.hand-preview').boundingBox();
        expect(preview.x).toBeGreaterThanOrEqual(0);
        expect(preview.y).toBeGreaterThanOrEqual(0);
        expect(preview.x + preview.width).toBeLessThanOrEqual(viewport.width);
        expect(preview.y + preview.height).toBeLessThanOrEqual(viewport.height);
        await expectHandFits(hand, 13);
      }
    });
    test(`last card is selectable by swipe at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport); await showHand(page); await touch(page, upward(await point(page, 12)));
      expect(await sent(page)).toEqual([{ type: 'playCard', card: 'Q ♠' }]);
    });
  }
});

test('capture review screenshots', async ({ page, browser }) => {
  const version = process.env.HAND_FAN_CAPTURE;
  test.skip(!version, 'Set HAND_FAN_CAPTURE=before or after for review screenshots.');
  const directory = path.join(__dirname, '../../docs/hand-fan'); await fs.mkdir(directory, { recursive: true });
  for (const [screen, width, height] of [['play', 320, 740], ['play', 390, 844], ['play', 844, 390], ['play', 1024, 900], ['bidding', 390, 1000], ['partner', 390, 1100]]) {
    const coarse = width < 768 || height < 500;
    const context = coarse ? await browser.newContext({ viewport: { width, height }, hasTouch: true }) : null;
    const capture = context ? await context.newPage() : page;
    if (context) await initializePage(capture); else await capture.setViewportSize({ width, height });
    const hand = await showHand(capture, screen);
    if (version === 'after') {
      if (coarse) {
        const box = await hand.locator('.card').first().boundingBox();
        await capture.touchscreen.tap(box.x + 8, box.y + 40);
      } else await hand.locator('.card').first().hover({ position: { x: 8, y: 40 } });
    }
    await capture.waitForTimeout(150);
    await capture.screenshot({ path: path.join(directory, `${version}-${screen}-${width}.png`), fullPage: height >= 500 });
    if (context) await context.close();
  }
});

test('record synthetic touch interaction', async ({ browser }) => {
  test.skip(!process.env.HAND_FAN_RECORD, 'Opt-in actual browser recording.');
  const directory = path.join(__dirname, '../../docs/hand-fan'); await fs.mkdir(directory, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
    recordVideo: { dir: path.join(directory, 'recording'), size: { width: 390, height: 844 } } });
  const page = await context.newPage(); await initializePage(page); await showHand(page); await page.waitForTimeout(600);
  const start = await point(page, 0); await page.touchscreen.tap(start.x, start.y); await page.waitForTimeout(800);
  expect(await sent(page)).toEqual([]); const target = await point(page, 7);
  await touch(page, [start, { x: start.x + 30, y: start.y }, { x: start.x + 80, y: start.y }, target, ...upward(target).slice(1)], 'touchEnd', 180);
  expect(await sent(page)).toEqual([{ type: 'playCard', card: 'A ♥' }]); await page.waitForTimeout(1000);
  const video = page.video(); await context.close(); await video.saveAs(path.join(directory, 'touch-select-slide-swipe.webm')); await video.delete();
});
