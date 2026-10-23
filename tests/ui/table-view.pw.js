const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('./serve.cjs');
const { tablePoint, dragPoints } = require('./touch-drag.cjs');

const origin = 'http://127.0.0.1:4186';
test.use({ baseURL: origin });
const suits = ['\u2663', '\u2666', '\u2665', '\u2660'];
const hand = { [suits[0]]: ['A', 'K', 'Q', '10'], [suits[1]]: ['A', 'J', '8'], [suits[2]]: ['K', '9', '7'], [suits[3]]: ['Q', '8', '2'] };
let server;
let fixtureNumber = 0;
test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(4186, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto('/bridge/');
});

async function showFixture(page, phase = 'play', overrides = {}) {
  await page.evaluate(({ phase, hand, overrides, gameId }) => {
    window.sentMoves = [];
    ws = { readyState: WebSocket.OPEN, send: message => window.sentMoves.push(JSON.parse(message)) };
    roomCode = 'DEMO';
    playerName = 'Alex';
    prevTurn = 0;
    gameState = {
      phase, roomCode, gameId, hand, mySeat: 0, turn: 0, bid: 7, bidder: 0,
      trumpSuit: '\u2665', trumpBroken: true, partnerCard: 'A \u2660', partnerSeat: -1,
      playedCards: [null, 'J \u2663', '7 \u2663', '9 \u2663'], currentSuit: '\u2663',
      sets: [2, 1, 2, 1], setsNeeded: 8, bidHistory: [{ name: 'Alex', bidNum: 7 }],
      isSpectator: false, spectators: [], isPractice: false, readySeats: [],
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })),
      allInitialHands: [hand, hand, hand, hand], allFinalHands: [hand, hand, hand, hand],
      ...(phase === 'gameover' ? { sets: [5, 2, 3, 3], partnerSeat: 2 } : {}),
      ...overrides,
    };
    lastGameOver = phase === 'gameover' ? { winnerNames: ['Alex', 'Casey'], bidderWon: true, _soundPlayed: true } : null;
    showScreen(`screen-${phase}`);
    handleMessage({ type: 'state', state: gameState });
  }, { phase, hand, overrides, gameId: `view-fixture-${++fixtureNumber}` });
  await page.mouse.move(0, 0);
}

async function baselineMarkup() {
  let baseline = await fs.readFile(path.join(__dirname, 'fixtures/classic-5ab300a.html'), 'utf8');
  const current = await fs.readFile(path.join(__dirname, '../../static/bridge/index.html'), 'utf8');
  // Keep any independent renderer scripts when the hand PR is integrated.
  const extraScripts = [...current.matchAll(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g)]
    .map(match => match[0]).filter(tag => !tag.includes('/view.js') && !baseline.includes(tag));
  baseline = baseline.replace('<script src="/app.js"></script>', `${extraScripts.join('\n')}\n<script src="/app.js"></script>`);
  return baseline;
}

async function touchPlay(page, card) {
  if (!await card.evaluate(el => el.closest('.hand-fan') !== null)) return card.tap();
  await card.scrollIntoViewIfNeeded();
  const point = await card.evaluate(el => {
    for (const glyph of el.querySelectorAll('.card-corner > span')) {
      const box = glyph.getBoundingClientRect();
      const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (document.elementFromPoint(point.x, point.y)?.closest('.card') === el) return point;
    }
    throw new Error('No exposed card corner');
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
  for (const p of dragPoints(point, await tablePoint(page))) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function clickHandCard(page, card) {
  if (!await card.evaluate(el => el.closest('.hand-fan') !== null)) return card.click();
  await card.scrollIntoViewIfNeeded();
  const point = await card.evaluate(el => {
    for (const glyph of el.querySelectorAll('.card-corner > span')) {
      const box = glyph.getBoundingClientRect();
      const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (document.elementFromPoint(point.x, point.y)?.closest('.card') === el) return point;
    }
    throw new Error('No exposed card corner');
  });
  await page.mouse.click(point.x, point.y);
}

async function switchView(page, mode) {
  await page.locator(`.view-picker:visible [data-table-view="${mode}"]`).click();
  await expect(page.locator('body')).toHaveAttribute('data-table-view', mode);
}

test('default, keyboard toggle, persistence, invalid preference and unavailable storage', async ({ page }) => {
  await expect(page.locator('body')).toHaveAttribute('data-table-view', 'classic');
  const toggle = page.getByRole('button', { name: '2.5D', exact: true }).filter({ visible: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-table-view', '25d');
  await page.evaluate(() => localStorage.setItem('bridge.tableView', 'invalid'));
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-table-view', 'classic');
  // Only the new preference is denied; existing app storage remains usable.
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'bridge.tableView') throw new Error('blocked'); return originalGet.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'bridge.tableView') throw new Error('blocked'); return originalSet.call(this, key, value); };
  });
  await page.reload();
  await switchView(page, '25d');
});

