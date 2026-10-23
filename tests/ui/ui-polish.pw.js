const { test, expect } = require('@playwright/test');
const { createServer } = require('./serve.cjs');
const { tablePoint, dragPoints } = require('./touch-drag.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const origin = 'http://127.0.0.1:4214';
let server;
test.use({ viewport: { width: 1366, height: 900 } });
test.beforeAll(async () => { server = createServer(); await new Promise(resolve => server.listen(4214, '127.0.0.1', resolve)); });
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(`${origin}/bridge/`);
});

async function fixture(page, mode) {
  await page.evaluate(mode => {
    document.querySelector(`[data-table-view="${mode}"]`).click();
    roomCode = 'DEMO'; playerName = 'Alex'; prevTurn = 0; pendingPlay = null; window.sentMoves = [];
    ws = { readyState: WebSocket.OPEN, send: value => sentMoves.push(JSON.parse(value)), close() {} };
    handleMessage({ type: 'state', state: {
      phase: 'play', roomCode, gameId: 'polish-fixture', mySeat: 0, turn: 0, bid: 7, bidder: 0,
      hand: { '♣': ['A', 'K', 'Q', '10'], '♦': ['A', 'J', '8'], '♥': ['K', '9', '7'], '♠': ['Q', '8', '2'] },
      trumpSuit: '♥', trumpBroken: true, partnerCard: 'A ♠', partnerSeat: -1,
      playedCards: [null, null, null, null], currentSuit: null, sets: [2, 1, 2, 1], setsNeeded: 8,
      bidHistory: [], isSpectator: false, spectators: [], isPractice: false, readySeats: [],
      players: ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true })),
    } });
  }, mode);
  await page.locator('#play-hand').scrollIntoViewIfNeeded();
  await page.locator('#play-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
}

async function lobby(page, mode) {
  await fixture(page, mode);
  await page.evaluate(() => {
    const s = structuredClone(gameState); s.phase = 'lobby'; s.mySeat = 1; s.groupId = 'synthetic-group';
    s.players = [
      { name: 'Alex', seat: 0, connected: true, elo: 1092, wins: 151, gamesPlayed: 278 },
      { name: 'Blair', seat: 1, connected: true, elo: 1054, wins: 74, gamesPlayed: 135 },
      { name: 'Casey with a long display name', seat: 2, connected: false, elo: 1000, wins: 8, gamesPlayed: 24, isGroupMember: false },
      { name: 'Practice partner', seat: 3, connected: true, isBot: true, botLevel: 'basic' },
    ]; handleMessage({ type: 'state', state: s });
  });
}

