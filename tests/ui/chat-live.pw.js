const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
const { tablePoint, dragPoints } = require('./touch-drag.cjs');
test.setTimeout(60000);
let worker;
test.beforeAll(async () => { worker = await startWorker(); });
test.afterAll(async () => { await worker?.stop(); });

async function room() {
  const response = await fetch(`${worker.origin}/api/create`, { method: 'POST', body: '{}' });
  expect(response.ok).toBe(true);
  return (await response.json()).roomCode;
}

async function client(browser, code, name, mode, mobile = false) {
  let hash = 0;
  for (const character of name) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const id = 900000000 + Math.abs(hash) % 90000000;
  await worker.db.prepare('INSERT OR IGNORE INTO users (telegram_id, display_name, created_at) VALUES (?, ?, ?)').bind(id, name, Date.now()).run();
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== worker.origin) return route.abort();
    // Auth/stats are unrelated to room chat. The room creation and every
    // WebSocket frame go through the actual local Worker and Durable Object.
    if (url.pathname.startsWith('/api/') && !['/api/create', '/api/ws'].includes(url.pathname)) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.addInitScript(({ code, name, mode, id }) => {
    localStorage.setItem('playerId', `tg_${id}`);
    localStorage.setItem('playerName', name);
    localStorage.setItem('bridge.tableView', mode);
    sessionStorage.setItem('roomCode', code);
    sessionStorage.setItem('joinRole', 'player');
    window.alert = text => { window.lastAlert = text; };
    window.playFrames = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(value) {
      const message = JSON.parse(value); if (message.type === 'playCard') playFrames.push(message);
      return originalSend.call(this, value);
    };
  }, { code, name, mode, id });
  await page.goto(`${worker.origin}/bridge/`);
  await expect(page.locator('#screen-lobby')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ws?.readyState === WebSocket.OPEN && chatEpoch !== null)).toBe(true);
  return { page, context };
}

