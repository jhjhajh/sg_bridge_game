const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('./serve.cjs');
const { tablePoint } = require('./touch-drag.cjs');
const origin = 'http://127.0.0.1:4208';
test.use({ baseURL: origin });
let server;
test.beforeAll(async () => { server = createServer(); await new Promise(resolve => server.listen(4208, '127.0.0.1', resolve)); });
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

async function fixture(page, mode, phase = 'play') {
  await page.evaluate(({ mode, phase }) => {
    document.querySelector(`[data-table-view="${mode}"]`).click();
    window.sentMoves = [];
    ws = { readyState: WebSocket.OPEN, send: value => sentMoves.push(JSON.parse(value)), close() {} };
    roomCode = 'DEMO'; playerName = 'Alex'; prevTurn = 0;
    handleMessage({ type: 'state', state: {
      phase, roomCode, gameId: 'stable-hand', mySeat: 0, turn: 0, bid: 7, bidder: 0,
      hand: { '♣': ['A', 'K', 'Q', '10'], '♦': ['A', 'J', '8'], '♥': ['K', '9', '7'], '♠': ['Q', '8', '2'] },
      trumpSuit: '♥', trumpBroken: true, partnerCard: 'A ♠', partnerSeat: -1,
      playedCards: [null, null, null, null], currentSuit: null, sets: [2, 1, 2, 1], setsNeeded: 8,
      bidHistory: [{ name: 'Alex', bidNum: 7 }], isSpectator: false, spectators: [], isPractice: false, readySeats: [],
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })),
    } });
  }, { mode, phase });
  const hand = page.locator(`#${phase}-hand`);
  if (await hand.count() && await hand.isVisible()) {
    await hand.scrollIntoViewIfNeeded();
    await hand.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
  }
}

async function cardPoint(page, index = 3) {
  return page.locator('#play-hand .hand-card').nth(index).evaluate(el => {
    for (const glyph of el.querySelectorAll('.card-corner > span')) {
      const r = glyph.getBoundingClientRect();
      const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === el) return p;
    }
    throw new Error('No exposed card corner');
  });
}

async function touch(session, type, p) {
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ ...p, id: 1 }] : [] });
}