test('capture synthetic before/after UI evidence', async ({ browser }) => {
  test.skip(!process.env.UI_POLISH_CAPTURE, 'Opt-in visual recording');
  test.setTimeout(120000);
  const stage = process.env.UI_POLISH_CAPTURE;
  // Reproduce the immutable merged base, without replacing the working tree.
  const baseline = stage === 'before' ? Object.fromEntries(['app.js', 'hand.js', 'style.css', 'view.css'].map(file => [
    `/${file}`, execFileSync('git', ['show', `caf89d0033f37b8e43e0cabda3eb1711cd1e353a:static/${file}`], { encoding: 'utf8' }),
  ])) : {};
  const routeCapture = route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (baseline[url.pathname]) return route.fulfill({ body: baseline[url.pathname], contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    return url.pathname.startsWith('/api/') ? route.fulfill({ json: {} }) : route.continue();
  };
  const directory = path.join(__dirname, '../../docs/ui-polish'); await fs.mkdir(directory, { recursive: true });
  for (const mode of ['classic', '25d']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      recordVideo: { dir: path.join(directory, 'recording'), size: { width: 390, height: 844 } } });
    const page = await context.newPage();
    await page.route('**/*', routeCapture);
    await page.goto(`${origin}/bridge/`); await fixture(page, mode);
    await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTop = 0; });
    const p = await corner(page.locator('#play-hand .hand-card').nth(3)); const target = await tablePoint(page);
    const session = await context.newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
    await page.waitForTimeout(200); await touch('touchStart', p);
    let last = p;
    for (const end of [{ x: 300, y: p.y - 65 }, { x: 100, y: p.y - 90 }, { x: 300, y: p.y - 115 }, target]) {
      for (const step of dragPoints(last, end, 8)) { await touch('touchMove', step); await page.waitForTimeout(22); }
      await page.waitForTimeout(180); last = end;
    }
    await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
    await page.screenshot({ path: path.join(directory, `${stage}-${mode}-drop.png`) });
    await page.waitForTimeout(350);
    for (const step of dragPoints(target, p, 10)) { await touch('touchMove', step); await page.waitForTimeout(25); }
    await touch('touchEnd'); await expect(page.locator('.drag-proxy')).toHaveCount(0); await page.waitForTimeout(300);
    await session.detach(); const video = page.video(); await context.close();
    await video.saveAs(path.join(directory, `${stage}-${mode}-swing.webm`)); await video.delete();
    const lobbyPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await lobbyPage.route('**/*', routeCapture);
    await lobbyPage.goto(`${origin}/bridge/`); await lobby(lobbyPage, mode);
    await lobbyPage.waitForTimeout(400);
    await lobbyPage.screenshot({ path: path.join(directory, `${stage}-${mode}-lobby.png`) }); await lobbyPage.close();
  }
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 },
    recordVideo: { dir: path.join(directory, 'recording'), size: { width: 1366, height: 900 } } });
  const page = await desktop.newPage(); await page.route('**/*', routeCapture); await page.goto(`${origin}/bridge/`);
  for (const mode of ['classic', '25d']) {
    await fixture(page, mode); await page.waitForTimeout(350);
    for (const index of [3]) {
      const card = page.locator('#play-hand .hand-card').nth(index);
      const p = await corner(card); await page.mouse.move(p.x, p.y); await page.waitForTimeout(160);
      const click = await corner(card); await page.mouse.click(click.x, click.y);
      await page.evaluate(() => {
        const card = sentMoves.at(-1).card; const [value, suit] = card.split(' ');
        const s = structuredClone(gameState); s.hand[suit] = s.hand[suit].filter(v => v !== value);
        s.playedCards[0] = card; s.currentSuit = null; s.turn = 0; handleMessage({ type: 'state', state: s });
      });
      await page.waitForTimeout(450);
    }
    await page.mouse.move(0, 0); await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(directory, `${stage}-${mode}-desktop.png`) });
  }
  const video = page.video(); await desktop.close();
  await video.saveAs(path.join(directory, `${stage}-desktop-fan.webm`)); await video.delete();
});

async function corner(card) {
  return card.evaluate(el => {
    for (const glyph of el.querySelectorAll('.card-corner > span')) {
      const r = glyph.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === el) return p;
    }
    throw new Error('No exposed card corner');
  });
}

