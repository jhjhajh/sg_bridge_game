/* global crypto */
'use strict';

// --- Constants ---
const BID_SUITS = ['♣', '♦', '♥', '♠', '🚫'];
const CARD_SUITS = ['♣', '♦', '♥', '♠'];
const NUM_PLAYERS = 4;

// --- State ---
let ws = null;

// Parse hash format: #ROOM or #ROOM:playerId
function parseHash() {
  const raw = location.hash.slice(1);
  if (!raw) return { room: null, pid: null };
  const idx = raw.indexOf(':');
  if (idx >= 0) {
    return { room: raw.slice(0, idx).toUpperCase(), pid: raw.slice(idx + 1) };
  }
  return { room: raw.toUpperCase(), pid: null };
}

const hashInfo = parseHash();

// Prefer playerId from URL (cross-browser handoff), then localStorage, then generate new
let playerId = hashInfo.pid || localStorage.getItem('playerId');
if (!playerId) {
  playerId = crypto.randomUUID();
}
localStorage.setItem('playerId', playerId);

let playerName = localStorage.getItem('playerName') || '';
let roomCode = hashInfo.room || sessionStorage.getItem('roomCode') || null;
let reconnectTimer = null;
let reconnectDelay = 2000;
let gameState = null;
let lastGameOver = null;

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const screens = document.querySelectorAll('.screen');

// --- Screen management ---
function showScreen(id) {
  screens.forEach((s) => s.classList.remove('active'));
  screens.forEach((s) => s.classList.add('hidden'));
  const el = $(id);
  el.classList.remove('hidden');
  el.classList.add('active');

  const topBar = $('top-bar');
  if (id === 'screen-home') {
    topBar.classList.add('hidden');
  } else {
    topBar.classList.remove('hidden');
    $('top-bar-room').textContent = roomCode || '';
    $('top-bar-name').textContent = playerName || '';
  }
}

// --- Card rendering ---
function isRedSuit(suit) {
  return suit === '♥' || suit === '♦';
}

function createCardEl(value, suit, opts = {}) {
  const div = document.createElement('div');
  div.className = `card ${isRedSuit(suit) ? 'red' : 'black'}`;
  if (opts.disabled) div.classList.add('disabled');
  if (opts.mini) {
    div.className = `card-mini ${isRedSuit(suit) ? 'red' : 'black'}`;
  }
  div.innerHTML = `<span class="card-value">${value}</span><span class="card-suit">${suit}</span>`;
  if (opts.onClick && !opts.disabled) {
    div.addEventListener('click', () => opts.onClick(value, suit));
  }
  return div;
}

function renderHand(container, hand, validSuits, onClick) {
  container.innerHTML = '';
  if (!hand) return;
  for (const suit of CARD_SUITS) {
    const values = hand[suit] || [];
    if (values.length === 0) continue;
    const group = document.createElement('div');
    group.className = 'suit-group';
    for (const value of values) {
      const disabled = validSuits ? !validSuits.includes(suit) : false;
      const card = createCardEl(value, suit, {
        disabled,
        onClick: onClick ? () => onClick(value, suit) : null,
      });
      group.appendChild(card);
    }
    container.appendChild(group);
  }
}

function getBidFromNum(num) {
  const suitNum = num % 5;
  const suit = BID_SUITS[suitNum];
  const level = Math.floor(num / 5) + 1;
  return `${level} ${suit}`;
}

function getNumFromBid(level, suitIdx) {
  return (level - 1) * 5 + suitIdx;
}

function getSuitClass(suit) {
  if (suit === '♣') return 'suit-clubs';
  if (suit === '♦') return 'suit-diamonds';
  if (suit === '♥') return 'suit-hearts';
  if (suit === '♠') return 'suit-spades';
  if (suit === '🚫') return 'suit-notrump';
  return '';
}

