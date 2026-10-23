'use strict';

// ---------- Card helpers (mirror src/regicide/engine.ts) ----------
const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
const SUIT_NAME = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
const SUIT_POWER = { H: 'Heal', D: 'Draw', C: 'Double', S: 'Shield' };
const ROYAL_NAME = { J: 'Jack', Q: 'Queen', K: 'King' };
const ROYAL_VALUE = { J: 10, Q: 15, K: 20 };
const SUIT_ORDER = ['C', 'D', 'H', 'S']; // Bridge's hand order
const SETUP = { 1: [8, '2 Jester flips'], 2: [7, 'No Jesters'], 3: [6, '1 Jester'], 4: [5, '2 Jesters'] };

const isJester = (c) => c.startsWith('X');
const rankOf = (c) => (isJester(c) ? 'X' : c.slice(0, -1));
const suitOf = (c) => (isJester(c) ? null : c.slice(-1));
const isRed = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
function valueOf(c) {
  const r = rankOf(c);
  if (r === 'X') return 0;
  if (r === 'A') return 1;
  return ROYAL_VALUE[r] ?? Number(r);
}
const sum = (cards) => cards.reduce((t, c) => t + valueOf(c), 0);
const label = (c) => (isJester(c) ? 'Jester' : rankOf(c) + SUIT_SYMBOL[suitOf(c)]);
const enemyName = (c) => `${ROYAL_NAME[rankOf(c)]} of ${SUIT_NAME[suitOf(c)]}`;

function validatePlay(cards) {
  if (cards.length === 0) return 'Select a card';
  if (cards.some(isJester)) return cards.length === 1 ? null : 'The Jester must be played alone';
  if (cards.length === 1) return null;
  const ranks = cards.map(rankOf);
  if (ranks.includes('A')) return cards.length === 2 ? null : 'A companion pairs with one card';
  if (new Set(ranks).size !== 1) return 'Combos need matching ranks';
  if (sum(cards) > 10) return 'Combos must total 10 or less';
  return null;
}

function sortHand(cards) {
  return [...cards].sort((a, b) => {
    if (isJester(a) !== isJester(b)) return isJester(a) ? 1 : -1;
    const s = SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b));
    return s || valueOf(a) - valueOf(b);
  });
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** A Bridge-style card face: corner rank over suit. */
function cardEl(code, { tag = 'div', mini = false } = {}) {
  const node = el(tag, mini ? 'card-mini' : 'card');
  node.dataset.card = code;
  if (isJester(code)) {
    node.classList.add('black', 'rc-jester');
    node.setAttribute('aria-label', 'Jester');
    if (mini) node.append(el('span', 'card-value', '🃏'));
    else node.append(el('span', 'card-corner', '🃏'));
    return node;
  }
  const rank = rankOf(code);
  const sym = SUIT_SYMBOL[suitOf(code)];
  node.classList.add(isRed(code) ? 'red' : 'black');
  const value = el('span', 'card-value', rank);
  const suit = el('span', 'card-suit', sym);
  if (mini) node.append(value, suit);
  else {
    const corner = el('span', 'card-corner');
    corner.append(value, suit);
    node.append(corner);
    if (rank === 'A') node.append(el('span', 'rc-face', '🐾'));
  }
  node.setAttribute('aria-label', rank === 'A' ? `Ace (companion) of ${SUIT_NAME[suitOf(code)]}` : `${ROYAL_NAME[rank] ?? rank} of ${SUIT_NAME[suitOf(code)]}`);
  return node;
}

/** The current enemy: a larger card with a big royal letter. */
function enemyCardEl(code) {
  const node = el('div', `rc-enemy-card ${isRed(code) ? 'red' : 'black'}`);
  node.dataset.card = code;
  const corner = el('span', 'card-corner');
  corner.append(el('span', 'card-value', rankOf(code)), el('span', 'card-suit', SUIT_SYMBOL[suitOf(code)]));
  node.append(corner, el('span', 'rc-big', SUIT_SYMBOL[suitOf(code)]));
  node.setAttribute('aria-label', enemyName(code));
  return node;
}

function cardText(cards) {
  return cards.map(label).join(' ');
}

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `rc-toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 3800 : 2600);
}

// ---------- Identity ----------
function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { room: null, pid: null };
  const [room, pid] = raw.split(':');
  return { room: /^[A-Za-z0-9]{4}$/.test(room) ? room.toUpperCase() : null, pid: pid || null };
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};

const hashInfo = parseHash();
let playerId = hashInfo.pid || store.get('regicidePlayerId');
if (!playerId) playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
if (!hashInfo.pid) store.set('regicidePlayerId', playerId);
let playerName = store.get('playerName') || '';
let profile = null; // verified Telegram profile (FunAuth), null until signed in

// ---------- State ----------
let ws = null;
let roomCode = null;
let view = null;
let selected = new Set();
let reconnectDelay = 800;
let reconnectTimer = 0;
let lastSeq = 0;
let lastEnemy = null;
let lastDamage = 0;
let lastGameNo = -1;
let overDismissed = false;
let joinSent = false;

// ---------- Networking ----------
function connect(code) {
  roomCode = code;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = FunAuth.token();
  const socket = new WebSocket(`${proto}//${location.host}/api/regicide/ws?room=${code}&playerId=${encodeURIComponent(playerId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
  ws = socket;
  joinSent = false;
  socket.onopen = () => {
    reconnectDelay = 800;
    $('overlay-reconnect').classList.add('hidden');
  };
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'state') onState(msg);
    else if (msg.type === 'error') onError(msg);
  };
  socket.onclose = () => {
    if (ws !== socket || !roomCode) return;
    $('overlay-reconnect').classList.remove('hidden');
    reconnectTimer = setTimeout(() => connect(roomCode), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 10000);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Reconnecting… try again in a moment', 'error');
}

