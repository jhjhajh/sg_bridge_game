'use strict';

// ---------- Card helpers (mirror src/regicide/engine.ts) ----------
const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
const SUIT_NAME = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
const SUIT_POWER = { H: 'Heal', D: 'Draw', C: 'Double', S: 'Shield' };
const ROYAL_NAME = { J: 'Jack', Q: 'Queen', K: 'King' };
const ROYAL_VALUE = { J: 10, Q: 15, K: 20 };
const SUIT_ORDER = ['S', 'H', 'C', 'D'];
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

function cardEl(code, { tag = 'div', size = '' } = {}) {
  const node = el(tag, `rc-card ${size}`.trim());
  node.dataset.card = code;
  if (isJester(code)) {
    node.classList.add('jester');
    node.append(el('span', 'c-corner', '★'), el('span', 'c-center', '🃏'));
    node.setAttribute('aria-label', 'Jester');
    return node;
  }
  const rank = rankOf(code);
  const sym = SUIT_SYMBOL[suitOf(code)];
  if (isRed(code)) node.classList.add('red');
  const corner = el('span', 'c-corner');
  corner.append(el('b', null, rank), el('i', null, sym));
  const center = el('span', 'c-center');
  if (ROYAL_NAME[rank]) {
    node.classList.add('royal');
    center.append(el('span', 'c-royal', rank), el('span', 'c-royal-suit', sym));
  } else if (rank === 'A') {
    node.classList.add('ace');
    center.append(el('span', 'c-pip', sym), el('span', 'c-paw', '🐾'));
  } else {
    center.append(el('span', 'c-pip', sym));
  }
  node.append(corner, center);
  node.setAttribute('aria-label', rank === 'A' ? `Ace (companion) of ${SUIT_NAME[suitOf(code)]}` : `${ROYAL_NAME[rank] ?? rank} of ${SUIT_NAME[suitOf(code)]}`);
  return node;
}

function cardText(cards) {
  return cards.map(label).join(' ');
}

let toastTimer = 0;
function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 3800 : 2600);
  clearTimeout(toastTimer);
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
  const socket = new WebSocket(`${proto}//${location.host}/api/regicide/ws?room=${code}&playerId=${encodeURIComponent(playerId)}`);
  ws = socket;
  joinSent = false;
  socket.onopen = () => {
    reconnectDelay = 800;
    $('tb-conn').classList.add('hidden');
  };
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'state') onState(msg);
    else if (msg.type === 'error') onError(msg);
  };
  socket.onclose = () => {
    if (ws !== socket || !roomCode) return;
    $('tb-conn').classList.remove('hidden');
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
  // Join on first contact if we aren't seated yet and seats are open.
  if (!joinSent && next.you.seat < 0 && !next.game) {
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
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  document.body.dataset.screen = id;
}

function render() {
  const inRoom = !!roomCode;
  $('tb-room').classList.toggle('hidden', !inRoom);
  $('tb-room').textContent = roomCode || '';
  $('btn-leave').classList.toggle('hidden', !inRoom);
  $('tb-back').classList.toggle('hidden', inRoom);
  if (!inRoom) { showScreen('screen-home'); return; }
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); renderLobby(); hideModal('modal-over'); hideModal('modal-jester'); return; }
  showScreen('screen-game');
  renderGame();
}

function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('li', 'lobby-slot empty', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').classList.add('hidden');
  $('lobby-setup').textContent = '';
}