for (const mode of ['classic', '25d']) {
  test(`chat screenshots ${mode}`, async ({ page }) => {
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page, mode, 'lobby');
      await page.evaluate(() => {
        for (const log of document.querySelectorAll('.inline-chat-log')) log.replaceChildren();
        for (let i = 1; i <= 14; i++) appendChatMessage(i % 2 ? 'Alex' : 'Blair', -1,
          i === 13 ? 'Long message wraps clearly: ' + 'bridge'.repeat(30) : `Synthetic table message ${i}. Ready for the next hand?`);
      });
      const panel = page.locator('#lobby-chat-log').locator('..');
      await panel.scrollIntoViewIfNeeded();
      await page.locator('#lobby-chat-log + .chat-input-row input').focus();
      // Capture a keyboard focus indicator, using only synthetic names/text.
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      const directory = path.join(__dirname, '../../docs/chat-input', process.env.CAPTURE_STAGE || 'after');
      await fs.mkdir(directory, { recursive: true });
      await panel.screenshot({ path: path.join(directory, `chat-${mode}-${width}.png`) });
    }
  });

  test(`unchanged hand retains nodes, hover, focus and settled geometry ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 1000 });
    await fixture(page, mode);
    await page.locator('#play-hand .hand-card').nth(3).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('#play-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
    await page.evaluate(() => {
      window.originalCards = [...document.querySelectorAll('#play-hand .hand-card')];
      window.originalFocus = document.activeElement;
      window.originalGeometry = originalCards.map(el => [el.style.cssText, getComputedStyle(el).transform]);
      window.originalSelected = document.querySelector('#play-hand .is-selected');
      window.handMutations = [];
      new MutationObserver(records => handMutations.push(...records.filter(r => r.type === 'childList')))
        .observe(document.querySelector('#play-hand'), { childList: true, subtree: true });
    });
    for (let i = 0; i < 8; i++) {
      await page.evaluate(i => {
        handleMessage({ type: i % 2 ? 'playerReconnected' : 'playerDisconnected', seat: 2, name: 'Casey' });
        const state = JSON.parse(JSON.stringify(gameState));
        state.bidHistory = [...state.bidHistory, { name: 'Blair', bidNum: i }];
        handleMessage({ type: 'state', state });
      }, i);
      const stable = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#play-hand .hand-card')];
        return cards.every((el, n) => el === originalCards[n] && el.style.cssText === originalGeometry[n][0]
          && getComputedStyle(el).transform === originalGeometry[n][1])
          && document.activeElement === originalFocus && document.querySelector('#play-hand .is-selected') === originalSelected
          && !cards.some(el => el.getAnimations().length) && !handMutations.length;
      });
      expect(stable).toBe(true);
    }
    // A genuine card change still renders the new hand.
    await page.evaluate(() => { const state = structuredClone(gameState); state.hand['♣'].shift(); handleMessage({ type: 'state', state }); });
    await expect(page.locator('#play-hand .hand-card')).toHaveCount(12);
  });

  test(`chat replay races, readable scroll anchors, wrapping and composer guards ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await fixture(page, mode, 'lobby');
    await page.evaluate(() => {
      resetRoomChat(roomCode, 'test');
      const message = n => ({ id: `test:${n}`, sequence: n, name: 'SyntheticLongPlayerName'.repeat(3), seat: -1, text: `${n} ` + 'unbrokenmessage'.repeat(10) });
      appendChatMessage('Live', -1, 'Arrived during snapshot', { roomCode, epoch: 'test', ...message(3) });
      restoreChatHistory({ roomCode, epoch: 'test', sequence: 2, messages: [message(1), message(2)] });
      window.message = message;
    });
    expect(await page.evaluate(() => chatMessages.map(m => m.sequence))).toEqual([1, 2, 3]);
    await page.evaluate(() => {
      for (let n = 4; n <= 50; n++) appendChatMessage(message(n).name, -1, message(n).text, { roomCode, epoch: 'test', ...message(n) });
    });
    const log = page.locator('#lobby-chat-log');
    await log.scrollIntoViewIfNeeded();
    expect(await log.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A reader midway through the log retains the same visible row/offset
    // even when the oldest retained entry is trimmed by a new arrival.
    await log.evaluate(el => {
      el.scrollTop = 450;
      const top = el.getBoundingClientRect().top;
      window.anchor = [...el.children].find(row => row.getBoundingClientRect().bottom > top);
      window.anchorTop = anchor.getBoundingClientRect().top;
    });
    await page.evaluate(() => appendChatMessage(message(51).name, -1, message(51).text, { roomCode, epoch: 'test', ...message(51) }));
    expect(await page.evaluate(() => Math.abs(anchor.getBoundingClientRect().top - anchorTop))).toBeLessThan(1);
    expect(await log.evaluate(el => el.dataset.follow)).toBe('false');
    await log.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.evaluate(() => appendChatMessage(message(52).name, -1, message(52).text, { roomCode, epoch: 'test', ...message(52) }));
    expect(await log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(1);
    await page.evaluate(() => {
      window.chatNodes = [...document.querySelectorAll('#lobby-chat-log .chat-msg')];
      restoreChatHistory({ roomCode, epoch: 'test', sequence: 52, messages: [...chatMessages] });
      appendChatMessage(message(52).name, -1, message(52).text, { roomCode, epoch: 'test', ...message(52) });
    });
    expect(await page.evaluate(() => chatNodes.every((row, i) => document.querySelectorAll('#lobby-chat-log .chat-msg')[i] === row))).toBe(true);
    const input = page.locator('#screen-lobby .chat-input-field');
    await input.fill('Composing');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await input.dispatchEvent('keydown', { key: 'Enter', repeat: true });
    expect(await page.evaluate(() => sentMoves)).toEqual([]);
    await input.press('Enter');
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'chat', text: 'Composing' }]);
    await input.press('Enter');
    expect(await page.evaluate(() => sentMoves.length)).toBe(1);
    await input.fill('Keep draft while offline');
    await page.evaluate(() => { ws.readyState = WebSocket.CLOSED; });
    await input.press('Enter'); await expect(input).toHaveValue('Keep draft while offline');
  });

  test(`real touch owns cards during metadata updates, outside still scrolls ${mode}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 620 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      return route.continue();
    });
    await page.goto('/bridge/'); await fixture(page, mode);
    // Make the document unquestionably scrollable in both directions. No touch CSS overrides.
    await page.evaluate(() => {
      const space = document.createElement('div'); space.style.height = '1000px'; document.body.append(space);
      document.querySelector('#play-hand').scrollIntoView({ block: 'center' });
    });
    const session = await context.newCDPSession(page);
    const startScroll = await page.evaluate(() => scrollY + document.body.scrollTop);
    expect(startScroll).toBeGreaterThan(0);
    const p = await cardPoint(page);
    const drop = await tablePoint(page);
    await touch(session, 'touchStart', p);
    await touch(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves)).toEqual([]);
    await touch(session, 'touchStart', p);
    await touch(session, 'touchMove', { x: p.x, y: p.y - 20 });
    await page.evaluate(() => { handleMessage({ type: 'playerReconnected', seat: 2, name: 'Casey' }); handleMessage({ type: 'state', state: structuredClone(gameState) }); });
    await touch(session, 'touchMove', drop);
    await touch(session, 'touchEnd');
    await expect.poll(() => page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '10 ♣' }]);
    expect(await page.evaluate(() => scrollY + document.body.scrollTop)).toBe(startScroll);
    // A second deliberate table drop while waiting must never send another action.
    await touch(session, 'touchStart', p);
    await touch(session, 'touchMove', drop); await touch(session, 'touchEnd');
    expect(await page.evaluate(() => sentMoves.length)).toBe(1);
    await page.evaluate(() => {
      document.body.scrollTop = document.body.scrollHeight - innerHeight - 500;
      window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 500);
    });
    const outsideScroll = await page.evaluate(() => scrollY + document.body.scrollTop);
    await touch(session, 'touchStart', { x: 12, y: 450 });
    for (const y of [420, 380, 320, 250]) await touch(session, 'touchMove', { x: 12, y });
    await touch(session, 'touchEnd');
    await expect.poll(() => page.evaluate(() => scrollY + document.body.scrollTop)).toBeGreaterThan(outsideScroll + 30);
    await session.detach(); await context.close();
  });
}