function onError(msg) {
  if (msg.code === 'notFound') {
    toast(`Room ${roomCode} doesn't exist (or has expired)`, 'error');
    leaveRoom(false);
    return;
  }
  toast(msg.message, 'error');
}

function onState(next) {
  const prev = view;
  view = next;
  // Join on first contact if we aren't seated yet and seats are open (signed-in players only).
  if (!joinSent && next.you.seat < 0 && !next.game && FunAuth.token()) {
    joinSent = true;
    send({ type: 'join', name: playerName });
  }
  if (next.gameNo !== lastGameNo) {
    lastGameNo = next.gameNo;
    overDismissed = false;
    selected.clear();
    lastSeq = 0;
  }
  // Drop selections that are no longer in hand, and clear after phase/turn changes.
  const g = next.game;
  const pg = prev?.game;
  if (!g || !pg || g.phase !== pg.phase || g.currentSeat !== pg.currentSeat) selected.clear();
  if (g?.hand) selected = new Set([...selected].filter((c) => g.hand.includes(c)));
  render();
}

// ---------- Screens ----------
function showScreen(id) {
  for (const sc of document.querySelectorAll('.screen')) sc.classList.toggle('active', sc.id === id);
  document.body.dataset.screen = id;
}

function render() {
  const inRoom = !!roomCode;
  $('top-bar').classList.toggle('hidden', !inRoom);
  $('tb-room').textContent = roomCode || '';
  $('tb-name').textContent = playerName;
  if (!inRoom) { showScreen('screen-home'); return; }
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); renderLobby(); hideModal('modal-over'); hideModal('modal-jester'); return; }
  showScreen('screen-game');
  renderGame();
}

function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('div', 'player-item rc-empty', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').textContent = '';
  $('lobby-setup').classList.add('hidden');
}

function statusDot(connected) {
  return el('span', `status-dot ${connected ? 'online' : 'offline'}`);
}

/** One row in Bridge's lobby player list. */
function playerRow(p, seat, { tag = 'div', meta = null } = {}) {
  const item = el(tag, 'player-item rc-player');
  const identity = el('div', 'lobby-identity');
  const name = el('span', 'lobby-player-name', p.name);
  identity.append(name);
  if (p.id === view.you.id) identity.append(el('span', 'rc-you', 'you'));
  const metaBox = el('div', 'lobby-meta');
  if (meta) metaBox.append(meta);
  item.append(el('span', 'seat-num', String(seat + 1)), statusDot(p.connected), identity, metaBox, el('div', 'lobby-action'));
  return item;
}

function renderLobby() {
  const { players, you } = view;
  $('lobby-code').textContent = view.roomCode;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, seat) => {
    const meta = el('span', 'rc-player-meta');
    if (p.isHost) meta.append(el('span', 'rc-host', '👑 Host'));
    // Same signal as Bridge: non-members still play and are rated, but don't count for this group.
    if (p.isGroupMember === false) meta.append(el('span', 'not-ranked-badge', '⚠️ not in group'));
    const row = playerRow(p, seat, { meta });
    if (you.isHost && p.id !== you.id) {
      const kick = el('button', 'kick-btn', '✕');
      kick.type = 'button';
      kick.setAttribute('aria-label', `Remove ${p.name}`);
      kick.onclick = () => send({ type: 'kick', playerId: p.id });
      row.querySelector('.lobby-action').append(kick);
    }
    list.append(row);
  });
  for (let i = players.length; i < 4; i++) list.append(el('div', 'player-item rc-empty', 'Open seat'));

  const n = players.length;
  const setup = $('lobby-setup');
  setup.classList.toggle('hidden', n === 0);
  if (n > 0) {
    const [hand, extra] = SETUP[n];
    setup.textContent = (n === 1
      ? `🤝 Solo · ${hand}-card hand · ${extra}`
      : `🤝 Co-op · ${n} players · ${hand} cards each · ${extra}`) + (view.groupName ? ` · 💬 ${view.groupName}` : '');
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  if (!seated && !FunAuth.token()) {
    $('lobby-wait').textContent = 'Sign in with Telegram on the Regicide home screen to take a seat — you can watch until then.';
    return;
  }
  $('btn-start').textContent = n === 1 ? 'Start Solo Game' : `Start Game (${n} players)`;
  const wait = $('lobby-wait');
  wait.textContent = !seated
    ? (n >= 4 ? 'This room is full.' : 'Joining…')
    : you.isHost
      ? (n < 4 ? 'Share the code — up to 4 can play, or start now.' : 'Table is full — ready when you are.')
      : `Waiting for ${players.find((p) => p.isHost)?.name ?? 'the host'} to start...`;
}