// --- WebSocket ---
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${roomCode}&playerId=${playerId}`);

  ws.onopen = () => {
    reconnectDelay = 2000;
    $('overlay-reconnect').classList.add('hidden');
    ws.send(JSON.stringify({ type: 'join', name: playerName }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (roomCode) {
      $('overlay-reconnect').classList.remove('hidden');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        connect();
      }, reconnectDelay);
    }
  };

  ws.onerror = () => {};
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Visibility change reconnect ---
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && roomCode && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connect();
  }
});

// --- Message handler ---
function handleMessage(msg) {
  switch (msg.type) {
    case 'state':
      gameState = msg.state;
      renderState();
      break;
    case 'error':
      alert(msg.message);
      break;
    case 'joined':
      break;
    case 'gameStart':
      break;
    case 'bidMade':
    case 'passed':
      break;
    case 'bidWon':
      break;
    case 'allPassed':
      break;
    case 'partnerSelected':
      break;
    case 'youArePartner':
      showPartnerNotification(msg.bidderName);
      break;
    case 'playPhaseStart':
      break;
    case 'cardPlayed':
      break;
    case 'trickWon':
      animateTrickWon(msg);
      break;
    case 'gameOver':
      lastGameOver = msg;
      break;
    case 'playerDisconnected':
      showConnectionToast(`${msg.name} disconnected`);
      if (gameState) {
        const p = gameState.players.find(p => p.seat === msg.seat);
        if (p) p.connected = false;
        renderState();
      }
      break;
    case 'playerReconnected':
      showConnectionToast(`${msg.name} reconnected`);
      if (gameState) {
        const p = gameState.players.find(p => p.seat === msg.seat);
        if (p) p.connected = true;
        renderState();
      }
      break;
  }
}

function showConnectionToast(text) {
  const div = document.createElement('div');
  div.className = 'connection-toast';
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => {
    div.classList.add('fade-out');
    setTimeout(() => div.remove(), 400);
  }, 3000);
}

function animateTrickWon(msg) {
  if (!gameState) return;

  showTrickWonBanner(msg.winnerName);

  const trickArea = $('trick-area');
  if (trickArea) {
    trickArea.classList.add('trick-complete');
  }
}

function showPartnerNotification(bidderName) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#d4a843;padding:1rem 2rem;border-radius:8px;z-index:500;font-size:1.1rem;text-align:center;';
  div.textContent = `You are ${bidderName}'s partner!`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function showTrickWonBanner(winnerName) {
  const existing = document.querySelector('.trick-won-banner');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'trick-won-banner';
  div.textContent = `${winnerName} wins the trick`;
  document.body.appendChild(div);
  setTimeout(() => {
    div.classList.add('fade-out');
    setTimeout(() => div.remove(), 400);
  }, 1200);
}