test('mid-trick switches retain exact state, socket, cards, scroll, input and legality', async ({ page }) => {
  await showFixture(page);
  await page.locator('#play-chat-log + .chat-input-row input').fill('Draft message');
  await page.evaluate(() => {
    window.originalState = gameState;
    window.originalSocket = ws;
    window.originalCards = [...document.querySelectorAll('#play-hand .card')];
  });
  for (const mode of ['25d', 'classic', '25d', 'classic']) {
    await switchView(page, mode);
    expect(await page.evaluate(() => gameState === window.originalState && ws === window.originalSocket && window.originalCards.every((card, i) => document.querySelectorAll('#play-hand .card')[i] === card))).toBe(true);
    await expect(page.locator('#play-hand .disabled')).toHaveCount(9);
    await expect(page.locator('#play-chat-log + .chat-input-row input')).toHaveValue('Draft message');
    expect(await page.evaluate(() => sentMoves)).toEqual([]);
  }
  await clickHandCard(page, page.locator('#play-hand .card:not(.disabled)').first());
  expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
});

for (const width of [320, 390, 768, 1366]) {
  test(`all phases in both views fit at ${width}px and actions remain single`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['classic', '25d']) {
      for (const phase of ['lobby', 'bidding', 'partner', 'play', 'gameover']) {
        await showFixture(page, phase);
        await switchView(page, mode);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const buttons = page.locator('#top-bar .view-picker');
        const leave = page.locator('#btn-leave-global');
        const a = await buttons.boundingBox();
        const b = await leave.boundingBox();
        expect(a.x + a.width).toBeLessThanOrEqual(b.x);
        if (phase === 'bidding') {
          await page.locator('#bid-grid button:not(:disabled)').first().click();
          expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'bid', bidNum: 8 }]);
        }
        if (phase === 'partner') {
          await page.locator('#partner-grid button:not(:disabled)').first().click();
          expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'selectPartner', card: 'A \u2665' }]);
        }
        if (phase === 'play') {
          await clickHandCard(page, page.locator('#play-hand .card:not(.disabled)').first());
          expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
          if (mode === '25d') {
            const labels = await page.locator('#play-table .seat-label').all();
            const cards = await page.locator('#trick-area .card-mini').all();
            for (const label of labels) for (const card of cards) {
              const l = await label.boundingBox(); const c = await card.boundingBox();
              expect(l.x >= c.x + c.width || c.x >= l.x + l.width || l.y >= c.y + c.height || c.y >= l.y + l.height).toBe(true);
            }
          }
        }
      }
    }
  });
}