// ---------- Game rendering ----------
function playerName_(seat) {
  return view.players[seat]?.name ?? `Player ${seat + 1}`;
}
function who(seat) {
  return seat === view.you.seat ? 'You' : playerName_(seat);
}

function renderGame() {
  const g = view.game;
  const me = view.you.seat;
  const myTurn = me >= 0 && g.currentSeat === me;
  const over = g.phase === 'won' || g.phase === 'lost';

  renderInfo(g);
  $('tavern-count').textContent = g.tavernCount;
  $('discard-count').textContent = g.discardCount;
  renderEnemy(g);
  renderPlayed(g);
  renderSeats(g);
  renderLog(g);
  renderLastAction(g);
  renderBanner(g, myTurn);
  renderHand(g, myTurn);
  renderActions(g, myTurn);

  // Jester chooser
  if (g.phase === 'jester' && myTurn) showJesterModal(g);
  else hideModal('modal-jester');

  if (over && !overDismissed) showOverModal(g);
  else if (!over) hideModal('modal-over');
}

function renderInfo(g) {
  $('info-castle').textContent = `🏰 ${g.defeated.length}/12`;
  $('info-castle').title = `${g.castle.remaining} royals left in the castle`;
  $('info-attack').textContent = g.shield > 0 ? `⚔️ ${g.attack} (${g.enemyAttack}−${Math.min(g.shield, g.enemyAttack)})` : `⚔️ ${g.attack}`;
  $('info-shield').textContent = `🛡️ ${g.shield}`;
  const imm = $('info-immune');
  imm.classList.toggle('hidden', !g.enemy);
  if (!g.enemy) return;
  const suit = suitOf(g.enemy);
  imm.className = g.jesterActive ? 'cancelled' : (isRed(g.enemy) ? 'red' : '');
  imm.textContent = g.jesterActive ? '🃏 No immunity' : `Immune ${SUIT_SYMBOL[suit]} ${SUIT_POWER[suit]}`;
}

function renderEnemy(g) {
  const panel = $('enemy-panel');
  const holder = $('enemy-card');
  if (!g.enemy) {
    holder.replaceChildren(el('div', 'rc-enemy-empty', '🏰'));
    $('enemy-name').textContent = g.phase === 'won' ? 'Castle taken!' : '';
    $('hp-fill').style.width = '0%';
    $('hp-left').textContent = '0';
    $('hp-max').textContent = '0';
    return;
  }
  if (holder.firstChild?.dataset?.card !== g.enemy) {
    const card = enemyCardEl(g.enemy);
    if (lastEnemy && lastEnemy !== g.enemy) card.classList.add('reveal');
    holder.replaceChildren(card);
  }
  const left = Math.max(0, g.enemyHealth - g.enemyDamage);
  $('enemy-name').textContent = enemyName(g.enemy);
  $('hp-left').textContent = left;
  $('hp-max').textContent = g.enemyHealth;
  const fill = $('hp-fill');
  fill.style.width = `${(left / g.enemyHealth) * 100}%`;
  fill.classList.toggle('low', left / g.enemyHealth <= 0.35);
  if (g.enemy === lastEnemy && g.enemyDamage > lastDamage) {
    panel.classList.remove('hit');
    void panel.offsetWidth;
    panel.classList.add('hit');
  }
  lastEnemy = g.enemy;
  lastDamage = g.enemyDamage;
}

function renderPlayed(g) {
  const row = $('played-cards');
  row.replaceChildren();
  if (!g.played.length) {
    row.append(el('span', 'rc-played-empty', 'No attacks yet'));
    return;
  }
  for (const play of g.played) {
    const group = el('span', 'rc-played-group');
    group.title = `${who(play.seat)}: ${play.damage} damage`;
    for (const c of play.cards) group.append(cardEl(c, { mini: true }));
    if (play.damage) group.append(el('span', 'rc-played-dmg', `−${play.damage}`));
    row.append(group);
  }
}

/** Table positions relative to the viewer, like Bridge: you at the bottom, then clockwise. */
function seatPositions(n, me) {
  const order = { 1: ['bottom'], 2: ['bottom', 'top'], 3: ['bottom', 'left', 'right'], 4: ['bottom', 'left', 'top', 'right'] }[n];
  const base = me >= 0 ? me : 0;
  const map = {};
  for (let i = 0; i < n; i++) map[(base + i) % n] = order[i];
  return map;
}

function renderSeats(g) {
  const positions = seatPositions(view.players.length, view.you.seat);
  for (const pos of ['top', 'left', 'right', 'bottom']) {
    const label = $(`seat-${pos}`);
    label.replaceChildren();
    label.className = 'seat-label';
  }
  const over = g.phase === 'won' || g.phase === 'lost';
  view.players.forEach((p, seat) => {
    const label = $(`seat-${positions[seat]}`);
    if (!label) return;
    const active = seat === g.currentSeat && !over;
    label.classList.toggle('active-turn', active);
    label.classList.toggle('disconnected', !p.connected);
    const nameRow = el('div', 'seat-name-row');
    nameRow.append(statusDot(p.connected), el('span', 'seat-name', seat === view.you.seat ? 'You' : p.name));
    label.title = p.name;
    label.append(nameRow, el('span', 'seat-sets', `🂠 ${g.handCounts[seat]}`));
    if (active && g.phase !== 'play') label.append(el('span', 'rc-tag', g.phase === 'discard' ? `taking ${g.pendingDamage}` : 'choosing'));
  });
}