function showLastTrick() {
  if (!gameState || !gameState.lastTrick) return;

  const existing = $('last-trick-popup');
  if (existing) { existing.remove(); return; }

  const lt = gameState.lastTrick;
  const overlay = document.createElement('div');
  overlay.id = 'last-trick-popup';
  overlay.className = 'last-trick-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const box = document.createElement('div');
  box.className = 'last-trick-box';

  const title = document.createElement('div');
  title.className = 'last-trick-title';
  const winnerName = gameState.players[lt.winner]?.name || '?';
  title.textContent = `Last Trick — won by ${winnerName}`;
  box.appendChild(title);

  const cards = document.createElement('div');
  cards.className = 'last-trick-cards';

  for (let seat = 0; seat < 4; seat++) {
    const card = lt.cards[seat];
    if (!card) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'last-trick-card-item';

    const label = document.createElement('div');
    label.className = 'last-trick-player-label';
    label.textContent = gameState.players[seat]?.name || `Seat ${seat + 1}`;
    if (seat === lt.winner) label.classList.add('winner');

    const parts = card.split(' ');
    const cardEl = createCardEl(parts[0], parts[1], { mini: false });

    wrapper.appendChild(label);
    wrapper.appendChild(cardEl);
    cards.appendChild(wrapper);
  }

  box.appendChild(cards);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-small';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  box.appendChild(closeBtn);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// --- Render based on full state ---
function renderState() {
  const s = gameState;
  if (!s) return;

  switch (s.phase) {
    case 'lobby':
      showScreen('screen-lobby');
      renderLobby(s);
      break;
    case 'bidding':
      showScreen('screen-bidding');
      renderBidding(s);
      break;
    case 'partner':
      showScreen('screen-partner');
      renderPartner(s);
      break;
    case 'play':
      showScreen('screen-play');
      renderPlay(s);
      break;
    case 'gameover':
      showScreen('screen-gameover');
      renderGameOver(s);
      break;
  }
}

// --- Lobby ---
function renderLobby(s) {
  $('lobby-room-code').textContent = s.roomCode;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of s.players) {
    const item = document.createElement('div');
    item.className = 'player-item';
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span><span>${esc(p.name)}</span>`;
    list.appendChild(item);
  }
  const remaining = NUM_PLAYERS - s.players.length;
  $('lobby-status').textContent = remaining > 0
    ? `Waiting for ${remaining} more player(s)...`
    : 'Game starting...';
}

// --- Bidding ---
function renderBidding(s) {
  const isMyTurn = s.turn === s.mySeat;
  $('bid-status').textContent = isMyTurn
    ? "It's your turn to bid!"
    : `Waiting for ${s.players[s.turn]?.name || '?'} to bid...`;

  if (s.bid >= 0 && s.bidder >= 0) {
    $('bid-current').textContent = `Current bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  } else {
    $('bid-current').textContent = 'No bids yet';
  }

  const grid = $('bid-grid');
  grid.innerHTML = '';
  for (let level = 1; level <= 7; level++) {
    for (let si = 0; si < 5; si++) {
      const bidNum = (level - 1) * 5 + si;
      const bidStr = getBidFromNum(bidNum);
      const btn = document.createElement('button');
      btn.className = `bid-btn ${getSuitClass(BID_SUITS[si])}`;
      btn.textContent = bidStr;
      btn.disabled = !isMyTurn || bidNum <= s.bid;
      btn.addEventListener('click', () => send({ type: 'bid', bidNum }));
      grid.appendChild(btn);
    }
  }

  $('btn-pass').disabled = !isMyTurn;
  renderHand($('bidding-hand'), s.hand, null, null);
}

// --- Partner selection ---
function renderPartner(s) {
  const isBidder = s.mySeat === s.bidder;
  $('partner-title').textContent = isBidder ? 'Select Partner Card' : 'Partner Selection';
  $('partner-status').textContent = isBidder
    ? 'Choose a card to call as your partner:'
    : `Waiting for ${s.players[s.bidder]?.name || '?'} to select partner...`;

  const grid = $('partner-grid');
  grid.innerHTML = '';

  if (isBidder) {
    const values = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    for (const val of values) {
      for (const suit of CARD_SUITS) {
        const btn = document.createElement('button');
        btn.className = `partner-card-btn ${isRedSuit(suit) ? 'red' : ''}`;
        btn.textContent = `${val} ${suit}`;
        btn.addEventListener('click', () => send({ type: 'selectPartner', card: `${val} ${suit}` }));
        grid.appendChild(btn);
      }
    }
  }

  renderHand($('partner-hand'), s.hand, null, null);
}