test('Classic game pixels match master and restore exactly after a switch', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const baselineHtml = await baselineMarkup();
  await page.route(`${origin}/bridge/`, route => route.fulfill({ contentType: 'text/html', body: baselineHtml }));
  await page.goto('/bridge/');
  await showFixture(page);
  const before = await page.locator('.play-container').screenshot({ animations: 'disabled' });
  await page.unroute(`${origin}/bridge/`);
  await page.goto('/bridge/');
  await showFixture(page);
  const classic = await page.locator('.play-container').screenshot({ animations: 'disabled' });
  expect(classic.equals(before)).toBe(true);
  await switchView(page, '25d');
  await switchView(page, 'classic');
  let restored;
  try {
    await expect.poll(async () => {
      restored = await page.locator('.play-container').screenshot({ animations: 'disabled' });
      return restored.equals(before);
    }).toBe(true);
  } catch (error) {
    await test.info().attach('classic-baseline', { body: before, contentType: 'image/png' });
    await test.info().attach('classic-restored', { body: restored, contentType: 'image/png' });
    throw error;
  }
});

test('2.5D legal cards are keyboard accessible without duplicate or illegal moves', async ({ page }) => {
  await showFixture(page);
  await switchView(page, '25d');
  const ace = page.locator('#play-hand .card:not(.disabled)').first();
  await ace.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
  await page.evaluate(() => { window.sentMoves = []; });
  await ace.dispatchEvent('keydown', { key: 'Enter', repeat: true });
  expect(await page.evaluate(() => sentMoves)).toEqual([]);
  await showFixture(page);
  await ace.focus();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
  await expect(page.locator('#play-hand .disabled[tabindex="0"]')).toHaveCount(0);
  await showFixture(page, 'play', { turn: 1 });
  await expect(page.locator('#play-hand [data-view-keyboard]')).toHaveCount(0);
});

test('production WebSocket handlers continue receiving states and send one play across view switches', async ({ page }) => {
  await showFixture(page);
  const initialState = await page.evaluate(() => JSON.parse(JSON.stringify(gameState)));
  const messages = [];
  let connections = 0;
  let closes = 0;
  let peer;
  await page.routeWebSocket('**/api/ws**', socket => {
    connections++;
    peer = socket;
    socket.onClose(() => { closes++; });
    socket.onMessage(data => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type === 'join') socket.send(JSON.stringify({ type: 'state', state: initialState }));
    });
  });
  await page.evaluate(() => { ws = null; connect(); });
  await expect.poll(() => messages.filter(message => message.type === 'join').length).toBe(1);
  for (const mode of ['25d', 'classic', '25d']) await switchView(page, mode);
  await clickHandCard(page, page.locator('#play-hand .card:not(.disabled)').first());
  await expect.poll(() => messages.filter(message => message.type === 'playCard')).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
  peer.send(JSON.stringify({ type: 'state', state: { ...initialState, turn: 1, playedCards: ['A \u2663', 'J \u2663', '7 \u2663', '9 \u2663'] } }));
  await expect(page.locator('#seat-left-label')).toHaveClass(/active-turn/);
  await expect(page.locator('#play-hand [data-view-keyboard]')).toHaveCount(0);
  expect(connections).toBe(1);
  expect(closes).toBe(0);
});

test('native card controls keep their own labels, roving focus and single keyboard action', async ({ page }) => {
  await showFixture(page);
  await switchView(page, '25d');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.className = 'card';
    button.tabIndex = -1;
    button.setAttribute('aria-label', 'Native card renderer');
    button.innerHTML = '<span class="card-value">A</span><span class="card-suit">\u2663</span>';
    button.addEventListener('click', () => sentMoves.push({ type: 'nativePlay' }));
    document.getElementById('play-hand').replaceChildren(button);
  });
  const card = page.getByRole('button', { name: 'Native card renderer' });
  await expect(card).toHaveAttribute('tabindex', '-1');
  await expect(card).not.toHaveAttribute('data-view-keyboard');
  await card.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'nativePlay' }]);
  await switchView(page, 'classic');
  await expect(card).toHaveAttribute('aria-label', 'Native card renderer');
});