for (const mode of ['classic', '25d']) {
  test(`live two-client history, refresh/reconnect, cap and room isolation ${mode}`, async ({ browser }) => {
    const code = await room();
    const a = await client(browser, code, `Alex${mode}`, mode);
    const b = await client(browser, code, `Blair${mode}`, mode, true);
    try {
      const log = p => p.locator('#lobby-chat-log .chat-msg');
      await expect(log(a.page)).toHaveCount(0);
      await a.page.getByRole('textbox', { name: 'Message to room' }).filter({ visible: true }).fill('First table message');
      await a.page.getByRole('textbox', { name: 'Message to room' }).filter({ visible: true }).press('Enter');
      await expect(log(b.page)).toHaveText([`Alex${mode}First table message`]);
      const input = b.page.getByRole('textbox', { name: 'Message to room' }).filter({ visible: true });
      await input.fill('Reply from mobile');
      await b.page.locator('#screen-lobby .chat-send-btn').tap();
      await expect(log(a.page)).toHaveCount(2);
      await a.page.reload();
      await expect(log(a.page)).toHaveText([`Alex${mode}First table message`, `Blair${mode}Reply from mobile`]);
      // Reconnect with messages arriving while the client is disconnected.
      await a.page.evaluate(() => { ws.onclose = null; ws.close(); });
      await expect.poll(() => a.page.evaluate(() => ws.readyState)).not.toBe(WebSocket.OPEN);
      await b.page.evaluate(() => send({ type: 'chat', text: 'Sent while Alex reconnects' }));
      await expect(log(b.page)).toHaveCount(3);
      await a.page.evaluate(() => connect());
      await expect(log(a.page)).toHaveCount(3);
      // A repeated join snapshot must not duplicate existing messages.
      await a.page.evaluate(() => send({ type: 'join', name: playerName }));
      await expect.poll(() => a.page.evaluate(() => chatMessages.length)).toBe(3);
      await Promise.all([a.page, b.page].map((p, sender) => p.evaluate(sender => {
        for (let i = 0; i < 8; i++) send({ type: 'chat', text: `concurrent-${sender}-${i}` });
      }, sender)));
      await expect.poll(() => a.page.evaluate(() => chatMessages.length)).toBe(19);
      await expect.poll(() => b.page.evaluate(() => chatMessages.length)).toBe(19);
      expect(await a.page.evaluate(() => chatMessages.map(m => m.sequence))).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
      expect(await b.page.evaluate(() => chatMessages.map(m => m.id))).toEqual(await a.page.evaluate(() => chatMessages.map(m => m.id)));
      await a.page.evaluate(() => {
        send({ type: 'chat', text: '' }); send({ type: 'chat', text: '   ' });
        for (let i = 0; i < 55; i++) send({ type: 'chat', text: `bounded-${i}` });
      });
      await expect.poll(() => log(b.page).last().textContent()).toBe(`Alex${mode}bounded-54`);
      await expect(log(a.page)).toHaveCount(50); await expect(log(b.page)).toHaveCount(50);
      await b.page.reload();
      await expect(log(b.page)).toHaveCount(50);
      await expect(log(b.page).first()).toHaveText(`Alex${mode}bounded-5`);
      const textsA = await log(a.page).allTextContents();
      expect(await log(b.page).allTextContents()).toEqual(textsA);
      // A live view switch retains the exact chat rows and scroll position.
      await b.page.evaluate(() => { window.chatRows = [...document.querySelectorAll('#lobby-chat-log .chat-msg')]; });
      await b.page.locator(`#top-bar [data-table-view="${mode === 'classic' ? '25d' : 'classic'}"]`).tap();
      expect(await b.page.evaluate(() => chatRows.every((row, n) => document.querySelectorAll('#lobby-chat-log .chat-msg')[n] === row))).toBe(true);
      // Moving the same browser to a new empty room cannot retain old history,
      // drafts, bubbles or delayed frames from its former socket.
      const secondCode = await room();
      await a.page.evaluate(secondCode => {
        window.oldSocket = ws; window.oldMessage = ws.onmessage;
        leaveGame(); setRoomCode(secondCode); connect();
      }, secondCode);
      await expect(log(a.page)).toHaveCount(0);
      await expect.poll(() => a.page.evaluate(() => chatRoom === roomCode && chatEpoch !== null)).toBe(true);
      await a.page.evaluate(code => oldMessage({ data: JSON.stringify({ type: 'chat', roomCode: code, epoch: 'old', id: 'old:1', sequence: 1, name: 'Old room', seat: -1, text: 'must not leak' }) }), code);
      await expect(log(a.page)).toHaveCount(0);
      await a.page.evaluate(() => send({ type: 'chat', text: 'Only in the new room' }));
      await expect(log(a.page)).toHaveCount(1);
      expect(await log(b.page).allTextContents()).toEqual(textsA);
    } finally { await a.context.close(); await b.context.close(); }
  });
}

async function touchCard(page, card, tapOnly = false, hold = false) {
  await card.scrollIntoViewIfNeeded();
  await card.evaluate(el => Promise.all(el.closest('.card-hand').getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
  const p = await card.evaluate(el => {
    for (const glyph of el.querySelectorAll('.card-corner > span')) {
      const r = glyph.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === el) return p;
    }
    throw new Error('Legal card has no exposed corner');
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
  if (!tapOnly) for (const target of dragPoints(p, await tablePoint(page))) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...target, id: 1 }] });
  }
  if (hold) return session;
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