for (const mode of ['classic', '25d']) {
  test(`lobby labels safely preserve quoted player names ${mode}`, async ({ page }) => {
    await lobby(page, mode);
    const name = 'Alex "quoted" <img src=x onerror=alert(1)>';
    await page.evaluate(name => { const s = structuredClone(gameState); s.players[0].name = name; handleMessage({ type: 'state', state: s }); }, name);
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Ping ${name}`, exact: true })).toHaveText(name);
    await expect(page.locator('#lobby-players img')).toHaveCount(0);
  });
  for (const width of [320, 390, 1366]) {
    test(`lobby columns align and actions stay usable ${mode} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await lobby(page, mode);
      const rows = await page.locator('#lobby-players .player-item').evaluateAll(items => items.map(item => {
        const box = selector => { const r = item.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top, bottom: r.bottom }; };
        return { name: box('.lobby-player-name'), meta: box('.lobby-meta'), action: box('.lobby-action'), seat: box('.seat-num'), status: box('.status-dot'), row: item.getBoundingClientRect().toJSON() };
      }));
      for (const row of rows.slice(0, 3)) {
        expect(Math.abs(row.name.x - rows[0].name.x)).toBeLessThan(1);
        expect(Math.abs(row.meta.x - rows[0].meta.x)).toBeLessThan(1);
        expect(Math.abs(row.action.right - rows[0].action.right)).toBeLessThan(1);
        expect(row.name.right).toBeLessThanOrEqual(row.action.x);
        expect(row.status.x - row.seat.right).toBeGreaterThanOrEqual(4);
        if (width < 601) expect(row.meta.top).toBeGreaterThanOrEqual(row.name.bottom - 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: 'Ping Alex', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove Blair', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Remove Alex', exact: true }).click();
      expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'kickPlayer', seat: 0 }]);
      await page.evaluate(() => { window.pingedSeat = null; pingPlayer = seat => { window.pingedSeat = seat; }; });
      await page.getByRole('button', { name: 'Ping Alex', exact: true }).click();
      expect(await page.evaluate(() => pingedSeat)).toBe(0);
    });
  }

  test(`keyboard focus follows the nearest remaining card ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    const card = page.locator('#play-hand .hand-card').nth(3); await card.focus(); await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const s = structuredClone(gameState); s.hand['♣'] = s.hand['♣'].filter(v => v !== '10');
      s.turn = 1; s.playedCards[0] = '10 ♣'; handleMessage({ type: 'state', state: s });
    });
    await expect(page.locator('#play-hand .hand-card').nth(3)).toBeFocused();
    await expect(page.locator('#play-hand .hand-card[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('ArrowRight'); await expect(page.locator('#play-hand .hand-card').nth(4)).toBeFocused();
    await page.keyboard.press('Enter'); expect(await page.evaluate(() => sentMoves.length)).toBe(1);
  });

  test(`touch reversal swings visibly around an attached grip ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await fixture(page, mode);
    const p = await corner(page.locator('#play-hand .hand-card').nth(3)); const session = await page.context().newCDPSession(page);
    const touch = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
    await touch('touchStart', p); const samples = [];
    for (const x of [300, 90, 300, 90]) {
      await touch('touchMove', { x, y: p.y - 90 });
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(30);
        samples.push(await page.locator('.drag-proxy').evaluate((el, point) => {
          const m = new DOMMatrix(getComputedStyle(el).transform); const o = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat);
          return { angle: Math.atan2(m.b, m.a) * 180 / Math.PI, gripError: Math.hypot(m.e + o[0] - point.x, m.f + o[1] - point.y) };
        }, { x, y: p.y - 90 }));
      }
    }
    const angles = samples.map(s => s.angle);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(10);
    for (const s of samples) { expect(Math.abs(s.angle)).toBeLessThanOrEqual(38.01); expect(s.gripError).toBeLessThan(1); }
    await touch('touchCancel'); await expect(page.locator('.drag-proxy')).toHaveCount(0);
    expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
  });

  for (const width of [390, 1366]) {
    test(`drop highlight and native hit area follow the felt ${mode} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await fixture(page, mode);
      const p = await corner(page.locator('#play-hand .hand-card').nth(3)); const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
      const target = await tablePoint(page);
      for (const point of dragPoints(p, target)) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] });
      await expect(page.locator('#play-table')).toHaveClass(/card-drop-ready/);
      expect(await page.locator('#play-table').evaluate(table => table.querySelector('.card-drop-label').getBoundingClientRect().top
        - table.querySelector('.seat-top .seat-label').getBoundingClientRect().bottom)).toBeGreaterThan(2);
      const geometry = await page.locator('.table-surface').evaluate(el => {
        const table = el.parentElement; const r = table.getBoundingClientRect(); const s = getComputedStyle(el);
        const m = new DOMMatrix(s.transform); const o = s.transformOrigin.split(' ').map(parseFloat);
        const b = parseFloat(s.borderTopWidth); const w = el.offsetWidth; const h = el.offsetHeight;
        const project = (x, y) => {
          const point = m.transformPoint(new DOMPoint(x - o[0], y - o[1]));
          return { x: r.left + table.clientLeft + el.offsetLeft + o[0] + point.x / point.w,
            y: r.top + table.clientTop + el.offsetTop + o[1] + point.y / point.w };
        };
        const zone = el.querySelector('.card-drop-zone');
        const hit = point => document.elementsFromPoint(point.x, point.y).includes(zone);
        const inside = [[w / 2, b + 3], [w / 2, h - b - 3], [b + 3, h / 2], [w - b - 3, h / 2]].map(([x, y]) => ({ point: project(x, y), hit: hit(project(x, y)) }));
        const outside = [[b + 1, b + 1], [w - b - 1, b + 1], [b + 1, h - b - 1], [w - b - 1, h - b - 1]].map(([x, y]) => ({ point: project(x, y), hit: hit(project(x, y)) }));
        return { inside, outside, transform: s.transform, background: s.backgroundImage, parent: zone.parentElement.className };
      });
      expect(geometry.parent).toBe('table-surface');
      if (mode === '25d') { expect(geometry.transform).not.toBe('none'); expect(geometry.background).toContain('radial-gradient'); }
      for (const point of geometry.inside) expect(point.hit, JSON.stringify(point)).toBe(true);
      for (const point of geometry.outside) expect(point.hit, JSON.stringify(point)).toBe(false);
      const outside = geometry.outside.find(v => v.point.y > 60 && v.point.y < 890).point;
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...outside, id: 1 }] });
      await expect(page.locator('#play-table')).not.toHaveClass(/card-drop-ready/);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      expect(await page.evaluate(() => sentMoves)).toEqual([]); await session.detach();
    });
  }

  test(`desktop play retains remaining nodes and a settled fan ${mode}`, async ({ page }) => {
    await fixture(page, mode);
    const card = page.locator('#play-hand .hand-card').nth(3);
    const hover = await corner(card); await page.mouse.move(hover.x, hover.y);
    await page.locator('#play-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
    const click = await corner(card); await page.mouse.click(click.x, click.y);
    expect(await page.evaluate(() => sentMoves)).toEqual([{ type: 'playCard', card: '10 ♣' }]);
    await page.evaluate(() => {
      window.remaining = [...document.querySelectorAll('#play-hand .hand-card')].filter(card => !(card.dataset.value === '10' && card.dataset.suit === '♣'));
      window.tableTop = document.querySelector('#play-table').getBoundingClientRect().top;
      window.handTop = document.querySelector('#play-hand').getBoundingClientRect().top;
      window.oldAngles = remaining.map(card => Math.atan2(new DOMMatrix(getComputedStyle(card).transform).b, new DOMMatrix(getComputedStyle(card).transform).a) * 180 / Math.PI);
      const s = structuredClone(gameState); s.hand['♣'] = s.hand['♣'].filter(v => v !== '10');
      s.playedCards[0] = '10 ♣'; s.currentSuit = '♣'; s.turn = 1; handleMessage({ type: 'state', state: s });
    });
    expect(await page.evaluate(() => remaining.every((card, i) => document.querySelectorAll('#play-hand .hand-card')[i] === card))).toBe(true);
    const samples = await page.evaluate(() => new Promise(resolve => {
      const frames = []; let count = 0;
      function sample() {
        frames.push({ table: document.querySelector('#play-table').getBoundingClientRect().top,
          hand: document.querySelector('#play-hand').getBoundingClientRect().top,
          angles: remaining.map(card => { const m = new DOMMatrix(getComputedStyle(card).transform); return Math.atan2(m.b, m.a) * 180 / Math.PI; }) });
        if (++count === 20) resolve(frames); else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }));
    const before = await page.evaluate(() => ({ tableTop, handTop, oldAngles }));
    for (const frame of samples) {
      expect(Math.abs(frame.table - before.tableTop)).toBeLessThan(1);
      expect(Math.abs(frame.hand - before.handTop)).toBeLessThan(1);
      frame.angles.forEach((angle, i) => expect(Math.abs(angle - before.oldAngles[i])).toBeLessThan(5));
    }
    await expect(page.locator('#play-hand .hand-card')).toHaveCount(12);
    await expect(page.locator('#play-hand .is-selected')).toHaveCount(0);
  });
}
