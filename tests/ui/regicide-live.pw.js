// Regicide end-to-end: real local Worker + Durable Object + D1, driven through the UI.
// Scenarios use a seeded deck plus the dev-only /api/regicide/debug/patch hook to set up exact
// rule situations; full games for 1–4 players check UI invariants after every action.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(240000);
let worker;
test.beforeAll(async () => { worker = await startWorker(4218); });
test.afterAll(async () => { await worker?.stop(); });

const api = (path, init) => fetch(`${worker.origin}${path}`, init);
async function token(name) {
  const res = await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) });
  return (await res.json()).token;
}
async function createRoom(seed = 1) {
  const res = await api('/api/regicide/create', { method: 'POST', body: JSON.stringify({ seed }) });
  return (await res.json()).roomCode;
}
async function patch(room, game) {
  const res = await api(`/api/regicide/debug/patch?room=${room}`, { method: 'POST', body: JSON.stringify(game) });
  expect(res.ok).toBe(true);
}

async function client(browser, name, { mobile = false, room = null, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  const auth = signedIn ? await token(name) : null;
  await page.addInitScript(({ auth }) => {
    if (auth) localStorage.setItem('authToken', auth);
    window.confirm = () => true;
  }, { auth });
  await page.goto(`${worker.origin}/regicide/${room ? `#${room}` : ''}`);
  return { page, context, name, errors };
}

/** Seats everyone in a fresh seeded room and starts; returns pages in seat order. */
async function table(browser, n, { seed = 1, mobile = [] } = {}) {
  const room = await createRoom(seed);
  const names = ['Ada', 'Bea', 'Cy', 'Di'].slice(0, n).map((x) => `${x}${seed}`);
  const pages = [];
  for (let i = 0; i < n; i++) {
    pages.push(await client(browser, names[i], { room, mobile: mobile.includes(i) }));
    await expect(pages[0].page.locator('#lobby-players .player-item.rc-player')).toHaveCount(i + 1);
  }
  await pages[0].page.locator('#btn-start').click();
  for (const p of pages) await expect(p.page.locator('#screen-game')).toHaveClass(/active/);
  return { room, pages };
}
async function close(pages) {
  for (const p of pages) {
    expect(p.errors, `page errors for ${p.name}`).toEqual([]);
    await p.context.close();
  }
}
const view = (page) => page.evaluate(() => view);
const seq = (page) => page.evaluate(() => view?.game?.log.at(-1)?.seq ?? 0);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Taps a fanned card on its exposed corner, like a finger would. */
async function tapCard(page, code) {
  const point = await page.evaluate((code) => {
    const card = document.querySelector(`#hand .hand-card[data-card="${code}"]`);
    const corner = card.querySelector('.card-corner').getBoundingClientRect();
    const p = { x: corner.left + corner.width / 2, y: corner.top + Math.min(10, corner.height / 2) };
    return document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === card ? p : null;
  }, code);
  expect(point, `corner of ${code} must be exposed`).not.toBeNull();
  await page.mouse.click(point.x, point.y);
}
async function select(page, codes) {
  for (const c of codes) await tapCard(page, c);
  expect((await page.evaluate(() => [...selected])).sort()).toEqual([...codes].sort());
}
/** Waits until every page has seen the same latest log entry. */
async function synced(pages, minSeq) {
  for (const p of pages) await expect.poll(() => seq(p.page)).toBeGreaterThanOrEqual(minSeq);
}

test('hub and Bridge share the leaderboard entry point; old bridge links redirect', async ({ browser }) => {
  const { page, context } = await client(browser, 'Hub', { signedIn: false });
  try {
    await page.goto(worker.origin);
    await expect(page.getByRole('link', { name: /Floating Bridge/ })).toHaveAttribute('href', '/bridge/');
    await expect(page.getByRole('link', { name: /Regicide/ })).toHaveAttribute('href', '/regicide/');
    await expect(page.locator('.tile-badge')).toHaveCount(0);
    await page.goto(`${worker.origin}/#ABCD`);
    await expect(page).toHaveURL(/\/bridge\/#ABCD/);
  } finally { await context.close(); }
});

test('signed-out visitors see the Telegram login and cannot take a seat', async ({ browser }) => {
  const room = await createRoom(3);
  const guest = await client(browser, 'Guest', { signedIn: false, room });
  try {
    await expect(guest.page.locator('#login-section')).toBeVisible();
    await expect(guest.page.locator('[data-dev-login]')).toBeVisible();
    await expect(guest.page.locator('#game-section')).toBeHidden();
    // Dev login (localhost only) signs in and joins the pending invite.
    await guest.page.locator('#input-dev-name').fill('Late Guest');
    await guest.page.locator('[data-dev-login] button').click();
    await expect(guest.page.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(guest.page.locator('#lobby-players .rc-player')).toHaveCount(1);
  } finally { await close([guest]); }
});

test('solo: companion pair resolves both suits; yield is not offered', async ({ browser }) => {
  const { room, pages } = await table(browser, 1, { mobile: [0] });
  const { page } = pages[0];
  try {
    await patch(room, { enemy: 'JS', enemyDamage: 0, played: [], hands: [['8D', 'AC', '3S', '4H', '5C', '6D']], tavern: ['2H', '3H', '4C', '5S', '6S', '7S', '8S', '9S', '10S', '2C'] });
    await expect(page.locator('#hand .hand-card')).toHaveCount(6);
    await expect(page.locator('#btn-yield')).toBeHidden();
    await select(page, ['8D', 'AC']);
    // Rulebook example: 8♦ + A♣ = 9 → draw 9, deal 18.
    await expect(page.locator('#preview')).toContainText('18 dmg (♣×2)');
    await expect(page.locator('#preview')).toContainText('♦ draw 9');
    await page.locator('#btn-act').click();
    await expect.poll(async () => (await view(page)).game.enemyDamage).toBe(18);
    // Drew up to the 8-card limit: 4 left + 4 drawn.
    await expect(page.locator('#hand .hand-card')).toHaveCount(8);
    expect(await noSideScroll(page)).toBe(true);
  } finally { await close(pages); }
});

test('solo: an empty hand at Step 4 must flip a Jester to survive', async ({ browser }) => {
  const { room, pages } = await table(browser, 1);
  const { page } = pages[0];
  try {
    await patch(room, { enemy: 'JC', enemyDamage: 0, played: [], hands: [['2S']], soloJestersLeft: 2 });
    await select(page, ['2S']);
    await page.locator('#btn-act').click();
    await expect(page.locator('#turn-banner')).toContainText("can't cover 8 damage");
    await expect(page.locator('#btn-act')).toHaveText(/Flip Jester to survive \(2 left\)/);
    await page.locator('#btn-act').click();
    await expect(page.locator('#hand .hand-card')).toHaveCount(8);
    await page.locator('#btn-bestfit').click();
    await page.locator('#btn-act').click();
    await expect.poll(async () => (await view(page)).game.phase).toBe('play');
    expect((await view(page)).game.soloJestersLeft).toBe(1);
  } finally { await close(pages); }
});

test('solo: no flips left and a hand that cannot cover the hit is a defeat', async ({ browser }) => {
  const { room, pages } = await table(browser, 1);
  const { page } = pages[0];
  try {
    await patch(room, { enemy: 'QC', enemyDamage: 0, played: [], hands: [['2S', '3H']], soloJestersLeft: 0 });
    await select(page, ['2S']);
    await page.locator('#btn-act').click();
    await expect(page.locator('#modal-over')).toBeVisible();
    await expect(page.locator('#over-title')).toContainText('Defeat');
    await expect(page.locator('#over-sub')).toContainText('could not survive 13 damage');
  } finally { await close(pages); }
});

test('solo: exact kill joins the tavern; beating the last King is a rated Gold victory', async ({ browser }) => {
  const { room, pages } = await table(browser, 1, { seed: 11 });
  const { page } = pages[0];
  try {
    await patch(room, { enemy: 'JC', enemyDamage: 14, played: [], hands: [['6H', '10S', '9S']] });
    await select(page, ['6H']);
    await expect(page.locator('#preview')).toContainText('exact kill');
    const tavernBefore = (await view(page)).game.tavernCount;
    await page.locator('#btn-act').click();
    await expect(page.locator('#info-castle')).toHaveText(/1\/12/);
    const g = (await view(page)).game;
    expect(g.tavernCount).toBe(tavernBefore + 1); // the Jack went on top of the tavern
    expect(g.currentSeat).toBe(0);
    expect(g.phase).toBe('play');

    await patch(room, { enemy: 'KH', castle: [], enemyDamage: 30, played: [], defeated: ['JC', 'JD', 'JH', 'JS', 'QC', 'QD', 'QH', 'QS', 'KC', 'KD', 'KS'], soloJestersLeft: 2 });
    await select(page, ['10S']);
    await page.locator('#btn-act').click();
    await expect(page.locator('#over-title')).toContainText('Gold Victory');
    await expect(page.locator('#over-rating')).toContainText('+24');
    const board = await (await api('/api/regicide/leaderboard')).json();
    const me = board.top.find((e) => e.displayName === 'Ada11');
    expect(me?.bestDefeated).toBe(12);
    // The shared card on the hub shows the Regicide board too.
    await page.goto(worker.origin);
    await page.locator('.lb-tab[data-game="regicide"]').click();
    await expect(page.locator('.lb-card')).toContainText('Ada11');
  } finally { await close(pages); }
});

test('2 players: after one yields the other cannot; hearts are blocked by a Hearts enemy', async ({ browser }) => {
  const { room, pages } = await table(browser, 2, { mobile: [1] });
  const [a, b] = pages.map((p) => p.page);
  try {
    await patch(room, { enemy: 'JH', enemyDamage: 0, played: [], discard: ['2C', '3C'], currentSeat: 0, lastTurnYielded: [false, false],
      hands: [['KS', 'QS', '5H'], ['KD', 'QD', '4H']] });
    await expect(a.locator('#btn-yield')).toBeEnabled();
    await a.locator('#btn-yield').click();
    await a.locator('#btn-bestfit').click();
    await a.locator('#btn-act').click();
    await expect.poll(async () => (await view(b)).game.currentSeat).toBe(1);
    await expect(b.locator('#btn-yield')).toBeDisabled();
    await expect(b.locator('#btn-yield')).toHaveAttribute('title', /yielded on their last turn/);
    await select(b, ['4H']);
    await expect(b.locator('#preview')).toContainText('♥ immune');
    await b.locator('#btn-act').click();
    await expect.poll(async () => (await view(a)).game.log.at(-2)?.t).toBe('play');
    await expect(a.locator('#last-action')).toContainText('♥ blocked');
    expect((await view(a)).game.discardCount).toBeGreaterThanOrEqual(2); // nothing healed
    // Both pages agree on whose turn it is, shown as Bridge's glowing seat label.
    for (const p of [a, b]) await expect(p.locator('.seat-label.active-turn')).toHaveCount(1);
  } finally { await close(pages); }
});

test('3 players: Jester cancels immunity, retro-activates spades, and its player picks who goes next', async ({ browser }) => {
  const { room, pages } = await table(browser, 3, { mobile: [2] });
  const [a, b, c] = pages.map((p) => p.page);
  try {
    await patch(room, { enemy: 'JS', enemyDamage: 6, jesterActive: false, currentSeat: 1,
      played: [{ seat: 0, cards: ['6S'], value: 6, damage: 6 }],
      hands: [['KH'], ['X1', '9C', '2D'], ['QH', '3D']] });
    await expect(a.locator('#info-shield')).toHaveText(/🛡️ 0/); // immune: the earlier spade does nothing yet
    await select(b, ['X1']);
    await expect(b.locator('#preview')).toContainText('Cancels immunity');
    await b.locator('#btn-act').click();
    await expect(b.locator('#modal-jester')).toBeVisible();
    await expect(a.locator('#modal-jester')).toBeHidden();
    await expect(a.locator('#turn-banner')).toContainText('choosing who goes next');
    await expect(a.locator('#info-shield')).toHaveText(/🛡️ 6/); // the earlier spade now shields
    await expect(a.locator('#info-immune')).toHaveText(/No immunity/);
    await b.locator('#jester-choices .player-item').nth(2).click();
    await expect.poll(async () => (await view(c)).game.currentSeat).toBe(2);
    await expect(c.locator('#turn-banner')).toContainText('Your turn');
    await expect(b.locator('#modal-jester')).toBeHidden();
  } finally { await close(pages); }
});

test('4 players: diamonds draw round-robin skipping full hands; combo rules enforced in the UI', async ({ browser }) => {
  const { room, pages } = await table(browser, 4, { mobile: [1, 3] });
  const [a, , c, d] = pages.map((p) => p.page);
  try {
    await patch(room, { enemy: 'JC', enemyDamage: 0, played: [], currentSeat: 0,
      tavern: ['2H', '3H', '4H', '5H', '6H', '7H', '8H'],
      hands: [['6D', '6S', '2C', '2D', '2H'], ['KC', 'QC', 'JD', '10C', '9C'], ['3C'], ['4C', '5C', '6C']] });
    // 6 + 6 = 12 is not a legal combo: tapping the second 6 starts a fresh selection, and the other is dimmed.
    await tapCard(a, '6D');
    await tapCard(a, '6S');
    expect(await a.evaluate(() => [...selected])).toEqual(['6S']);
    await expect(a.locator('#hand .hand-card[data-card="6D"]')).toHaveClass(/rc-dim/);
    // 2 + 2 + 2 = 6 is a legal set.
    await tapCard(a, '6S');
    await select(a, ['2C', '2D', '2H']);
    await expect(a.locator('#btn-act')).toHaveText('Play 2♣ 2♦ 2♥');
    await expect(a.locator('#preview')).toContainText('6 dmg · ♥ nothing to heal · ♦ draw 6 · ♣ immune'); // JC is immune to clubs
    for (const c of ['2C', '2D', '2H']) await tapCard(a, c);
    await select(a, ['6D']);
    await expect(a.locator('#btn-act')).toHaveText('Play 6♦');
    const before = await seq(a);
    await a.locator('#btn-act').click();
    await synced(pages, before + 1);
    // 6 draws from the player clockwise, skipping full (5-card) hands:
    // A 4→5, B full, C 1→2, D 3→4, C 2→3, D 4→5, C 3→4.
    expect((await view(c)).game.handCounts).toEqual([5, 5, 4, 5]);
    await expect(d.locator('#seat-bottom .seat-sets')).toHaveText('🂠 5');
    await expect(c.locator('#hand .hand-card')).toHaveCount(4);
  } finally { await close(pages); }
});

test('spectators watch without a hand; a reload keeps your seat', async ({ browser }) => {
  const { room, pages } = await table(browser, 2);
  const late = await client(browser, 'Watcher', { room, mobile: true });
  try {
    await expect(late.page.locator('#screen-game')).toHaveClass(/active/);
    await expect(late.page.locator('#hand')).toContainText('watching');
    await expect(late.page.locator('#btn-act')).toBeDisabled();
    const handBefore = (await view(pages[1].page)).game.hand;
    await pages[1].page.reload();
    await expect(pages[1].page.locator('#screen-game')).toHaveClass(/active/);
    expect((await view(pages[1].page)).game.hand).toEqual(handBefore);
    expect((await view(pages[1].page)).you.seat).toBe(1);
  } finally { await close([...pages, late]); }
});

test('Regicide stats: ranking with Bridge-style min-games filter and sorting; linked from the leaderboard card', async ({ browser }) => {
  const now = Math.floor(Date.now() / 1000);
  const seed = [[7001, 'Stats Veteran', 1150, 25, 6, 12], [7002, 'Stats Regular', 1090, 12, 1, 12], [7003, 'Stats Newbie', 990, 4, 0, 5]];
  for (const [id, name, rating, games, wins, best] of seed) {
    await worker.db.prepare('INSERT OR IGNORE INTO users (telegram_id, display_name, created_at) VALUES (?, ?, ?)').bind(id, name, now).run();
    await worker.db.prepare('INSERT OR REPLACE INTO regicide_ratings (telegram_id, rating, games_played, wins, best_defeated, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, rating, games, wins, best, now).run();
  }
  const { page, context } = await client(browser, 'Stats Viewer', { mobile: true, signedIn: false });
  try {
    await page.goto(worker.origin);
    await page.locator('.lb-tab[data-game="regicide"]').click();
    await page.locator('.lb-card a', { hasText: 'Full stats' }).click();
    await expect(page.locator('#screen-stats')).toHaveClass(/active/);
    const names = () => page.locator('#stats-content tbody .stats-td-name').allTextContents();
    await expect.poll(async () => (await names()).join('|')).toContain('Stats Veteran');
    expect((await names()).some((n) => n.includes('Stats Newbie'))).toBe(true); // 4 games ≥ 3
    await page.locator('#rc-min-games [data-value="10"]').click();
    expect((await names()).some((n) => n.includes('Stats Newbie'))).toBe(false);
    expect((await names()).some((n) => n.includes('Stats Regular'))).toBe(true);
    await page.locator('#rc-min-games [data-value="20"]').click();
    expect((await names()).filter((n) => n.includes('Stats '))).toEqual(['🥇 Stats Veteran']);
    // Sorting by games ascending puts the 12-game player first among those with 10+.
    await page.locator('#rc-min-games [data-value="10"]').click();
    await page.locator('th[data-sort="games"]').click();
    await page.locator('th[data-sort="games"]').click();
    expect((await names())[0]).toContain('Stats Regular');
    expect(await noSideScroll(page)).toBe(true);
    await page.locator('#btn-stats-home').click();
    await expect(page.locator('#screen-home')).toHaveClass(/active/);
  } finally { await context.close(); }
});

// --- Full games through the UI for every player count ---

const VALUE = (c) => (c.startsWith('X') ? 0 : ({ A: 1, J: 10, Q: 15, K: 20 })[c.slice(0, -1)] ?? Number(c.slice(0, -1)));
/** A reasonable table player: kill if possible (exact first), else the strongest play that survives the hit. */
function choosePlay(g) {
  const hand = g.hand;
  const nonJ = hand.filter((c) => !c.startsWith('X'));
  const options = nonJ.map((c) => [c]);
  for (const ace of nonJ.filter((c) => c.startsWith('A'))) for (const o of nonJ) if (o !== ace) options.push([ace, o]);
  const byRank = {};
  for (const c of nonJ) (byRank[c.slice(0, -1)] ??= []).push(c);
  for (const set of Object.values(byRank)) if (set.length > 1 && !set[0].startsWith('A') && set.reduce((s, c) => s + VALUE(c), 0) <= 10) options.push(set);
  const remaining = g.enemyHealth - g.enemyDamage;
  const score = (cards) => {
    const v = cards.reduce((s, c) => s + VALUE(c), 0);
    const suits = new Set(cards.map((c) => c.slice(-1)));
    const ok = (s) => suits.has(s) && s !== g.immuneSuit;
    const dmg = ok('C') ? v * 2 : v;
    const left = hand.filter((c) => !cards.includes(c)).reduce((s, c) => s + VALUE(c), 0);
    const incoming = Math.max(0, g.enemyAttack - g.shield - (ok('S') ? v : 0));
    if (dmg === remaining) return 1000 + v;
    if (dmg > remaining) return 900 - v;
    if (left < incoming) return -100 + dmg;
    return dmg + (ok('S') ? v : 0) + (ok('D') ? v / 2 : 0) + (ok('H') ? v / 3 : 0) - incoming / 2;
  };
  options.sort((x, y) => score(y) - score(x));
  const best = options[0];
  const jester = hand.find((c) => c.startsWith('X'));
  if (jester && (!best || score(best) < 0)) return { jester };
  return { cards: best ?? null };
}

async function playFullGame(browser, n, seed) {
  const { pages } = await table(browser, n, { seed, mobile: n > 1 ? [n - 1] : [0] });
  const seen = new Set();
  try {
    for (let step = 0; step < 400; step++) {
      const g = (await view(pages[0].page)).game;
      if (g.phase === 'won' || g.phase === 'lost') break;
      const actor = pages[g.currentSeat].page;
      const mine = (await view(actor)).game;
      // Invariants on every page before acting.
      for (const [i, p] of pages.entries()) {
        await expect(p.page.locator('.seat-label.active-turn')).toHaveCount(1);
        await expect(p.page.locator('#hand .hand-card')).toHaveCount((await view(p.page)).game.hand.length);
        if (i !== g.currentSeat) await expect(p.page.locator('#btn-act')).toBeDisabled();
      }
      const before = await seq(actor);
      if (mine.phase === 'play') {
        if (n === 1 && mine.hand.length === 0) await actor.locator('#btn-act').click(); // forced flip
        else {
          const move = choosePlay(mine);
          if (move.jester) { await select(actor, [move.jester]); await actor.locator('#btn-act').click(); }
          else if (!move.cards && mine.canYield) await actor.locator('#btn-yield').click();
          else if (!move.cards) throw new Error('Stuck: no legal move but the game is still running');
          else {
            if (move.cards.length > 1) seen.add(move.cards.some((c) => c.startsWith('A')) ? 'companion' : 'set');
            await select(actor, move.cards);
            await expect(actor.locator('#btn-act')).toBeEnabled();
            await actor.locator('#btn-act').click();
          }
        }
      } else if (mine.phase === 'discard') {
        if (await actor.locator('#btn-bestfit').isVisible()) await actor.locator('#btn-bestfit').click();
        await actor.locator('#btn-act').click();
      } else if (mine.phase === 'jester') {
        await expect(actor.locator('#modal-jester')).toBeVisible();
        const counts = mine.handCounts;
        await actor.locator('#jester-choices .player-item').nth(counts.indexOf(Math.max(...counts))).click();
      }
      await synced(pages, before + 1);
      for (const e of (await view(pages[0].page)).game.log) if (e.seq > before) seen.add(e.t === 'defeat' && e.exact ? 'exact' : e.t);
    }
    const end = (await view(pages[0].page)).game;
    expect(['won', 'lost']).toContain(end.phase);
    for (const p of pages) {
      await expect(p.page.locator('#modal-over')).toBeVisible();
      await expect(p.page.locator('#over-rating .lb-row')).toHaveCount(n);
      expect(await noSideScroll(p.page)).toBe(true);
    }
    // Back to the lobby with everyone still seated.
    await pages[0].page.locator('#btn-again').click();
    for (const p of pages) await expect(p.page.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(pages[0].page.locator('#lobby-players .rc-player')).toHaveCount(n);
    return { phase: end.phase, defeated: end.defeated.length, seen };
  } finally { await close(pages); }
}

for (const n of [1, 2, 3, 4]) {
  test(`full ${n}-player game through the UI ends cleanly and is rated`, async ({ browser }) => {
    const result = await playFullGame(browser, n, 100 + n);
    console.log(`${n}p: ${result.phase} with ${result.defeated}/12 royals; saw ${[...result.seen].sort().join(', ')}`);
    expect(result.seen.has('play')).toBe(true);
    expect(result.seen.has('lost') || result.seen.has('won')).toBe(true);
  });
}