function renderLobby() {
  const { players, you } = view;
  $('lobby-code').textContent = view.roomCode;
  $('lobby-count').textContent = `${players.length}/4`;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, i) => {
    const li = el('li', `lobby-slot${p.id === you.id ? ' me' : ''}`);
    li.append(el('span', 'slot-avatar', initials(p.name)));
    const name = el('span', 'slot-name', p.name);
    if (p.id === you.id) name.append(el('span', 'slot-tag', 'you'));
    li.append(name);
    if (p.isHost) li.append(el('span', 'slot-host', '👑 Host'));
    if (!p.connected) li.append(el('span', 'slot-off', 'offline'));
    if (you.isHost && p.id !== you.id) {
      const kick = el('button', 'icon-btn slot-kick', '✕');
      kick.type = 'button';
      kick.setAttribute('aria-label', `Remove ${p.name}`);
      kick.onclick = () => send({ type: 'kick', playerId: p.id });
      li.append(kick);
    }
    list.append(li);
    void i;
  });
  for (let i = players.length; i < 4; i++) list.append(el('li', 'lobby-slot empty', 'Open seat'));

  const n = players.length;
  const setup = $('lobby-setup');
  setup.replaceChildren();
  if (n > 0) {
    const [hand, extra] = SETUP[n];
    setup.append(
      el('span', 'chip', n === 1 ? '🧩 Solo' : `👥 ${n} players`),
      el('span', 'chip', n === 1 ? `🂠 ${hand}-card hand` : `🂠 ${hand} cards each`),
      el('span', 'chip', `🃏 ${extra}`),
    );
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  $('btn-start').textContent = n === 1 ? 'Start solo game' : `Start game (${n} players)`;
  const wait = $('lobby-wait');
  wait.classList.toggle('hidden', you.isHost);
  wait.textContent = !seated
    ? (n >= 4 ? 'This room is full.' : 'Joining…')
    : `Waiting for ${players.find((p) => p.isHost)?.name ?? 'the host'} to start…`;
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : Array.from(parts[0]).slice(0, 2).join('')).toUpperCase();
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

  document.querySelector('.board').classList.toggle('solo', g.numPlayers === 1);
  renderCastle(g);
  $('tavern-count').textContent = g.tavernCount;
  $('discard-count').textContent = g.discardCount;
  renderEnemy(g);
  renderPlayed(g);
  renderPlayers(g);
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

function renderCastle(g) {
  const pips = $('castle-pips');
  pips.replaceChildren();
  const ranks = ['J', 'Q', 'K'];
  const defeatedByRank = { J: [], Q: [], K: [] };
  for (const c of g.defeated) defeatedByRank[rankOf(c)].push(c);
  for (const r of ranks) {
    const group = el('span', 'pip-group');
    for (let i = 0; i < 4; i++) {
      const done = defeatedByRank[r][i];
      const pip = el('span', 'pip');
      if (done) {
        pip.classList.add('done');
        if (isRed(done)) pip.classList.add('red');
        pip.textContent = SUIT_SYMBOL[suitOf(done)];
        pip.title = `${enemyName(done)} defeated`;
      } else if (i === defeatedByRank[r].length && g.enemy && rankOf(g.enemy) === r) {
        pip.classList.add('current');
        pip.textContent = r;
        pip.title = 'Current enemy';
      } else {
        pip.textContent = r;
      }
      group.append(pip);
    }
    pips.append(group);
  }
}