function describe(entry) {
  switch (entry.t) {
    case 'play': {
      const bits = [];
      if (entry.doubled) bits.push('♣ ×2');
      if (entry.heal) bits.push(`♥ healed ${entry.heal}`);
      if (entry.draw || (entry.cards.some((c) => suitOf(c) === 'D') && !entry.immune.includes('D'))) {
        bits.push(entry.draw < entry.value ? `♦ drew ${entry.draw} of ${entry.value}` : `♦ drew ${entry.draw}`);
      }
      if (entry.shield) bits.push(`♠ shield +${entry.shield}`);
      if (entry.immune.length) bits.push(`${entry.immune.map((s) => SUIT_SYMBOL[s]).join('')} blocked`);
      return `${who(entry.seat)} played ${cardText(entry.cards)} for ${entry.damage} damage${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    }
    case 'jester': return `${who(entry.seat)} played the Jester — immunity cancelled`;
    case 'yield': return `${who(entry.seat)} yielded`;
    case 'damage': return `The enemy strikes ${entry.seat === view.you.seat ? 'you' : who(entry.seat)} for ${entry.amount}`;
    case 'nodamage': return `${who(entry.seat)} blocked the attack completely 🛡️`;
    case 'discard': return `${who(entry.seat)} discarded ${cardText(entry.cards)} (${entry.value})`;
    case 'defeat': return `${who(entry.seat)} defeated the ${enemyName(entry.enemy)}!${entry.exact ? ' Exact hit — it joins the tavern deck 🤝' : ''}`;
    case 'reveal': return `${enemyName(entry.enemy)} steps forward`;
    case 'choose': return `${who(entry.seat)} chose ${entry.target === entry.seat ? 'themself' : who(entry.target)} to go next`;
    case 'flip': return `${who(entry.seat)} flipped a Jester — fresh hand of ${entry.drawn}`;
    case 'won': return 'Victory! The castle has fallen 👑';
    case 'lost': return `${who(entry.seat)} ${entry.reason}`;
  }
  return '';
}

function renderLog(g) {
  const log = $('log');
  log.replaceChildren();
  for (const entry of [...g.log].reverse()) {
    const li = el('li', `log-${entry.t}`, describe(entry));
    log.append(li);
  }
}

function renderLastAction(g) {
  const box = $('last-action');
  // The two latest events, e.g. "You played 7♥ for 7" + "The enemy strikes you for 10".
  // A reveal right after a defeat is skipped so the defeat itself stays visible.
  const entries = g.log.filter((e, i) => e.t !== 'reveal' || i === 0);
  const recent = entries.slice(-2);
  const last = recent[recent.length - 1];
  if (!last) { box.replaceChildren(); return; }
  if (last.seq !== lastSeq) {
    box.replaceChildren(...recent.map((e, i) => el('div', i === recent.length - 1 ? 'la-latest' : 'la-prev', describe(e))));
    box.classList.remove('pop');
    void box.offsetWidth;
    box.classList.add('pop');
    lastSeq = last.seq;
  }
}

function renderBanner(g, myTurn) {
  const banner = $('turn-banner');
  let text = '';
  let kind = '';
  const name = playerName_(g.currentSeat);
  if (g.phase === 'won') { text = 'Victory! Every royal has been defeated.'; kind = 'good'; }
  else if (g.phase === 'lost') { text = `Defeat — ${who(g.currentSeat)} ${g.loseReason}`; kind = 'danger'; }
  else if (view.you.seat < 0) { text = `👁 Watching · ${name}'s turn`; }
  else if (myTurn && g.phase === 'play') {
    text = g.hand.length === 0
      ? (g.numPlayers === 1 ? 'No cards left — flip a Jester to refill' : 'No cards left — you must yield')
      : 'Your turn · pick a card or combo';
    kind = 'mine';
  } else if (myTurn && mustFlip(g)) {
    text = `Your hand can't cover ${g.pendingDamage} damage — flip a Jester or you lose`;
    kind = 'danger';
  } else if (myTurn && g.phase === 'discard') {
    text = `Take ${g.pendingDamage} damage · discard cards worth ${g.pendingDamage}+`;
    kind = 'danger';
  } else if (myTurn && g.phase === 'jester') { text = 'Choose who goes next'; kind = 'mine'; }
  else if (g.phase === 'discard') text = `${name} is taking ${g.pendingDamage} damage…`;
  else if (g.phase === 'jester') text = `${name} is choosing who goes next…`;
  else text = `${name} is attacking…`;
  banner.textContent = text;
  banner.className = `rc-turn ${kind}`.trim();
}

/** Bridge-style fan geometry for up to 8 cards. */
function fanLayout(container, n) {
  const width = container.clientWidth || 340;
  const cardW = Math.round(Math.min(86, Math.max(52, width / 5.2)));
  // Keep the rotated outer cards inside the container (their corners swing ~20% of a card outwards).
  const usable = width - cardW * 1.4;
  const spacing = n > 1 ? Math.min(cardW * 0.8, usable / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const step = n > 1 ? Math.min(5, 24 / (n - 1)) : 0;
  const arc = cardW * 0.04;
  container.style.setProperty('--hand-card-width', `${cardW}px`);
  container.style.setProperty('--corner-font', `${Math.round(cardW * 0.3)}px`);
  container.style.height = `${Math.round(cardW * 1.4 + 18 + arc * mid * mid + 8)}px`;
  return (i) => ({ left: width / 2 + (i - mid) * spacing - cardW / 2, top: 18 + arc * (i - mid) ** 2, angle: (i - mid) * step });
}

function renderHand(g, myTurn) {
  const hand = $('hand');
  if (!g.hand) {
    hand.style.height = '60px';
    hand.replaceChildren(el('div', 'rc-hand-empty', 'You are watching this game.'));
    $('hand-total').textContent = '';
    $('preview').textContent = '';
    $('btn-bestfit').classList.add('hidden');
    return;
  }
  const cards = sortHand(g.hand);
  const interactive = myTurn && (g.phase === 'play' || g.phase === 'discard');
  hand.classList.toggle('interactive', interactive);
  hand.replaceChildren();
  const place = fanLayout(hand, cards.length);
  if (!cards.length) hand.append(el('div', 'rc-hand-empty', 'Your hand is empty'));
  const sel = [...selected];
  cards.forEach((code, i) => {
    const node = cardEl(code, { tag: 'button' });
    node.type = 'button';
    node.classList.add('hand-card');
    const pos = place(i);
    node.style.left = `${pos.left}px`;
    node.style.top = `${pos.top}px`;
    node.style.setProperty('--card-angle', `${pos.angle}deg`);
    node.style.setProperty('--card-order', String(i + 1));
    const isSel = selected.has(code);
    node.classList.toggle('is-selected', isSel);
    node.setAttribute('aria-pressed', String(isSel));
    if (!interactive) node.disabled = true;
    else if (g.phase === 'play' && !isSel && sel.length && validatePlay([...sel, code])) node.classList.add('rc-dim');
    node.addEventListener('click', () => onCardTap(code));
    hand.append(node);
  });
  $('hand-total').textContent = `Hand value ${sum(g.hand)} · ${g.hand.length}/${g.maxHand} cards`;
  $('btn-bestfit').classList.toggle('hidden', !(myTurn && g.phase === 'discard' && sum(g.hand) >= g.pendingDamage));
  renderPreview(g, myTurn);
}

function onCardTap(code) {
  const g = view?.game;
  if (!g) return;
  if (selected.has(code)) selected.delete(code);
  else if (g.phase === 'play' && validatePlay([...selected, code])) selected = new Set([code]); // start a fresh selection
  else selected.add(code);
  renderHand(g, true);
  renderActions(g, true);
}

/** Cheapest discard that covers the damage (fewest points lost, then fewest cards). Hands are ≤ 8 cards. */
function bestFit(hand, need) {
  let best = null;
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const pick = hand.filter((_, i) => mask & (1 << i));
    const v = sum(pick);
    if (v < need) continue;
    if (!best || v < best.v || (v === best.v && pick.length < best.pick.length)) best = { v, pick };
  }
  return best?.pick ?? [];
}

function playPreview(g, cards) {
  const err = validatePlay(cards);
  if (err) return { ok: false, text: err };
  if (isJester(cards[0])) return { ok: true, text: 'Cancels immunity · no damage · you pick who goes next' };
  const value = sum(cards);
  const suits = new Set(cards.map(suitOf));
  const immune = (s) => s === g.immuneSuit;
  const bits = [];
  const blocked = [];
  for (const s of ['H', 'D', 'C', 'S']) {
    if (!suits.has(s)) continue;
    if (immune(s)) { blocked.push(SUIT_SYMBOL[s]); continue; }
    if (s === 'H') bits.push(g.discardCount ? `♥ heal ${Math.min(value, g.discardCount)}` : '♥ nothing to heal');
    if (s === 'D') bits.push(`♦ draw ${value}`);
    if (s === 'S') bits.push(`♠ shield ${value}`);
  }
  const doubled = suits.has('C') && !immune('C');
  const damage = doubled ? value * 2 : value;
  const remaining = g.enemyHealth - g.enemyDamage;
  let outcome;
  if (damage >= remaining && g.castle.remaining === 0) outcome = 'defeats the last King — victory!';
  else if (damage === remaining) outcome = 'exact kill — it joins you!';
  else if (damage > remaining) outcome = 'defeats it!';
  else {
    const shield = g.shield + (suits.has('S') && !immune('S') ? value : 0);
    const incoming = Math.max(0, g.enemyAttack - shield);
    outcome = incoming ? `then take ${incoming}` : 'fully shielded';
  }
  const head = `${damage} dmg${doubled ? ' (♣×2)' : ''}`;
  return { ok: true, text: [head, ...bits, blocked.length ? `${blocked.join('')} immune` : null, outcome].filter(Boolean).join(' · ') };
}

function renderPreview(g, myTurn) {
  const preview = $('preview');
  preview.className = 'rc-preview';
  if (!myTurn || !selected.size) { preview.textContent = ''; return; }
  if (g.phase === 'play') {
    const p = playPreview(g, [...selected]);
    preview.textContent = p.text;
    if (!p.ok) preview.classList.add('bad');
  } else if (g.phase === 'discard') {
    const v = sum([...selected]);
    preview.textContent = `Discarding ${v} of ${g.pendingDamage} needed`;
    preview.classList.add(v >= g.pendingDamage ? 'good' : 'bad');
  }
}

/**
 * Solo, and a Jester flip is the only legal move: the hand can't cover the damage (Step 4),
 * or it's empty at the start of the turn (Step 1, solo can't yield). Without a flip left the
 * engine has already ended the game.
 */
function mustFlip(g) {
  if (g.numPlayers !== 1 || g.soloJestersLeft <= 0 || !g.hand) return false;
  if (g.phase === 'discard') return sum(g.hand) < g.pendingDamage;
  return g.phase === 'play' && g.hand.length === 0;
}

function renderActions(g, myTurn) {
  const act = $('btn-act');
  const yieldBtn = $('btn-yield');
  const flip = $('btn-flip');
  const over = g.phase === 'won' || g.phase === 'lost';
  const seated = view.you.seat >= 0;

  flip.classList.toggle('hidden', !(g.numPlayers === 1 && seated && !over));
  flip.disabled = !(myTurn && g.soloJestersLeft > 0 && (g.phase === 'play' || g.phase === 'discard'));
  $('flip-count').textContent = String(g.soloJestersLeft);

  if (over) {
    yieldBtn.classList.add('hidden');
    act.textContent = 'Results';
    act.disabled = false;
    act.dataset.action = 'results';
    return;
  }
  if (!seated) {
    yieldBtn.classList.add('hidden');
    act.textContent = 'Watching';
    act.disabled = true;
    return;
  }
  const sel = [...selected];
  if (myTurn && mustFlip(g)) {
    // Solo rule: a Jester may be flipped at the start of Step 4 — it's the only way to survive this hit.
    yieldBtn.classList.add('hidden');
    flip.classList.add('hidden');
    act.textContent = `🃏 Flip Jester to survive (${g.soloJestersLeft} left)`;
    act.disabled = false;
    act.dataset.action = 'flip';
    return;
  }
  if (g.phase === 'discard') {
    yieldBtn.classList.add('hidden');
    const v = sum(sel);
    act.textContent = myTurn ? (sel.length ? `Discard ${v}` : `Discard ≥ ${g.pendingDamage}`) : 'Waiting…';
    act.disabled = !myTurn || v < g.pendingDamage;
    act.dataset.action = 'discard';
    return;
  }
  if (g.phase === 'jester') {
    yieldBtn.classList.add('hidden');
    act.textContent = myTurn ? 'Choose who goes next' : 'Waiting…';
    act.disabled = !myTurn;
    act.dataset.action = 'jester';
    return;
  }
  // Solo players can't yield, so the button only exists in multiplayer.
  yieldBtn.classList.toggle('hidden', g.numPlayers === 1);
  yieldBtn.disabled = !(myTurn && g.phase === 'play' && g.canYield);
  yieldBtn.title = g.canYield ? 'Skip attacking and take the hit' : "Can't yield — everyone else yielded on their last turn";
  const valid = sel.length > 0 && !validatePlay(sel);
  act.textContent = myTurn ? (valid ? `Play ${cardText(sel)}` : 'Play') : 'Waiting…';
  act.disabled = !(myTurn && g.phase === 'play' && valid);
  act.dataset.action = 'play';
}

// ---------- Modals ----------
function showModal(id) {
  const m = $(id);
  if (!m.classList.contains('hidden')) return;
  m.classList.remove('hidden');
  document.body.classList.add('modal-open');
}
function hideModal(id) {
  $(id).classList.add('hidden');
  if (!document.querySelector('.rc-modal:not(.hidden)')) document.body.classList.remove('modal-open');
}

function showJesterModal(g) {
  const box = $('jester-choices');
  box.replaceChildren();
  view.players.forEach((p, seat) => {
    const row = playerRow(p, seat, { tag: 'button', meta: el('span', 'lobby-stats', `🂠 ${g.handCounts[seat]}`) });
    row.type = 'button';
    row.onclick = () => send({ type: 'chooseNext', seat });
    box.append(row);
  });
  showModal('modal-jester');
}

function showOverModal(g) {
  const won = g.phase === 'won';
  const tierEmoji = { gold: '🥇', silver: '🥈', bronze: '🥉' };
  const box = $('over-box');
  // Bridge's game-over panel colours: green glow for a win, red for a loss.
  box.classList.toggle('gameover-win', won);
  box.classList.toggle('gameover-loss', !won);
  $('over-title').textContent = won
    ? `${tierEmoji[g.tier] ?? '👑'} ${g.tier ? `${g.tier[0].toUpperCase()}${g.tier.slice(1)} Victory!` : 'Victory!'}`
    : '💀 Defeat';
  $('over-sub').textContent = won
    ? (g.numPlayers === 1 ? `You stormed the castle using ${2 - g.soloJestersLeft} Jester flip${2 - g.soloJestersLeft === 1 ? '' : 's'}.` : 'Your party stormed the castle together.')
    : `${who(g.currentSeat)} ${g.loseReason}.`;
  const stats = $('over-stats');
  stats.replaceChildren();
  const stat = (n, l) => { const d = el('div'); d.append(el('b', null, n), el('span', null, l)); return d; };
  stats.append(stat(`${g.defeated.length}/12`, 'royals defeated'), stat(String(g.defeated.filter((c) => rankOf(c) === 'K').length), 'kings'));
  if (g.enemy && !won) stats.append(stat(`${Math.max(0, g.enemyHealth - g.enemyDamage)}`, `HP left on ${label(g.enemy)}`));
  renderRatingResult();
  $('btn-again').classList.toggle('hidden', view.you.seat < 0);
  showModal('modal-over');
}

function renderRatingResult() {
  const box = $('over-rating');
  const rating = view.lastRating;
  if (!rating || rating.gameId !== view.gameId || !rating.changes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const rows = rating.changes.map((c) => {
    const row = el('div', 'lb-row');
    const delta = el('span', c.delta >= 0 ? 'rc-delta-up' : 'rc-delta-down', `${c.delta >= 0 ? '+' : ''}${c.delta}`);
    row.append(el('span', 'lb-name', c.seat === view.you.seat ? 'You' : c.name), el('span', 'lb-elo', String(c.after)), delta);
    return row;
  });
  box.replaceChildren(el('div', 'lb-header', '🏆 Regicide rating'), ...rows);
}

// ---------- Stats (Bridge's Players table, ranking only) ----------
let statsRows = [];
let statsMinGames = 3;
let statsSort = { col: 'elo', dir: 'desc' };

async function showStats() {
  showScreen('screen-stats');
  history.replaceState(null, '', `${location.pathname}?view=stats`);
  $('stats-content').innerHTML = '<p class="stats-empty">Loading…</p>';
  try {
    const res = await fetch('/api/regicide/stats');
    statsRows = res.ok ? await res.json() : [];
  } catch { statsRows = []; }
  renderStats();
}

function hideStats() {
  history.replaceState(null, '', location.pathname);
  render();
}

function sortStats(col) {
  statsSort = statsSort.col === col ? { col, dir: statsSort.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' ? 'asc' : 'desc' };
  renderStats();
}

function renderStats() {
  const content = $('stats-content');
  for (const b of document.querySelectorAll('#rc-min-games .min-games-btn')) b.classList.toggle('active', Number(b.dataset.value) === statsMinGames);
  const sortFns = {
    elo: (r) => r.elo, games: (r) => r.games, wins: (r) => r.wins, winPct: (r) => r.winPct,
    best: (r) => r.bestDefeated, avg: (r) => r.avgDefeated, name: (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[statsSort.col] ?? sortFns.elo;
  const sorted = statsRows.filter((r) => r.games >= statsMinGames).sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return statsSort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });
  if (!sorted.length) {
    content.innerHTML = `<p class="stats-empty">No players with ${statsMinGames}+ games yet.</p>`;
    return;
  }
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const medals = ['🥇', '🥈', '🥉'];
  const arrow = (col) => (statsSort.col !== col ? '<span class="sort-arrow">⇅</span>' : `<span class="sort-arrow active">${statsSort.dir === 'desc' ? '▼' : '▲'}</span>`);
  const th = (col, label, left = false) => `<th class="${left ? 'stats-th-left' : ''}${statsSort.col === col ? ' sorted' : ''}" data-sort="${col}">${label} ${arrow(col)}</th>`;
  const body = sorted.map((r, i) => `<tr>
      <td class="stats-td-name">${i < 3 ? medals[i] : `${i + 1}.`} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${r.wins}</td>
      <td class="stats-td-num">${r.winPct}%</td>
      <td class="stats-td-num${r.bestDefeated === 12 ? ' rc-best-win' : ''}">${r.bestDefeated}/12</td>
      <td class="stats-td-num">${r.avgDefeated.toFixed(1)}</td>
    </tr>`).join('');
  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>${th('name', 'Player', true)}${th('elo', 'Rating')}${th('games', 'G')}${th('wins', 'W')}${th('winPct', 'Win%')}${th('best', 'Best')}${th('avg', 'Avg')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
  for (const cell of content.querySelectorAll('th[data-sort]')) cell.addEventListener('click', () => sortStats(cell.dataset.sort));
}

// ---------- Room lifecycle ----------
function enterRoom(code) {
  roomCode = code;
  view = null;
  lastGameNo = -1;
  history.replaceState(null, '', `#${code}${hashInfo.pid ? `:${hashInfo.pid}` : ''}`);
  render();
  connect(code);
}

function leaveRoom(notify = true) {
  if (notify) send({ type: 'leave' });
  const socket = ws;
  ws = null;
  roomCode = null;
  view = null;
  selected.clear();
  clearTimeout(reconnectTimer);
  if (socket) { socket.onclose = null; setTimeout(() => socket.close(), 50); }
  history.replaceState(null, '', location.pathname);
  $('overlay-reconnect').classList.add('hidden');
  for (const m of document.querySelectorAll('.rc-modal')) m.classList.add('hidden');
  document.body.classList.remove('modal-open');
  render();
}

async function requireName() {
  if (!FunAuth.token()) { toast('Sign in with Telegram first', 'error'); return false; }
  const input = $('input-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    toast('Enter your name first', 'error');
    return false;
  }
  // Telegram accounts without a usable name pick one once, saved to the shared profile (like Bridge).
  if (!input.readOnly && profile && name !== profile.displayName) {
    try {
      await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FunAuth.token()}` }, body: JSON.stringify({ displayName: name }) });
      profile.displayName = name;
    } catch { /* keep going with the local name */ }
  }
  playerName = name;
  store.set('playerName', name);
  return true;
}

/** Bridge's home flow: signed in → game section with the Telegram name; otherwise the login box. */
function showSignedIn(p) {
  profile = p;
  $('login-section').classList.add('hidden');
  $('game-section').classList.remove('hidden');
  const input = $('input-name');
  const name = p.nameRequired ? '' : (p.displayName || playerName);
  input.value = name;
  input.readOnly = !!(p.displayName && !p.nameRequired);
  input.classList.toggle('input-readonly', input.readOnly);
  if (name) { playerName = name; store.set('playerName', name); }
  const status = $('auth-status');
  status.innerHTML = '';
  if (p.displayName) {
    status.append('Logged in as ', el('strong', null, p.displayName), ' · ');
    const out = el('a', null, 'Logout');
    out.href = '#';
    out.onclick = (e) => { e.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' }); };
    status.append(out);
  }
}

function showSignedOut() {
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' });
    if (pendingRoom) { const room = pendingRoom; pendingRoom = null; enterRoom(room); }
  });
}

let pendingRoom = null;
async function initAuth() {
  const p = await FunAuth.profile();
  if (p) showSignedIn(p);
  else showSignedOut();
}

async function createRoom() {
  if (!await requireName()) return;
  const btn = $('btn-create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/regicide/create', { method: 'POST' });
    if (!res.ok) throw new Error('create failed');
    const { roomCode: code } = await res.json();
    enterRoom(code);
  } catch {
    toast('Could not create a room — check your connection', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function joinRoom() {
  if (!await requireName()) return;
  const code = $('input-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    $('input-code').focus();
    toast('Room codes are 4 characters', 'error');
    return;
  }
  enterRoom(code);
}

function inviteUrl() {
  return `${location.origin}${location.pathname}#${roomCode}`;
}

async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Regicide on Fun Central', text: `Join my Regicide game — room ${roomCode}`, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied 📋');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

// ---------- Wire up ----------
$('input-name').value = playerName;
$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);
$('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('input-code').value ? joinRoom() : createRoom()); });
$('btn-share').addEventListener('click', shareInvite);
$('tb-room').addEventListener('click', shareInvite);
$('btn-start').addEventListener('click', () => send({ type: 'start' }));
$('btn-leave').addEventListener('click', () => {
  const g = view?.game;
  const midGame = g && g.phase !== 'won' && g.phase !== 'lost' && view.you.seat >= 0;
  if (midGame && !confirm('Leave this game? Your team will be stuck until you come back.')) return;
  leaveRoom(true);
});
$('btn-yield').addEventListener('click', () => send({ type: 'yield' }));
$('btn-flip').addEventListener('click', () => {
  if (confirm('Flip a Jester? Your whole hand is discarded and you draw a fresh hand.')) send({ type: 'flip' });
});
$('btn-act').addEventListener('click', () => {
  const action = $('btn-act').dataset.action;
  if (action === 'results') { overDismissed = false; showOverModal(view.game); return; }
  if (action === 'jester') { showJesterModal(view.game); return; }
  if (action === 'flip') { send({ type: 'flip' }); return; }
  send({ type: action, cards: [...selected] });
});
$('btn-bestfit').addEventListener('click', () => {
  const g = view?.game;
  if (!g?.hand || g.phase !== 'discard') return;
  selected = new Set(bestFit(g.hand, g.pendingDamage));
  renderHand(g, true);
  renderActions(g, true);
});
$('btn-stats').addEventListener('click', showStats);
$('btn-stats-home').addEventListener('click', hideStats);
for (const b of document.querySelectorAll('#rc-min-games .min-games-btn')) {
  b.addEventListener('click', () => { statsMinGames = Number(b.dataset.value); renderStats(); });
}
$('btn-again').addEventListener('click', () => send({ type: 'backToLobby' }));
$('btn-over-close').addEventListener('click', () => { overDismissed = true; hideModal('modal-over'); });

const openRules = () => showModal('modal-rules');
$('btn-rules').addEventListener('click', openRules);
$('btn-rules-home').addEventListener('click', openRules);
$('modal-rules').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) hideModal('modal-rules');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideModal('modal-rules');
});

// Desktop: keep the log open by default.
if (matchMedia('(min-width: 960px)').matches) $('log-details').open = true;

// The fan is laid out in pixels, so re-lay it when the width changes.
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view?.game) renderHand(view.game, view.you.seat === view.game.currentSeat); }, 100);
});

// Reconnect promptly when a phone wakes the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomCode && ws?.readyState !== WebSocket.OPEN) connect(roomCode);
});
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);

function openFromHash(room) {
  $('input-code').value = room;
  if (FunAuth.token() && playerName) enterRoom(room);
  else { pendingRoom = room; render(); toast(`Sign in to join room ${room}`); }
}

// An invite link opened in an already-loaded tab only changes the hash.
addEventListener('hashchange', () => {
  const { room } = parseHash();
  if (room && room !== roomCode) {
    if (roomCode) leaveRoom(true);
    openFromHash(room);
  }
});

FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' });
initAuth().finally(() => {
  if (hashInfo.room) openFromHash(hashInfo.room);
  else if (new URLSearchParams(location.search).get('view') === 'stats') showStats();
  else render();
});