// --- Play ---
function renderPlay(s) {
  // Info bar
  if (s.bid >= 0 && s.bidder >= 0) {
    $('play-bid-info').textContent = `Bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  }
  $('play-partner-info').textContent = s.partnerCard ? `Partner: ${s.partnerCard}` : '';
  $('play-trump-info').textContent = s.trumpSuit ? `Trump: ${s.trumpSuit}` : '';

  // Seat mapping: rotate so mySeat is always at bottom
  const seatOrder = [
    s.mySeat,
    (s.mySeat + 1) % 4,
    (s.mySeat + 2) % 4,
    (s.mySeat + 3) % 4,
  ];
  const positions = ['bottom', 'left', 'top', 'right'];
  const trickPositions = ['bot', 'left', 'top', 'right'];

  for (let i = 0; i < 4; i++) {
    const seat = seatOrder[i];
    const pos = positions[i];
    const player = s.players[seat];
    const label = $(`seat-${pos}-label`);

    if (player) {
      let text = player.name;
      if (seat === s.bidder) text += ' ★';
      label.textContent = text;
      label.className = 'seat-label';
      if (seat === s.turn) label.classList.add('active-turn');
      if (!player.connected) label.classList.add('disconnected');
    } else {
      label.textContent = '';
    }
  }

  // Trick area
  const trickArea = $('trick-area');
  trickArea.innerHTML = '';
  trickArea.classList.toggle('trick-complete', !!s.trickComplete);
  for (let i = 0; i < 4; i++) {
    const seat = seatOrder[i];
    const trickPos = trickPositions[i];
    const played = s.playedCards[seat];
    const wrapper = document.createElement('div');
    wrapper.className = `trick-card trick-card-${trickPos}`;
    if (played) {
      const parts = played.split(' ');
      wrapper.appendChild(createCardEl(parts[0], parts[1], { mini: true }));
    }
    trickArea.appendChild(wrapper);
  }

  // Sets display
  const setsDiv = $('sets-display');
  setsDiv.innerHTML = '';
  for (let i = 0; i < s.players.length; i++) {
    const item = document.createElement('span');
    item.className = `set-item${i === s.mySeat ? ' is-me' : ''}`;
    item.textContent = `${s.players[i].name}: ${s.sets[i]}`;
    setsDiv.appendChild(item);
  }
  if (s.lastTrick && !s.trickComplete) {
    const ltBtn = document.createElement('button');
    ltBtn.className = 'btn-last-trick';
    ltBtn.textContent = 'Last Trick';
    ltBtn.addEventListener('click', showLastTrick);
    setsDiv.appendChild(ltBtn);
  }

  // Hand
  const isMyTurn = s.turn === s.mySeat;
  let validSuits = null;
  if (isMyTurn && s.hand) {
    validSuits = getValidSuitsClient(s.hand, s.trumpSuit, s.currentSuit, s.trumpBroken);
  }
  renderHand($('play-hand'), s.hand, isMyTurn ? validSuits : CARD_SUITS, isMyTurn ? onPlayCard : null);
}

function onPlayCard(value, suit) {
  send({ type: 'playCard', card: `${value} ${suit}` });
}

function getValidSuitsClient(hand, trumpSuit, currentSuit, trumpBroken) {
  let effectiveTrump = null;
  if (trumpSuit && trumpSuit !== '🚫') effectiveTrump = trumpSuit;

  const valid = [];
  if (currentSuit) {
    if (hand[currentSuit] && hand[currentSuit].length > 0) return [currentSuit];
    for (const suit of CARD_SUITS) {
      if (hand[suit] && hand[suit].length > 0) valid.push(suit);
    }
  } else {
    for (const suit of CARD_SUITS) {
      if (hand[suit] && hand[suit].length > 0 && (suit !== effectiveTrump || trumpBroken)) {
        valid.push(suit);
      }
    }
    if (valid.length === 0 && effectiveTrump) valid.push(effectiveTrump);
  }
  return valid;
}

// --- Game Over ---
function renderGameOver(s) {
  const title = $('gameover-title');
  const detail = $('gameover-detail');
  const scores = $('gameover-scores');

  const bidderName = s.bidder >= 0 ? s.players[s.bidder].name : '?';
  const bidStr = s.bid >= 0 ? getBidFromNum(s.bid) : '?';

  if (lastGameOver) {
    const myName = s.mySeat >= 0 ? s.players[s.mySeat].name : '';
    const iWon = lastGameOver.winnerNames.includes(myName);
    title.textContent = iWon ? 'You Won!' : 'Game Over';
    const winnersStr = lastGameOver.winnerNames.join(' & ');
    detail.textContent = lastGameOver.bidderWon
      ? `${winnersStr} won the bid of ${bidStr} (needed ${s.setsNeeded} sets)`
      : `${winnersStr} defeated the bid of ${bidStr}`;
  } else {
    title.textContent = 'Game Over';
    detail.textContent = `Bid: ${bidderName} - ${bidStr} (needed ${s.setsNeeded} sets)`;
  }

  scores.innerHTML = '';
  for (let i = 0; i < s.players.length; i++) {
    const item = document.createElement('div');
    item.className = 'score-item';
    let nameText = s.players[i].name;
    if (i === s.bidder) nameText += ' (Bidder)';
    item.innerHTML = `<span class="name">${esc(nameText)}</span><span class="sets-won">${s.sets[i]} sets</span>`;
    scores.appendChild(item);
  }
}

// --- Utils ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setRoomCode(code) {
  roomCode = code;
  sessionStorage.setItem('roomCode', code);
  history.replaceState(null, '', buildHashWithId(code));
}

function buildHashWithId(room) {
  return '#' + room + ':' + playerId;
}

function leaveGame() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  roomCode = null;
  gameState = null;
  lastGameOver = null;
  sessionStorage.removeItem('roomCode');
  history.replaceState(null, '', location.pathname + location.search);
  $('overlay-reconnect').classList.add('hidden');
  $('input-room').value = '';
  showScreen('screen-home');
}

function getShareUrl() {
  return `${location.origin}${location.pathname}#${roomCode}`;
}

// --- Event listeners ---
$('input-name').value = playerName;

$('btn-create').addEventListener('click', async () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);

  $('btn-create').disabled = true;
  try {
    const res = await fetch('/api/create', { method: 'POST' });
    const data = await res.json();
    setRoomCode(data.roomCode);
    showScreen('screen-lobby');
    $('lobby-room-code').textContent = roomCode;
    connect();
  } catch (err) {
    alert('Failed to create game');
  } finally {
    $('btn-create').disabled = false;
  }
});