test.describe('touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('scroll and toggle mid-game preserve cards and touch activation sends once', async ({ page }) => {
    await showFixture(page, 'play', { currentSuit: null });
    const handEl = page.locator('#play-hand');
    await handEl.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const scroll = await handEl.evaluate(el => el.scrollLeft);
    await switchView(page, '25d');
    expect(await handEl.evaluate(el => el.scrollLeft)).toBe(scroll);
    await touchPlay(page, handEl.locator('.card').last());
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '2 \u2660' }]);
    await showFixture(page, 'play', { currentSuit: null });
    await switchView(page, 'classic');
    await touchPlay(page, handEl.locator('.card').first());
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: 'A \u2663' }]);
  });
});

test('reduced motion, practice, full-board spectators and out-of-turn play', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await switchView(page, '25d');
  await showFixture(page, 'play', { isPractice: true, turn: 1 });
  await expect(page.locator('#play-table')).toHaveClass(/practice/);
  expect(await page.locator('#play-table').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  await clickHandCard(page, page.locator('#play-hand .card').first());
  expect(await page.evaluate(() => sentMoves)).toEqual([]);
  for (const phase of ['bidding', 'partner', 'play']) {
    await showFixture(page, phase, { isSpectator: true, watchingSeat: -2, allHands: [hand, hand, hand, hand] });
    await expect(page.locator(`#${phase}-fullboard .card-hand`)).toHaveCount(4);
    await expect(page.locator(`#${phase}-hand-section`)).toBeHidden();
    expect(await page.evaluate(() => sentMoves)).toEqual([]);
  }
});

test('last trick, completed trick and long seat names do not cover the hand on narrow screens', async ({ page }) => {
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await showFixture(page, 'play', {
      mySeat: 2, turn: 2, trickComplete: true, playedCards: ['A \u2663', 'J \u2663', '7 \u2663', '9 \u2663'],
      lastTrick: { cards: ['K \u2666', '10 \u2666', '2 \u2666', '3 \u2666'], winner: 0 },
      players: ['Alexandra Example', 'Blair Longplayername', 'Casey Anotherplayer', 'Drew Sampleplayer'].map((name, seat) => ({ name, seat, connected: true })),
    });
    await switchView(page, '25d');
    const panel = await page.locator('#last-trick-panel').boundingBox();
    const handBox = await page.locator('#play-hand-section').boundingBox();
    expect(panel.y + panel.height).toBeLessThanOrEqual(handBox.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const label of await page.locator('#play-table .seat-label').all()) {
      const l = await label.boundingBox();
      for (const card of await page.locator('#trick-area .card-mini').all()) {
        const c = await card.boundingBox();
        expect(l.x >= c.x + c.width || c.x >= l.x + l.width || l.y >= c.y + c.height || c.y >= l.y + l.height).toBe(true);
      }
    }
  }
});

test('capture actual synthetic browser screenshots for review', async ({ page }) => {
  const capture = process.env.VIEW_CAPTURE;
  test.skip(!capture, 'Set VIEW_CAPTURE=early or final to refresh screenshot evidence.');
  const directory = path.join(__dirname, '../../docs/table-view', capture);
  await fs.mkdir(directory, { recursive: true });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const baselineHtml = await baselineMarkup();
    await page.route(`${origin}/bridge/`, route => route.fulfill({ contentType: 'text/html', body: baselineHtml }));
    await page.goto('/bridge/');
    await showFixture(page);
    await page.screenshot({ path: path.join(directory, `before-play-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.unroute(`${origin}/bridge/`);
    await page.goto('/bridge/');
    for (const phase of ['lobby', 'bidding', 'partner', 'play', 'gameover']) {
      await showFixture(page, phase);
      for (const mode of ['classic', '25d']) {
        if (mode === 'classic' && phase !== 'play') continue;
        await switchView(page, mode);
        await page.screenshot({ path: path.join(directory, `${mode}-${phase}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await showFixture(page, 'play', { lastTrick: { cards: ['K \u2666', '10 \u2666', '2 \u2666', '3 \u2666'], winner: 0 } });
    await switchView(page, '25d');
    await page.screenshot({ path: path.join(directory, `25d-lasttrick-${width}.png`), fullPage: true, animations: 'disabled' });
  }
});
