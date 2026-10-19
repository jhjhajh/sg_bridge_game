const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('./serve.cjs');

const suits = ['♣', '♦', '♥', '♠'];
const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const fullHand = [4, 3, 3, 3];
const distributions = [fullHand, [10, 1, 1, 1], [13, 0, 0, 0], [0, 6, 7, 0], [1, 1, 1, 0], [0, 0, 0, 1], [0, 0, 0, 0]];

let server;
test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(4174, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test.beforeEach(async ({ page }) => {
  // No real accounts, external widgets, APIs, or WebSocket connections.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4174') return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: {} });
    return route.continue();
  });
  await page.goto('/');
});

async function showHand(page, screen, counts = fullHand, currentSuit = null) {
  const hand = Object.fromEntries(suits.map((suit, i) => [suit, ranks.slice(0, counts[i])]));
  await page.evaluate(({ screen, hand, currentSuit }) => {
    const state = {
      hand, currentSuit, mySeat: 0, turn: 0, bid: 7, bidder: 0,
      trumpSuit: '♠', trumpBroken: true, partnerCard: '2 ♠', partnerSeat: -1,
      playedCards: [null, null, null, null], sets: [0, 0, 0, 0], bidHistory: [],
      isSpectator: false, spectators: [], isPractice: false,
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })),
    };
    window.sentCards = [];
    ws = { readyState: WebSocket.OPEN, send: message => window.sentCards.push(JSON.parse(message)) };
    prevTurn = 0; // Avoid turn notification audio in this deterministic fixture.
    playerName = 'Alex';
    showScreen(`screen-${screen}`);
    if (screen === 'bidding') renderBidding(state);
    else if (screen === 'partner') renderPartner(state);
    else renderPlay(state);
  }, { screen, hand, currentSuit });
  await page.mouse.move(0, 0);
  return page.locator(`#${screen}-hand`);
}

async function expectHandFits(hand, count) {
  await expect(hand.locator('.card')).toHaveCount(count);
  const layout = await hand.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll('.card')];
    return {
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      cards: cards.map((card, i) => {
        const rect = card.getBoundingClientRect();
        const next = cards[i + 1]?.getBoundingClientRect();
        return {
          width: rect.width,
          inside: rect.left >= bounds.left && rect.right <= bounds.right && rect.left >= 0 && rect.right <= innerWidth,
          glyphsVisible: [...card.children].every(glyph => {
            const g = glyph.getBoundingClientRect();
            return g.left >= rect.left && g.right <= rect.right && (!next || g.right <= next.left);
          }),
          top: rect.top,
        };
      }),
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  // Fit the content rather than concealing inaccessible cards.
  expect(['hidden', 'clip']).not.toContain(layout.overflowX);
  for (const card of layout.cards) {
    expect(card.width).toBeGreaterThanOrEqual(44);
    expect(card.inside).toBe(true);
    expect(card.glyphsVisible).toBe(true);
    expect(card.top).toBeCloseTo(layout.cards[0].top, 0);
  }
}

for (const screen of ['bidding', 'partner', 'play']) {
  for (const width of [768, 1024, 1366, 1920]) {
    test(`${screen}: hands fit and ranks stay readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const counts of distributions) {
        const hand = await showHand(page, screen, counts);
        await expectHandFits(hand, counts.reduce((sum, count) => sum + count, 0));
      }
    });
  }
}

test('hand adjusts when resizing between desktop widths and mobile', async ({ page }) => {
  const hand = await showHand(page, 'play');
  for (const width of [1920, 768, 1024, 767, 390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    if (width >= 768) await expectHandFits(hand, 13);
    else expect(await hand.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
  }
});

test('spectator full-board hands also fit the desktop panels', async ({ page }) => {
  const allHands = distributions.slice(0, 4).map(counts =>
    Object.fromEntries(suits.map((suit, i) => [suit, ranks.slice(0, counts[i])])));
  for (const screen of ['bidding', 'partner', 'play']) {
    for (const width of [768, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      await showHand(page, screen);
      await page.evaluate(({ screen, allHands }) => {
        renderFullBoardInto({
          isSpectator: true, watchingSeat: -2, turn: 0, allHands,
          players: ['Alex', 'Blair', 'Casey', 'Drew'].map(name => ({ name })),
        }, `${screen}-fullboard`, [`${screen}-hand-section`]);
      }, { screen, allHands });
      const hands = page.locator(`#${screen}-fullboard .card-hand`);
      await expect(hands).toHaveCount(4);
      for (let i = 0; i < 4; i++) await expectHandFits(hands.nth(i), 13);
    }
  }
});

for (const width of [768, 1024, 1920]) {
  test(`every exposed card can be hovered and selected at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const hand = await showHand(page, 'play');
    const cards = hand.locator('.card');
    const expected = [];
    for (let i = 0; i < 13; i++) {
      const card = cards.nth(i);
      const value = await card.locator('.card-value').textContent();
      const suit = await card.locator('.card-suit').textContent();
      expected.push({ type: 'playCard', card: `${value} ${suit}` });
      const before = await card.boundingBox();
      await card.hover();
      await expect.poll(async () => (await card.boundingBox()).y).toBeLessThan(before.y - 8);
      await card.click();
      await page.mouse.move(0, 0);
    }
    expect(await page.evaluate(() => window.sentCards)).toEqual(expected);
  });
}

test('disabled suits remain disabled and valid cards remain selectable', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const hand = await showHand(page, 'play', fullHand, '♣');
  await expect(hand.locator('.card.disabled')).toHaveCount(9);
  const disabled = hand.locator('.card.disabled').first();
  const box = await disabled.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => window.sentCards)).toEqual([]);
  await hand.locator('.card:not(.disabled)').first().click();
  expect(await page.evaluate(() => window.sentCards)).toEqual([{ type: 'playCard', card: 'A ♣' }]);
});

for (const width of [375, 390, 767]) {
  test(`mobile keeps its card sizes and touch scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const hand = await showHand(page, 'play');
    const first = hand.locator('.card').first();
    const layout = await hand.evaluate(el => ({
      client: el.clientWidth, scroll: el.scrollWidth, overflow: getComputedStyle(el).overflowX,
    }));
    expect(layout.overflow).toBe('auto');
    expect(layout.scroll).toBeGreaterThan(layout.client);
    expect((await first.boundingBox()).width).toBe(width <= 400 ? 40 : 60);
    // Scroll to the last card and verify it is still playable.
    await hand.locator('.card').last().click();
    expect(await page.evaluate(() => window.sentCards)).toEqual([{ type: 'playCard', card: 'Q ♠' }]);
  });
}

test('capture review screenshots', async ({ page }) => {
  const version = process.env.HAND_LAYOUT_CAPTURE;
  test.skip(!version, 'Set HAND_LAYOUT_CAPTURE=before or after to refresh review evidence.');
  const directory = path.join(__dirname, '../../docs/hand-layout');
  await fs.mkdir(directory, { recursive: true });
  for (const [screen, width, height] of [
    ['play', 768, 900], ['play', 1024, 900], ['play', 1366, 900],
    ['bidding', 1024, 900], ['partner', 1024, 1000], ['play', 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const hand = await showHand(page, screen);
    if (width >= 768) await hand.locator('.card').first().hover();
    // Let the existing hover animation settle before taking the real browser capture.
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(directory, `${version}-${screen}-${width}.png`), fullPage: true });
  }
});