$('btn-join').addEventListener('click', () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);

  const code = $('input-room').value.trim().toUpperCase();
  if (!code || code.length < 3) { alert('Please enter a valid room code'); return; }
  setRoomCode(code);

  showScreen('screen-lobby');
  $('lobby-room-code').textContent = roomCode;
  connect();
});

$('btn-share-link').addEventListener('click', () => {
  const url = getShareUrl();
  if (navigator.share) {
    navigator.share({ title: 'Join my Floating Bridge game!', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      $('btn-share-link').textContent = 'Link Copied!';
      setTimeout(() => { $('btn-share-link').textContent = 'Share Invite Link'; }, 2000);
    });
  }
});

$('btn-pass').addEventListener('click', () => {
  send({ type: 'pass' });
});

$('btn-play-again').addEventListener('click', () => {
  send({ type: 'playAgain' });
});

$('btn-leave-global').addEventListener('click', () => {
  if (gameState && gameState.phase !== 'lobby') {
    if (confirm('Leave the current game?')) leaveGame();
  } else {
    leaveGame();
  }
});

// Allow pressing Enter on room code input to join
$('input-room').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
$('input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if ($('input-room').value.trim()) {
      $('btn-join').click();
    } else {
      $('input-room').focus();
    }
  }
});

// Auto-reconnect or pre-fill from URL hash
if (roomCode && playerName) {
  history.replaceState(null, '', buildHashWithId(roomCode));
  showScreen('screen-lobby');
  $('lobby-room-code').textContent = roomCode;
  connect();
} else if (roomCode) {
  $('input-room').value = roomCode;
}