for (const mode of ['classic', '25d']) {
  test(`live full four-player game, stable bidding, legal mouse/touch play and results ${mode}`, async ({ browser }) => {
    test.setTimeout(180000);
    const code = await room();
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) {
        const c = await client(browser, code, `Seat${i}${mode}`, mode, i % 2 === 1);
        c.mobile = i % 2 === 1; c.seat = i;
        clients.push(c);
        if (i === 0) await c.page.evaluate(() => send({ type: 'chat', text: 'Same room chat through this game' }));
      }
      const state = () => clients[0].page.evaluate(() => gameState);
      await expect.poll(async () => (await state())?.phase, { timeout: 15000 }).toBe('bidding');
      // Production deliberately shuffles seating when the deal starts.
      const bySeat = [];
      for (const c of clients) {
        await expect.poll(() => c.page.evaluate(() => gameState?.phase)).toBe('bidding');
        c.seat = await c.page.evaluate(() => gameState.mySeat); bySeat[c.seat] = c;
      }
      const leader = (await state()).turn;
      const observer = bySeat[(leader + 3) % 4];
      await observer.page.locator('#bidding-hand .hand-card').nth(2).focus();
      await observer.page.locator('#bidding-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
      await observer.page.evaluate(() => {
        window.bidCards = [...document.querySelectorAll('#bidding-hand .hand-card')];
        window.bidSelected = document.querySelector('#bidding-hand .is-selected');
        window.bidPositions = bidCards.map(card => [card.style.cssText, getComputedStyle(card).transform]);
      });
      await bySeat[leader].page.locator('.bid-btn:enabled').first().click();
      await expect.poll(async () => (await state()).bid).toBeGreaterThanOrEqual(0);
      for (let pass = 0; pass < 3; pass++) {
        if (pass < 2) expect(await observer.page.evaluate(() => bidCards.every((card, i) => card === document.querySelectorAll('#bidding-hand .hand-card')[i]
          && card.style.cssText === bidPositions[i][0] && getComputedStyle(card).transform === bidPositions[i][1])
          && document.querySelector('#bidding-hand .is-selected') === bidSelected)).toBe(true);
        const turn = (await state()).turn;
        await bySeat[turn].page.locator('#btn-pass').click({ timeout: 10000 });
        if (pass < 2) await expect.poll(async () => (await state()).turn).not.toBe(turn);
      }
      await expect.poll(async () => (await state()).phase).toBe('partner');
      const bidder = (await state()).bidder;
      await bySeat[bidder].page.locator('.partner-card-btn:enabled').first().click();
      await expect.poll(async () => (await state()).phase).toBe('play');
      // A true reload rejoins the same live deal and keeps all thirteen cards.
      const beforeReload = await clients[1].page.evaluate(() => ({ gameId: gameState.gameId, hand: gameState.hand }));
      await clients[1].page.reload();
      await expect.poll(() => clients[1].page.evaluate(() => gameState?.phase)).toBe('play');
      expect(await clients[1].page.evaluate(() => ({ gameId: gameState.gameId, hand: gameState.hand }))).toEqual(beforeReload);
      // The other clients receive real reconnect broadcasts without a redeal.
      const watch = clients[2];
      await watch.page.evaluate(() => { window.playCards = [...document.querySelectorAll('#play-hand .hand-card')]; });
      const reconnectDrag = await touchCard(clients[3].page, clients[3].page.locator('#play-hand .hand-card').first(), false, true);
      await expect(clients[3].page.locator('.drag-proxy')).toHaveCount(1);
      await clients[3].page.evaluate(() => { ws.onclose = null; ws.close(); connect(); });
      await expect.poll(() => clients[3].page.evaluate(() => ws.readyState)).toBe(WebSocket.OPEN);
      await expect(clients[3].page.locator('.card-drag-layer')).toHaveCount(0);
      await reconnectDrag.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await reconnectDrag.detach();
      expect(await clients[3].page.evaluate(() => playFrames)).toEqual([]);
      await expect(clients[3].page.locator('#play-hand .hand-card')).toHaveCount(13);
      expect(await watch.page.evaluate(() => playCards.every((card, i) => card === document.querySelectorAll('#play-hand .hand-card')[i]))).toBe(true);
      // Input outside the current turn cannot emit a play.
      const initialTurn = (await state()).turn;
      const idle = bySeat[(initialTurn + 1) % 4];
      await idle.page.locator('#play-hand .hand-card').first().focus(); await idle.page.keyboard.press('Enter');
      expect(await idle.page.evaluate(() => playFrames.length)).toBe(0);
      const plays = new Map(clients.map(c => [c, 0]));
      let moveCount = 0;
      let illegalGuardChecks = 0;
      for (let move = 0; move < 52; move++) {
        if ((await state()).phase === 'gameover') break;
        await expect.poll(async () => {
          const s = await state(); return s.phase === 'play';
        }, { timeout: 12000 }).toBe(true);
        const s = await state(); const c = bySeat[s.turn];
        await expect.poll(() => c.page.evaluate(() => gameState.turn === gameState.mySeat && !awaitingGameState)).toBe(true);
        const card = c.page.locator('#play-hand .hand-card:not(.disabled)').first();
        const oldHand = await c.page.locator('#play-hand .hand-card').count();
        const illegal = c.page.locator('#play-hand .hand-card.disabled').first();
        if (await illegal.count()) {
          const before = await c.page.evaluate(() => playFrames.length);
          await illegal.focus(); await c.page.keyboard.press('Enter');
          expect(await c.page.evaluate(() => playFrames.length)).toBe(before);
          illegalGuardChecks++;
        }
        if (c.mobile) {
          if (move < 4) {
            const sent = await c.page.evaluate(() => playFrames.length);
            await touchCard(c.page, card, true);
            expect(await c.page.evaluate(() => playFrames.length)).toBe(sent);
          }
          await touchCard(c.page, card);
        } else {
          // Use actual mouse input throughout the multiplayer desktop game;
          // keyboard legality and navigation are covered independently.
          await c.page.locator('#play-hand').scrollIntoViewIfNeeded();
          const corner = () => card.evaluate(el => {
            for (const glyph of el.querySelectorAll('.card-corner > span')) {
              const r = glyph.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              if (document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === el) return p;
            }
            throw new Error('No exposed mouse card corner');
          });
          const p = await corner(); await c.page.mouse.move(p.x, p.y);
          await c.page.locator('#play-hand').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
          const click = await corner();
          await c.page.evaluate(() => { window.remainingCards = [...document.querySelectorAll('#play-hand .hand-card')].filter(card => card.classList.contains('is-selected') === false); });
          await c.page.mouse.click(click.x, click.y);
        }
        await expect.poll(() => c.page.evaluate(() => Object.values(gameState.hand).flat().length)).toBe(oldHand - 1);
        if (!c.mobile) expect(await c.page.evaluate(() => remainingCards.every((card, i) => document.querySelectorAll('#play-hand .hand-card')[i] === card))).toBe(true);
        plays.set(c, plays.get(c) + 1); moveCount++;
        if (move === 2) {
          await c.page.locator(`#top-bar [data-table-view="${mode === 'classic' ? '25d' : 'classic'}"]`).click();
          expect(await c.page.evaluate(() => gameState.gameId)).toBe(s.gameId);
        }
      }
      await expect.poll(async () => (await state()).phase, { timeout: 12000 }).toBe('gameover');
      for (const c of clients) {
        await expect(c.page.locator('#screen-gameover')).toBeVisible();
        expect(await c.page.evaluate(() => playFrames.length)).toBe(plays.get(c));
        expect(await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(c.page.locator('#gameover-chat-log .chat-msg')).toHaveText([`Seat0${mode}Same room chat through this game`]);
      }
      expect(moveCount).toBeGreaterThanOrEqual(28);
      expect((await state()).sets.reduce((a, b) => a + b, 0)).toBe(moveCount / 4);
      const input = clients[0].page.locator('#screen-gameover .chat-input-field');
      await input.fill('Chat at results'); await input.press('Enter');
      for (const c of clients) await expect(c.page.locator('#gameover-chat-log .chat-msg')).toHaveCount(2);
      const resultGameId = (await state()).gameId;
      await clients[2].page.reload();
      await expect(clients[2].page.locator('#screen-gameover')).toBeVisible();
      await expect(clients[2].page.locator('#gameover-chat-log .chat-msg')).toHaveCount(2);
      expect(await clients[2].page.evaluate(() => gameState.gameId)).toBe(resultGameId);
      console.log(JSON.stringify({ liveGame: mode, acceptedCards: moveCount, completedTricks: moveCount / 4, illegalGuardChecks }));
    } finally { for (const c of clients) await c.context.close(); }
  });
}