function renderEnemy(g) {
  const panel = $('enemy-panel');
  const holder = $('enemy-card');
  if (!g.enemy) {
    holder.replaceChildren(el('div', 'enemy-empty', '🏰'));
    $('enemy-name').textContent = g.phase === 'won' ? 'The castle has fallen' : '';
    $('hp-fill').style.width = '0%';
    $('hp-left').textContent = '0';
    $('hp-max').textContent = '0';
    $('enemy-attack').textContent = '0';
    $('enemy-attack-base').textContent = '';
    $('enemy-shield').textContent = '0';
    $('enemy-immunity').textContent = '';
    return;
  }
  if (holder.firstChild?.dataset?.card !== g.enemy) {
    const card = cardEl(g.enemy, { size: 'xl' });
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

  $('enemy-attack').textContent = g.attack;
  $('enemy-attack-base').textContent = g.shield > 0 ? ` (${g.enemyAttack} − ${Math.min(g.shield, g.enemyAttack)})` : '';
  $('enemy-shield').textContent = g.shield;
  const imm = $('enemy-immunity');
  imm.replaceChildren();
  const suit = suitOf(g.enemy);
  if (g.jesterActive) {
    imm.className = 'immunity cancelled';
    imm.append(el('span', null, '🃏'), el('span', null, `Immunity cancelled — ${SUIT_SYMBOL[suit]} powers work`));
  } else {
    imm.className = `immunity${isRed(g.enemy) ? ' red' : ''}`;
    imm.append(el('span', 'imm-suit', SUIT_SYMBOL[suit]), el('span', null, `Immune to ${SUIT_NAME[suit]} (${SUIT_POWER[suit].toLowerCase()})`));
  }
}

function renderPlayed(g) {
  const row = $('played-cards');
  row.replaceChildren();
  if (!g.played.length) {
    row.append(el('span', 'played-empty', 'No attacks yet'));
    return;
  }
  for (const play of g.played) {
    const group = el('span', 'played-group');
    group.title = `${who(play.seat)}: ${play.damage} damage`;
    for (const c of play.cards) group.append(cardEl(c, { size: 'mini' }));
    if (play.damage) group.append(el('span', 'played-dmg', `−${play.damage}`));
    row.append(group);
  }
}

function renderPlayers(g) {
  const box = $('players');
  box.className = `players n${view.players.length}`;
  box.replaceChildren();
  view.players.forEach((p, seat) => {
    const card = el('div', 'player');
    if (seat === g.currentSeat && g.phase !== 'won' && g.phase !== 'lost') card.classList.add('active');
    if (seat === view.you.seat) card.classList.add('me');
    if (!p.connected) card.classList.add('offline');
    card.append(el('span', 'player-avatar', initials(p.name)));
    const info = el('span', 'player-info');
    const name = el('span', 'player-name', seat === view.you.seat ? 'You' : p.name);
    name.title = p.name;
    const meta = el('span', 'player-meta', `🂠 ${g.handCounts[seat]}/${g.maxHand}`);
    if (!p.connected) meta.append(el('span', 'player-off', ' · offline'));
    info.append(name, meta);
    card.append(info);
    if (seat === g.currentSeat && g.phase !== 'won' && g.phase !== 'lost') {
      card.append(el('span', 'player-turn', g.phase === 'discard' ? 'hit' : g.phase === 'jester' ? 'choosing' : 'turn'));
    }
    box.append(card);
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
  else if (g.phase === 'lost') { text = `Defeat — ${who(g.currentSeat)} ${g.loseReason}`; kind = 'bad'; }
  else if (view.you.seat < 0) { text = `👁 Watching · ${name}'s turn`; }
  else if (myTurn && g.phase === 'play') {
    text = g.hand.length === 0 ? 'No cards left — you must yield' : 'Your turn — attack with a card or combo' + (g.canYield ? ', or yield' : '');
    kind = 'mine';
  } else if (myTurn && g.phase === 'discard') {
    text = `Take ${g.pendingDamage} damage — discard cards worth at least ${g.pendingDamage}`;
    kind = 'danger';
  } else if (myTurn && g.phase === 'jester') { text = 'Choose who goes next'; kind = 'mine'; }
  else if (g.phase === 'discard') text = `${name} is taking ${g.pendingDamage} damage…`;
  else if (g.phase === 'jester') text = `${name} is choosing who goes next…`;
  else text = `${name} is attacking…`;
  banner.textContent = text;
  banner.className = `turn-banner ${kind}`.trim();
}

function renderHand(g, myTurn) {
  const hand = $('hand');
  const area = hand.parentElement;
  area.classList.toggle('spectating', !g.hand);
  if (!g.hand) {
    hand.replaceChildren(el('div', 'hand-empty', 'You are watching this game.'));
    $('hand-total').textContent = '';
    $('preview').textContent = '';
    return;
  }
  const cards = sortHand(g.hand);
  const interactive = myTurn && (g.phase === 'play' || g.phase === 'discard');
  hand.classList.toggle('interactive', interactive);
  hand.style.setProperty('--n', String(cards.length));
  hand.replaceChildren();
  if (!cards.length) hand.append(el('div', 'hand-empty', 'Your hand is empty'));
  const sel = [...selected];
  for (const code of cards) {
    const node = cardEl(code, { tag: 'button' });
    node.type = 'button';
    node.classList.add('hand-card');
    const isSel = selected.has(code);
    node.classList.toggle('selected', isSel);
    node.setAttribute('aria-pressed', String(isSel));
    if (!interactive) node.disabled = true;
    else if (g.phase === 'play' && !isSel && sel.length && validatePlay([...sel, code])) node.classList.add('dim');
    node.addEventListener('click', () => onCardTap(code));
    hand.append(node);
  }
  $('hand-total').textContent = `Hand value ${sum(g.hand)}`;
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
  if (damage === remaining) outcome = 'exact kill — it joins you!';
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
  preview.className = 'preview';
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

function renderActions(g, myTurn) {
  const bar = $('action-bar');
  const act = $('btn-act');
  const yieldBtn = $('btn-yield');
  const flip = $('btn-flip');
  const over = g.phase === 'won' || g.phase === 'lost';
  const seated = view.you.seat >= 0;
  bar.classList.toggle('waiting', !myTurn || over);

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
  yieldBtn.classList.remove('hidden');
  yieldBtn.disabled = !(myTurn && g.phase === 'play' && g.canYield);
  yieldBtn.title = g.canYield ? 'Skip attacking and take the hit' : "Can't yield — everyone else just yielded";
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
  if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
}

function showJesterModal(g) {
  const box = $('jester-choices');
  box.replaceChildren();
  view.players.forEach((p, seat) => {
    const b = el('button', 'btn btn-secondary btn-block jester-choice');
    b.type = 'button';
    b.append(
      el('span', 'player-avatar', initials(p.name)),
      el('span', 'jc-name', seat === view.you.seat ? `${p.name} (you)` : p.name),
      el('span', 'jc-meta', `${p.connected ? '' : 'offline · '}🂠 ${g.handCounts[seat]}`),
    );
    b.onclick = () => send({ type: 'chooseNext', seat });
    box.append(b);
  });
  showModal('modal-jester');
}

function showOverModal(g) {
  const won = g.phase === 'won';
  const tierEmoji = { gold: '🥇', silver: '🥈', bronze: '🥉' };
  $('over-emoji').textContent = won ? (tierEmoji[g.tier] ?? '👑') : '💀';
  $('over-title').textContent = won ? (g.tier ? `${g.tier[0].toUpperCase()}${g.tier.slice(1)} victory!` : 'Victory!') : 'Defeat';
  $('over-sub').textContent = won
    ? (g.numPlayers === 1 ? `You stormed the castle using ${2 - g.soloJestersLeft} Jester flip${2 - g.soloJestersLeft === 1 ? '' : 's'}.` : 'Your party stormed the castle together.')
    : `${who(g.currentSeat)} ${g.loseReason}.`;
  const stats = $('over-stats');
  stats.replaceChildren();
  const stat = (n, l) => { const s = el('div', 'over-stat'); s.append(el('b', null, n), el('span', null, l)); return s; };
  stats.append(stat(`${g.defeated.length}/12`, 'royals defeated'), stat(String(g.defeated.filter((c) => rankOf(c) === 'K').length), 'kings'));
  if (g.enemy && !won) stats.append(stat(`${Math.max(0, g.enemyHealth - g.enemyDamage)}`, `HP left on ${label(g.enemy)}`));
  $('btn-again').classList.toggle('hidden', view.you.seat < 0);
  showModal('modal-over');
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
  $('tb-conn').classList.add('hidden');
  for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
  document.body.classList.remove('modal-open');
  render();
}

function requireName() {
  const input = $('input-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 400);
    toast('Enter your name first', 'error');
    return false;
  }
  playerName = name;
  store.set('playerName', name);
  return true;
}

async function createRoom() {
  if (!requireName()) return;
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

function joinRoom() {
  if (!requireName()) return;
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
  send({ type: action, cards: [...selected] });
});
$('btn-bestfit').addEventListener('click', () => {
  const g = view?.game;
  if (!g?.hand || g.phase !== 'discard') return;
  selected = new Set(bestFit(g.hand, g.pendingDamage));
  renderHand(g, true);
  renderActions(g, true);
});
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

// Reconnect promptly when a phone wakes the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomCode && ws?.readyState !== WebSocket.OPEN) connect(roomCode);
});
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);

function openFromHash(room) {
  $('input-code').value = room;
  if (playerName) enterRoom(room);
  else { render(); $('input-name').focus(); toast(`Enter your name to join room ${room}`); }
}

// An invite link opened in an already-loaded tab only changes the hash.
addEventListener('hashchange', () => {
  const { room } = parseHash();
  if (room && room !== roomCode) {
    if (roomCode) leaveRoom(true);
    openFromHash(room);
  }
});

if (hashInfo.room) openFromHash(hashInfo.room);
else render();
