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
let prevTurn = -1;
let lobbyCountdownTimer = null;
let gameoverCountdownTimer = null;

// Stats state
let statsData = { players: [], pairs: [] };
let statsGroups = [];
let statsTab = 'players';
let statsMinGames = 3;
let statsSort = { col: 'winPct', dir: 'desc' };
let statsGroupId = null;

// Auth state
let authToken = localStorage.getItem('authToken') || null;
let authDisplayName = null; // name from /api/me, null for guests

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const screens = document.querySelectorAll('.screen');

// --- Leaderboard ---

async function loadLeaderboard() {
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const res = await fetch('/api/leaderboard', { headers });
    if (!res.ok) return;
    renderLeaderboard(await res.json());
  } catch { /* non-critical — silent fail */ }
}

function renderLeaderboard(data) {
  const section = document.getElementById('leaderboard-section');
  if (!section) return;
  if (!data.top || data.top.length === 0) {
    section.innerHTML = '';
    return;
  }
  const medals = ['🥇', '🥈', '🥉', '', ''];
  let rows = data.top.map((e) =>
    `<div class="lb-row">
      <span class="lb-rank">${medals[e.rank - 1] || '#' + e.rank}</span>
      <span class="lb-name">${esc(e.displayName)}</span>
      <span class="lb-elo">${e.elo}</span>
      <span class="lb-stats">${e.wins}W / ${e.gamesPlayed}G</span>
    </div>`
  ).join('');
  if (data.me) {
    rows += `<div class="lb-divider"></div>
    <div class="lb-row lb-me">
      <span class="lb-rank">#${data.me.rank}</span>
      <span class="lb-name">You</span>
      <span class="lb-elo">${data.me.elo}</span>
      <span class="lb-stats">${data.me.wins}W / ${data.me.gamesPlayed}G</span>
    </div>`;
  }
  section.innerHTML = `<div class="lb-card"><div class="lb-header">🏆 Leaderboard</div>${rows}<div class="lb-footer"><button class="btn-link" onclick="showStats()">📊 Full stats →</button></div></div>`;
}

async function renderGroupLeaderboard(groupId) {
  const el = $('gameover-group-lb');
  if (!el) return;
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const res = await fetch(`/api/leaderboard?groupId=${encodeURIComponent(groupId)}`, { headers });
    if (!res.ok) { el.innerHTML = ''; return; }
    const data = await res.json();
    if (!data.top || data.top.length === 0) { el.innerHTML = ''; return; }
    const medals = ['🥇', '🥈', '🥉', '', ''];
    let rows = data.top.map((e) =>
      `<div class="lb-row">
        <span class="lb-rank">${medals[e.rank - 1] || '#' + e.rank}</span>
        <span class="lb-name">${esc(e.displayName)}</span>
        <span class="lb-elo">${e.elo}</span>
        <span class="lb-stats">${e.wins}W / ${e.gamesPlayed}G</span>
      </div>`
    ).join('');
    if (data.me) {
      rows += `<div class="lb-divider"></div>
      <div class="lb-row lb-me">
        <span class="lb-rank">#${data.me.rank}</span>
        <span class="lb-name">You</span>
        <span class="lb-elo">${data.me.elo}</span>
        <span class="lb-stats">${data.me.wins}W / ${data.me.gamesPlayed}G</span>
      </div>`;
    }
    el.innerHTML = `<div class="lb-card"><div class="lb-header">🏆 Group Leaderboard</div>${rows}</div>`;
  } catch {
    el.innerHTML = '';
  }
}

async function showStats() {
  showScreen('screen-stats');
  statsTab = 'players';
  statsSort = { col: 'elo', dir: 'desc' };
  $('stats-tab-players')?.classList.add('active');
  $('stats-tab-pairs')?.classList.remove('active');
  await loadStats();
}

async function loadStats() {
  const groupParam = statsGroupId ? `?groupId=${encodeURIComponent(statsGroupId)}` : '';
  try {
    const [playersRes, pairsRes, groupsRes] = await Promise.all([
      fetch(`/api/stats${groupParam}`),
      fetch(`/api/stats/pairs${groupParam}`),
      fetch('/api/groups'),
    ]);
    if (playersRes.ok) statsData.players = await playersRes.json();
    if (pairsRes.ok) statsData.pairs = await pairsRes.json();
    if (groupsRes.ok) {
      statsGroups = await groupsRes.json();
      renderStatsGroupDropdown();
    }
  } catch {
    // network error — render with whatever we have
  }
  renderStatsTab();
}

function renderStatsGroupDropdown() {
  const sel = $('stats-group-select');
  if (!sel) return;
  if (statsGroups.length === 0) {
    sel.style.display = 'none';
    return;
  }
  sel.style.display = '';
  sel.innerHTML =
    '<option value="">🌐 Global</option>' +
    statsGroups.map((g) => `<option value="${esc(g.groupId)}">${esc(g.groupName)}</option>`).join('');
  sel.value = statsGroupId ?? '';
  sel.onchange = () => {
    statsGroupId = sel.value || null;
    loadStats();
  };
}

function switchStatsTab(tab) {
  statsTab = tab;
  $('stats-tab-players')?.classList.toggle('active', tab === 'players');
  $('stats-tab-pairs')?.classList.toggle('active', tab === 'pairs');
  renderStatsTab();
}

function setMinGames(n) {
  statsMinGames = n;
  document.querySelectorAll('.min-games-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.value) === n);
  });
  renderStatsTab();
}

function sortStats(col) {
  if (statsSort.col === col) {
    statsSort.dir = statsSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    statsSort.col = col;
    statsSort.dir = 'desc';
  }
  renderStatsTab();
}

function renderStatsTab() {
  if (statsTab === 'players') {
    renderPlayersTab(statsData.players, statsMinGames, statsSort);
  } else {
    renderPairsTab(statsData.pairs, statsMinGames, statsSort);
  }
}

function renderPlayersTab(rows, minGames, sort) {
  const content = $('stats-content');
  if (!content) return;

  const filtered = rows.filter((r) => r.games >= minGames);

  const sortFns = {
    elo:              (r) => r.elo,
    winPct:           (r) => r.winPct,
    games:            (r) => r.games,
    bidderWinPct:     (r) => r.bidder.winPct,
    partnerWinPct:    (r) => r.partner.winPct,
    oppositionWinPct: (r) => r.opposition.winPct,
    name:             (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[sort.col] ?? sortFns.winPct;
  const sorted = [...filtered].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return sort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });

  if (sorted.length === 0) {
    content.innerHTML = `<p class="stats-empty">No players with ${minGames}+ games yet.</p>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const winPctClass = (p) => p >= 60 ? 'win-pct-high' : p >= 50 ? 'win-pct-mid' : 'win-pct-low';
  const fmtPct = (p, g) =>
    g === 0 ? '<span class="stats-na">—</span>' : `<span class="${winPctClass(p)}">${p}%</span>`;

  const arrow = (col) => {
    if (sort.col !== col) return '<span class="sort-arrow">⇅</span>';
    return `<span class="sort-arrow active">${sort.dir === 'desc' ? '▼' : '▲'}</span>`;
  };
  const th = (col, label, left) =>
    `<th class="${left ? 'stats-th-left' : ''}${sort.col === col ? ' sorted' : ''}" onclick="sortStats('${col}')">${label} ${arrow(col)}</th>`;

  const bodyRows = sorted.map((r, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`;
    return `<tr>
      <td class="stats-td-name">${medal} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${fmtPct(r.winPct, r.games)}</td>
      <td class="stats-td-num">${fmtPct(r.bidder.winPct, r.bidder.games)}</td>
      <td class="stats-td-num">${fmtPct(r.partner.winPct, r.partner.games)}</td>
      <td class="stats-td-num">${fmtPct(r.opposition.winPct, r.opposition.games)}</td>
      <td class="stats-td-num">${r.favBidSuit ? esc(r.favBidSuit) : '<span class="stats-na">—</span>'}</td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      ${th('name', 'Player', true)}
      ${th('elo', 'ELO', false)}
      ${th('games', 'G', false)}
      ${th('winPct', 'Win%', false)}
      ${th('bidderWinPct', 'Bid%', false)}
      ${th('partnerWinPct', 'Ptnr%', false)}
      ${th('oppositionWinPct', 'Def%', false)}
      <th>Suit</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table></div>`;
}

function renderPairsTab(rows, minGames, sort) {
  const content = $('stats-content');
  if (!content) return;

  const filtered = rows.filter((r) => r.games >= minGames);
  const sorted = [...filtered].sort((a, b) => {
    if (sort.col === 'games') return sort.dir === 'desc' ? b.games - a.games : a.games - b.games;
    return sort.dir === 'desc' ? b.winPct - a.winPct : a.winPct - b.winPct;
  });

  if (sorted.length === 0) {
    content.innerHTML = `<p class="stats-empty">No pairs with ${minGames}+ games together yet.</p>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const winPctClass = (p) => p >= 60 ? 'win-pct-high' : p >= 50 ? 'win-pct-mid' : 'win-pct-low';

  const arrow = (col) => {
    if (sort.col !== col) return '<span class="sort-arrow">⇅</span>';
    return `<span class="sort-arrow active">${sort.dir === 'desc' ? '▼' : '▲'}</span>`;
  };
  const th = (col, label, left) =>
    `<th class="${left ? 'stats-th-left' : ''}${sort.col === col ? ' sorted' : ''}" onclick="sortStats('${col}')">${label} ${arrow(col)}</th>`;

  const bodyRows = sorted.map((r, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`;
    return `<tr>
      <td class="stats-td-name">${medal} ${esc(r.player1)} + ${esc(r.player2)}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num"><span class="${winPctClass(r.winPct)}">${r.winPct}%</span></td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      <th class="stats-th-left">Teammates</th>
      ${th('games', 'G', false)}
      ${th('winPct', 'Win%', false)}
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table></div>`;
}

// --- Auth ---

async function loadTelegramWidget() {
  const container = document.getElementById('telegram-widget-container');
  if (container.hasChildNodes()) return; // already loaded
  try {
    const res = await fetch('/api/config');
    const { botUsername } = await res.json();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);
  } catch {
    // If config fails, just show guest option
  }
}

window.onTelegramAuth = async function (user) {
  try {
    const res = await fetch('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    if (!res.ok) throw new Error('Auth failed');
    const { token, displayName } = await res.json();
    authToken = token;
    authDisplayName = displayName;
    localStorage.setItem('authToken', token);
    showGameSection(displayName);
    loadLeaderboard();
  } catch {
    alert('Telegram login failed. Please try again.');
  }
};

async function initAuth() {
  if (authToken) {
    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const { displayName } = await res.json();
        authDisplayName = displayName;
        showGameSection(displayName);
        return;
      }
    } catch { /* fall through to guest */ }
    // Token invalid/expired — clear it
    authToken = null;
    authDisplayName = null;
    localStorage.removeItem('authToken');
  }
  // Not logged in — show login section
  showLoginSection();
}

function showLoginSection() {
  document.getElementById('login-section').classList.remove('hidden');
  document.getElementById('game-section').classList.add('hidden');
  loadTelegramWidget();
}

function showGameSection(name) {
  document.getElementById('login-section').classList.add('hidden');
  document.getElementById('game-section').classList.remove('hidden');
  const nameInput = document.getElementById('input-name');
  const nameLabel = document.querySelector('label[for="input-name"]');
  if (authDisplayName) {
    // Telegram user — name is authoritative from Telegram, not editable
    nameInput.value = authDisplayName;
    nameInput.readOnly = true;
    nameInput.classList.add('input-readonly');
    if (nameLabel) nameLabel.textContent = 'Your Name';
  } else {
    nameInput.readOnly = false;
    nameInput.classList.remove('input-readonly');
    if (name) nameInput.value = name;
    if (nameLabel) nameLabel.textContent = 'Your Name';
  }
  const authStatus = document.getElementById('auth-status');
  if (authDisplayName) {
    authStatus.innerHTML = `Logged in as <strong>${esc(authDisplayName)}</strong> · <a href="#" id="btn-logout">Logout</a>`;
    document.getElementById('btn-logout').addEventListener('click', (e) => {
      e.preventDefault();
      authToken = null;
      authDisplayName = null;
      localStorage.removeItem('authToken');
      showLoginSection();
      loadLeaderboard();
    });
  } else {
    authStatus.textContent = 'Playing as guest';
  }

  // Show "Create game for <group>" button if the user was recently in a group lobby
  const savedGroup = (() => { try { return JSON.parse(localStorage.getItem('lastGroup') || 'null'); } catch { return null; } })();
  const groupBtn = $('btn-create-group');
  if (groupBtn && savedGroup?.groupId && savedGroup?.groupName) {
    groupBtn.textContent = `Create game for ${savedGroup.groupName}`;
    groupBtn.classList.remove('hidden');
    groupBtn.dataset.groupId = savedGroup.groupId;
    groupBtn.dataset.groupName = savedGroup.groupName;
  } else if (groupBtn) {
    groupBtn.classList.add('hidden');
  }
}

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
/** HCP + distribution bonus (+1 per card beyond 4 in any suit). Mirrors bridge.ts getPoints. */
function calcHandPoints(hand) {
  if (!hand) return 0;
  let pts = 0;
  for (const suit of CARD_SUITS) {
    const cards = hand[suit] || [];
    for (const v of cards) {
      if (v === 'A') pts += 4;
      else if (v === 'K') pts += 3;
      else if (v === 'Q') pts += 2;
      else if (v === 'J') pts += 1;
    }
    if (cards.length >= 5) pts += cards.length - 4;
  }
  return pts;
}

function isRedSuit(suit) {
  return suit === '♥' || suit === '♦';
}

/** True when the card's suit is trump (not no-trump). */
function isTrumpPlaySuit(cardSuit, trumpSuit) {
  return !!(trumpSuit && trumpSuit !== '🚫' && cardSuit === trumpSuit);
}

function createCardEl(value, suit, opts = {}) {
  const div = document.createElement('div');
  div.className = `card ${isRedSuit(suit) ? 'red' : 'black'}`;
  if (opts.disabled) div.classList.add('disabled');
  if (opts.mini) {
    div.className = `card-mini ${isRedSuit(suit) ? 'red' : 'black'}`;
  }
  if (opts.trumpFire) div.classList.add('card-trump-fire');
  if (opts.partnerGlow) div.classList.add('card-partner-glow');
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
  const tokenParam = authToken ? `&token=${encodeURIComponent(authToken)}` : '';
  ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${roomCode}&playerId=${playerId}${tokenParam}`);

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

// --- Sounds ---
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBidSound(delay = 0) {
  try {
    const ctx = getAudioCtx();
    // Hammer slam: low thud with quick attack
    const bufSize = ctx.sampleRate * 0.12;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const t = i / ctx.sampleRate;
      // Low-frequency thud (80Hz) + noise burst, fast decay
      data[i] = (Math.sin(2 * Math.PI * 80 * t) * 0.6 + (Math.random() * 2 - 1) * 0.4)
        * Math.pow(1 - i / bufSize, 4);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0.7, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(t0);
  } catch {}
}

function playCardSound() {
  try {
    const ctx = getAudioCtx();
    const bufSize = ctx.sampleRate * 0.08;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 3);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {}
}

function playDingSound() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch {}
}

function playWinSound() {
  try {
    const ctx = getAudioCtx();
    // Ascending arpeggio: C5 E5 G5 C6
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.12;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.3, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {}
}

function playLoseSound() {
  try {
    const ctx = getAudioCtx();
    // Descending minor: A4 F4 D4 A3
    [440, 349, 294, 220].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.18;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch {}
}

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
      playBidSound(0);
      playBidSound(0.18);
      playBidSound(0.36);
      break;
    case 'bidMade':
      playBidSound();
      break;
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
    case 'bidMade':
      playBidSound();
      break;
    case 'cardPlayed':
      playCardSound();
      break;
    case 'trickWon':
      animateTrickWon(msg);
      break;
    case 'gameOver':
      lastGameOver = msg;
      break;
    case 'kicked':
      alert(msg.reason || 'You were removed from the room.');
      leaveGame();
      break;
    case 'playerKicked':
      // State update follows from the server's broadcastFullState — no manual action needed
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
  const table = $('play-table');
  const existing = table?.querySelector('.trick-won-banner') ?? document.querySelector('.trick-won-banner');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'trick-won-banner';
  div.textContent = `${winnerName} wins the trick`;
  (table || document.body).appendChild(div);
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
    const trumpFire = isTrumpPlaySuit(parts[1], gameState.trumpSuit);
    const cardEl = createCardEl(parts[0], parts[1], { mini: false, trumpFire });

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
function togglePractice(id, isPractice) {
  const el = $(id);
  if (!el) return;
  if (isPractice) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function statusDot(connected) {
  return `<span class="status-dot ${connected ? 'online' : 'offline'}"></span>`;
}

function renderPlayerStatusBar(container, players) {
  container.innerHTML = '';
  for (const p of players) {
    const item = document.createElement('span');
    item.className = 'player-status-chip';
    item.innerHTML = `${statusDot(p.connected)}${esc(p.name)}`;
    container.appendChild(item);
  }
}

function renderState() {
  const s = gameState;
  if (!s) return;

  // Spectator hasn't chosen a player yet — show selection screen (only for unset, not for full board)
  if (s.isSpectator && s.watchingSeat === -1) {
    showScreen('screen-spectator');
    renderSpectatorChoose(s);
    return;
  }

  switch (s.phase) {
    case 'lobby':
      clearTimeout(gameoverCountdownTimer);
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
      if (document.getElementById('screen-play').classList.contains('active')) {
        // Coming from play — keep the last trick visible for 2.5s before summary
        renderPlay(s);
        setTimeout(() => {
          showScreen('screen-gameover');
          renderGameOver(s);
        }, 2500);
      } else {
        // Reconnecting directly to gameover — show immediately
        showScreen('screen-gameover');
        renderGameOver(s);
      }
      break;
  }
}

// --- Lobby ---
function renderLobby(s) {
  renderSpectatorBar(s);
  $('lobby-room-code').textContent = s.roomCode;
  const list = $('lobby-players');
  list.innerHTML = '';
  const isHost = s.mySeat === 0 && !s.isSpectator;
  for (const p of s.players) {
    const item = document.createElement('div');
    item.className = 'player-item';
    const botIcon = p.isBot ? `<span class="bot-icon">${p.botLevel === 'sophisticated' ? '🎓' : p.botLevel === 'advanced' ? '🧠' : p.botLevel === 'basic' ? '🎯' : '🤖'}</span>` : '';
    const eloStr = (!p.isBot && p.elo) ? `ELO ${p.elo} · ` : '';
    const statsHtml = (!p.isBot && p.gamesPlayed)
      ? `<span class="lobby-stats">${eloStr}${p.wins}W / ${p.gamesPlayed}G</span>`
      : '';
    const notRankedBadge = (s.groupId && p.isGroupMember === false && !p.isBot)
      ? '<span class="not-ranked-badge">⚠️ not ranked</span>'
      : '';
    const kickBtn = (!s.isSpectator && s.phase === 'lobby' && p.seat !== s.mySeat && (!p.isBot || isHost))
      ? `<button class="kick-btn" onclick="send({type:'kickPlayer',seat:${p.seat}})">✕</button>`
      : '';
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span>${statusDot(p.connected)}${botIcon}<span class="lobby-player-name">${esc(p.name)}</span>${statsHtml}${notRankedBadge}${kickBtn}`;
    list.appendChild(item);
  }
  const remaining = NUM_PLAYERS - s.players.length;

  const countdownEl = $('lobby-countdown');
  const startBtn = $('lobby-start-btn');
  const statusEl = $('lobby-status');

  // Waiting-for-others state: player pressed Play Again but not everyone has yet
  if (s.phase === 'gameover') {
    clearTimeout(lobbyCountdownTimer);
    const readyCount = (s.readySeats ?? []).length;
    countdownEl.classList.add('hidden');
    startBtn.classList.add('hidden');
    statusEl.classList.remove('hidden');
    statusEl.textContent = `Waiting for others to play again... (${readyCount}/${NUM_PLAYERS})`;
    const addIntBotBtn = $('lobby-add-int-bot');
    const addAdvBotBtn = $('lobby-add-adv-bot');
    const addSophBotBtn = $('lobby-add-soph-bot');
    const addBasicBotBtn = $('lobby-add-basic-bot');
    for (const btn of [addIntBotBtn, addAdvBotBtn, addSophBotBtn, addBasicBotBtn]) {
      if (btn) btn.classList.add('hidden');
    }
    togglePractice('lobby-practice-notice', s.isPractice);
    return;
  }

  if (remaining === 0 && s.gameStartAt) {
    const secsLeft = Math.max(0, Math.ceil((s.gameStartAt - Date.now()) / 1000));
    countdownEl.textContent = `Game starting in ${secsLeft}...`;
    countdownEl.classList.remove('hidden');
    statusEl.classList.add('hidden');
    if (isHost) {
      startBtn.classList.remove('hidden');
    } else {
      startBtn.classList.add('hidden');
    }
    if (secsLeft > 0) {
      clearTimeout(lobbyCountdownTimer);
      lobbyCountdownTimer = setTimeout(() => { if (gameState && gameState.phase === 'lobby') renderLobby(gameState); }, 500);
    }
  } else {
    clearTimeout(lobbyCountdownTimer);
    lobbyCountdownTimer = null;
    countdownEl.classList.add('hidden');
    startBtn.classList.add('hidden');
    statusEl.classList.remove('hidden');
    statusEl.textContent = remaining > 0
      ? `Waiting for ${remaining} more player(s)...`
      : 'Game starting...';
  }

  const addIntBotBtn = $('lobby-add-int-bot');
  const addAdvBotBtn = $('lobby-add-adv-bot');
  const addSophBotBtn = $('lobby-add-soph-bot');
  const addBasicBotBtn = $('lobby-add-basic-bot');
  for (const btn of [addIntBotBtn, addAdvBotBtn, addSophBotBtn, addBasicBotBtn]) {
    if (!btn) continue;
    if (isHost && remaining > 0) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }

  togglePractice('lobby-practice-notice', s.isPractice);

  const sendTgBtn = $('btn-send-tg');
  if (sendTgBtn) {
    if (s.groupId && s.groupName) {
      sendTgBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>${esc(s.groupName)}`;
      sendTgBtn.classList.remove('hidden');
      // Remember this group for the home screen "create for group" button
      localStorage.setItem('lastGroup', JSON.stringify({ groupId: s.groupId, groupName: s.groupName }));
    } else {
      sendTgBtn.classList.add('hidden');
    }
  }
}

const SPECTATOR_COLORS = ['#06b6d4','#f97316','#a3e635','#f43f5e','#a855f7','#facc15'];

function renderSpectatorBar(s) {
  const bar = $('spectator-bar');
  if (!bar) return;
  const specs = s.spectators ?? [];
  if (specs.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    document.body.classList.remove('has-spectators');
    return;
  }
  bar.classList.remove('hidden');
  document.body.classList.add('has-spectators');
  bar.innerHTML = specs.map((sp, i) => {
    const color = SPECTATOR_COLORS[i % SPECTATOR_COLORS.length];
    return `<span class="spectator-tag" style="color:${color}">👁 ${esc(sp.name)}</span>`;
  }).join('');
}

// --- Bidding ---
function renderBidding(s) {
  renderPlayerStatusBar($('bidding-players'), s.players);
  renderSpectatorBar(s);
  renderSpectatorSwitcher(s, 'bidding-spectator-switcher');
  renderFullBoardInto(s, 'bidding-fullboard', ['bidding-hand-section']);

  const isFullBoard = s.isSpectator && s.watchingSeat === -2;
  const isMyTurn = s.turn === s.mySeat;

  if (isFullBoard) {
    $('bid-status').textContent = '👁 Viewing all hands';
  } else {
    $('bid-status').textContent = s.isSpectator
      ? `👁 Watching: ${s.players[s.watchingSeat]?.name || '?'}`
      : isMyTurn
        ? "It's your turn to bid!"
        : `Waiting for ${s.players[s.turn]?.name || '?'} to bid...`;
  }

  if (s.bid >= 0 && s.bidder >= 0) {
    $('bid-current').textContent = `Current bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  } else {
    $('bid-current').textContent = 'No bids yet';
  }

  const histEl = $('bid-history');
  if (histEl && s.bidHistory && s.bidHistory.length > 0) {
    histEl.innerHTML = s.bidHistory.slice().reverse().map(e =>
      e.bidNum === null
        ? `<div class="bid-hist-row bid-hist-pass"><span class="bid-hist-name">${esc(e.name)}</span><span class="bid-hist-dash"> - </span><span class="bid-hist-val">Pass</span></div>`
        : `<div class="bid-hist-row"><span class="bid-hist-name">${esc(e.name)}</span><span class="bid-hist-dash"> - </span><span class="bid-hist-val">${getBidFromNum(e.bidNum)}</span></div>`
    ).join('');
  } else if (histEl) {
    histEl.innerHTML = '';
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
      btn.disabled = s.isSpectator || !isMyTurn || bidNum <= s.bid;
      btn.addEventListener('click', () => send({ type: 'bid', bidNum }));
      grid.appendChild(btn);
    }
  }

  $('btn-pass').disabled = s.isSpectator || !isMyTurn;
  if (!isFullBoard) {
    renderHand($('bidding-hand'), s.hand, null, null);
  }
  togglePractice('bid-practice-badge', s.isPractice);

  // Hand label: show player name when spectating
  const handLabel = $('bidding-hand-label');
  if (handLabel) {
    if (s.isSpectator && s.watchingSeat >= 0) {
      handLabel.textContent = `${s.players[s.watchingSeat]?.name || '?'}'s Hand`;
    } else {
      handLabel.textContent = 'Your Hand';
    }
  }

  // Show HCP for spectators too
  const hcpBadge = $('bidding-hcp');
  if (hcpBadge && s.hand) {
    hcpBadge.textContent = `${calcHandPoints(s.hand)} pts`;
  } else if (hcpBadge) {
    hcpBadge.textContent = '';
  }
}

// --- Partner selection ---
function renderPartner(s) {
  renderPlayerStatusBar($('partner-players'), s.players);
  renderSpectatorBar(s);
  renderSpectatorSwitcher(s, 'partner-spectator-switcher');
  renderFullBoardInto(s, 'partner-fullboard', ['partner-hand-section']);

  const isFullBoard = s.isSpectator && s.watchingSeat === -2;
  const isBidder = s.mySeat === s.bidder;
  $('partner-title').textContent = isBidder ? 'Select Partner Card' : 'Partner Selection';
  $('partner-status').textContent = isFullBoard
    ? '👁 Viewing all hands'
    : isBidder
      ? 'Choose a card to call as your partner:'
      : `Waiting for ${s.players[s.bidder]?.name || '?'} to select partner...`;

  const grid = $('partner-grid');
  grid.innerHTML = '';

  if (isBidder && !s.isSpectator) {
    const values = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    for (const val of values) {
      for (const suit of CARD_SUITS) {
        const btn = document.createElement('button');
        const inHand = s.hand && s.hand[suit] && s.hand[suit].includes(val);
        btn.className = `partner-card-btn ${isRedSuit(suit) ? 'red' : ''}${inHand ? ' disabled' : ''}`;
        btn.textContent = `${val} ${suit}`;
        btn.disabled = inHand;
        if (!inHand) {
          btn.addEventListener('click', () => send({ type: 'selectPartner', card: `${val} ${suit}` }));
        }
        grid.appendChild(btn);
      }
    }
  }

  if (!isFullBoard) {
    renderHand($('partner-hand'), s.hand, null, null);
  }
  togglePractice('partner-practice-badge', s.isPractice);

  // Hand label: show player name when spectating
  const handLabel = $('partner-hand-label');
  if (handLabel) {
    if (s.isSpectator && s.watchingSeat >= 0) {
      handLabel.textContent = `${s.players[s.watchingSeat]?.name || '?'}'s Hand`;
    } else {
      handLabel.textContent = 'Your Hand';
    }
  }
}

// --- Play ---
function renderPlay(s) {
  renderSpectatorBar(s);
  renderSpectatorSwitcher(s, 'play-spectator-switcher');

  // Full board: show hand rows above the board, hide only the single bottom hand
  renderFullBoardInto(s, 'play-fullboard', ['play-hand-section']);
  // Info bar
  if (s.bid >= 0 && s.bidder >= 0) {
    $('play-bid-info').textContent = `Bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  }
  $('play-partner-info').textContent = s.partnerCard ? `Partner: ${s.partnerCard}` : '';
  $('play-trump-info').textContent = s.trumpSuit ? `Trump: ${s.trumpSuit}` : '';
  const practiceBadge = $('play-practice-badge');
  if (practiceBadge) {
    if (s.isPractice) practiceBadge.classList.remove('hidden');
    else practiceBadge.classList.add('hidden');
  }
  const table = $('play-table');
  if (table) {
    if (s.isPractice) table.classList.add('practice');
    else table.classList.remove('practice');
  }

  // Seat mapping: rotate so mySeat is always at bottom
  const seatOrder = [
    s.mySeat,
    (s.mySeat + 1) % 4,
    (s.mySeat + 2) % 4,
    (s.mySeat + 3) % 4,
  ];
  const positions = ['bottom', 'left', 'top', 'right'];
  const trickPositions = ['bot', 'left', 'top', 'right'];

  const activeSeatClasses = ['active-seat-bottom','active-seat-top','active-seat-left','active-seat-right'];
  if (table) activeSeatClasses.forEach((c) => table.classList.remove(c));

  for (let i = 0; i < 4; i++) {
    const seat = seatOrder[i];
    const pos = positions[i];
    const player = s.players[seat];
    const label = $(`seat-${pos}-label`);

    if (player) {
      const bidderStar = seat === s.bidder
        ? '<span class="bidder-star">★</span>'
        : '';
      const partnerStar = (s.partnerSeat !== -1 && seat === s.partnerSeat)
        ? '<span class="partner-star">★</span>'
        : '';
      const specs = s.spectators ?? [];
      const eyeIcons = specs
        .filter(sp => sp.watchingSeat >= 0)
        .map((sp, i) => sp.watchingSeat === seat
          ? `<span class="seat-spectator-eye" style="color:${SPECTATOR_COLORS[i % SPECTATOR_COLORS.length]}">👁</span>`
          : '')
        .join('');
      const sets = s.sets?.[seat] ?? 0;
      label.innerHTML = `<span class="seat-name-row">${bidderStar}${partnerStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span>${eyeIcons}</span><span class="seat-sets">${sets}</span>`;
      label.className = 'seat-label';
      if (seat === s.turn) {
        label.classList.add('active-turn');
        if (table) table.classList.add(`active-seat-${pos}`);
      }
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
      const trumpFire = isTrumpPlaySuit(parts[1], s.trumpSuit);
      const partnerGlow = !!(s.partnerCard && played === s.partnerCard);
      wrapper.appendChild(createCardEl(parts[0], parts[1], { mini: true, trumpFire, partnerGlow }));
    }
    trickArea.appendChild(wrapper);
  }

  // Sets display (only Last Trick button — per-player sets shown on seat labels)
  const setsDiv = $('sets-display');
  setsDiv.innerHTML = '';
  if (s.lastTrick && !s.trickComplete) {
    const ltBtn = document.createElement('button');
    ltBtn.className = 'btn-last-trick';
    ltBtn.textContent = 'Last Trick';
    ltBtn.addEventListener('click', showLastTrick);
    setsDiv.appendChild(ltBtn);
  }

  // Hand
  const isMyTurn = !s.isSpectator && s.turn === s.mySeat;
  if (isMyTurn && prevTurn !== s.mySeat) playDingSound();
  prevTurn = s.turn;
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

// --- Spectator ---

function renderSpectatorChoose(s) {
  const grid = $('spectator-grid');
  if (!grid) return;
  let html = s.players.map((p) =>
    `<button class="btn spectator-player-btn" onclick="sendWatchSeat(${p.seat})">
      <span class="spectator-seat-num">Seat ${p.seat + 1}</span>
      <span class="spectator-player-name">${esc(p.name)}</span>
    </button>`
  ).join('');
  // Add full board option
  html += `<button class="btn spectator-player-btn" onclick="sendWatchSeat(-2)">
    <span class="spectator-seat-num">👁</span>
    <span class="spectator-player-name">View Whole Board</span>
  </button>`;
  grid.innerHTML = html;
}

function sendWatchSeat(seat) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'watchSeat', seat }));
  }
}

/**
 * Render the spectator seat switcher into the given element ID.
 * Pass the ID of the switcher div (e.g. 'play-spectator-switcher').
 */
function renderSpectatorSwitcher(s, switcherId) {
  const switcher = $(switcherId);
  if (!switcher) return;

  if (!s.isSpectator) {
    switcher.classList.add('hidden');
    return;
  }

  switcher.classList.remove('hidden');
  const container = switcher.querySelector('.switcher-buttons');
  if (!container) return;

  let html = '';
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const active = s.watchingSeat === i ? 'active' : '';
    html += `<button class="${active}" onclick="sendWatchSeat(${i})">${esc(p.name)}</button>`;
  }
  const allActive = s.watchingSeat === -2 ? 'active' : '';
  html += `<button class="${allActive}" onclick="sendWatchSeat(-2)">View all players</button>`;
  container.innerHTML = html;
}

/**
 * Render the full-board hands view into the given container ID.
 * Hides the elements listed in hideIds, shows them again when not in full-board mode.
 */
function renderFullBoardInto(s, containerId, hideIds) {
  const container = $(containerId);
  if (!container) return;

  const isFullBoard = s.isSpectator && s.watchingSeat === -2 && s.allHands;

  // Toggle visibility of the fullboard vs the normal hand/table elements
  for (const id of hideIds) {
    const el = $(id);
    if (el) el.style.display = isFullBoard ? 'none' : '';
  }

  if (!isFullBoard) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = '';

  for (let seat = 0; seat < 4; seat++) {
    const hand = s.allHands[seat];
    const player = s.players[seat];
    if (!hand || !player) continue;

    const rowDiv = document.createElement('div');
    rowDiv.className = `fullboard-row ${s.turn === seat ? 'active-turn' : ''}`;

    const nameDiv = document.createElement('div');
    nameDiv.className = 'fullboard-name';
    nameDiv.innerHTML = `${esc(player.name)} <span class="hcp-badge">${calcHandPoints(hand)} pts</span>`;
    rowDiv.appendChild(nameDiv);

    // Use the same card-hand class as the normal hand display
    const handDiv = document.createElement('div');
    handDiv.className = 'card-hand';
    renderHand(handDiv, hand, CARD_SUITS, null);
    rowDiv.appendChild(handDiv);

    container.appendChild(rowDiv);
  }
}

function parseLoggedCard(cardStr) {
  const i = cardStr.lastIndexOf(' ');
  if (i <= 0) return null;
  return { value: cardStr.slice(0, i), suit: cardStr.slice(i + 1) };
}

// --- Game Over ---
function renderGameoverHands(s) {
  const container = $('gameover-hands');
  if (!container) return;
  container.innerHTML = '';
  if (!s.allInitialHands || !s.allFinalHands) return;

  const log = s.trickLog;

  function makeWrap(el, isTrickWinner) {
    const wrap = document.createElement('div');
    wrap.className = 'card-win-wrap';
    wrap.appendChild(el);
    if (isTrickWinner) {
      const star = document.createElement('span');
      star.className = 'trick-star';
      star.textContent = '✦';
      wrap.appendChild(star);
    }
    return wrap;
  }

  // Render one row per player in seat order (0–3)
  const sorted = [...s.players].sort((a, b) => a.seat - b.seat);
  for (const p of sorted) {
    const initial = s.allInitialHands[p.seat];
    const finalHand = s.allFinalHands[p.seat];
    if (!initial) continue;

    const row = document.createElement('div');
    row.className = 'gameover-hand-row';

    // Label with Bidder / Partner role badge
    const label = document.createElement('div');
    label.className = 'hand-label';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    label.appendChild(nameSpan);
    const pts = calcHandPoints(initial);
    const ptsSpan = document.createElement('span');
    ptsSpan.className = 'hand-pts';
    ptsSpan.textContent = `(${pts} points)`;
    label.appendChild(ptsSpan);
    if (p.seat === s.bidder) {
      const role = document.createElement('span');
      role.className = 'hand-role bidder';
      role.textContent = 'Bidder';
      label.appendChild(role);
    } else if (p.seat === s.partnerSeat && s.partnerSeat >= 0) {
      const role = document.createElement('span');
      role.className = 'hand-role partner';
      role.textContent = 'Partner';
      label.appendChild(role);
    }
    row.appendChild(label);

    const cards = document.createElement('div');
    cards.className = 'gameover-hand-cards';

    if (log && log.length > 0) {
      // Played cards in trick sequence, left to right
      const seatPlays = log
        .filter((e) => e.seat === p.seat)
        .sort((a, b) => a.trickNum - b.trickNum || a.playOrder - b.playOrder);
      for (const e of seatPlays) {
        const parsed = parseLoggedCard(e.card);
        if (!parsed) continue;
        const isTrump = s.trumpSuit && parsed.suit === s.trumpSuit && s.trumpSuit !== '🚫';
        const isPartnerCard = e.card === s.partnerCard;
        const isTrickWinner = s.trickWinners && s.trickWinners[e.trickNum - 1] === e.seat;
        const el = createCardEl(parsed.value, parsed.suit, { mini: true });
        el.classList.add(`po-${e.playOrder}`);
        if (isTrump) el.classList.add('card-trump-fire');
        if (isPartnerCard) el.classList.add('card-partner-glow');
        cards.appendChild(makeWrap(el, isTrickWinner));
      }
      // Unplayed cards (game ended early) appended faded at the right
      if (finalHand) {
        for (const suit of CARD_SUITS) {
          for (const value of (finalHand[suit] || [])) {
            const el = createCardEl(value, suit, { mini: true });
            el.classList.add('played');
            if (`${value} ${suit}` === s.partnerCard) el.classList.add('card-partner-glow');
            cards.appendChild(makeWrap(el, false));
          }
        }
      }
    } else {
      // Fallback: suit order, played cards faded
      for (const suit of CARD_SUITS) {
        const initialValues = initial[suit] || [];
        const finalSet = new Set(finalHand ? (finalHand[suit] || []) : []);
        for (const value of initialValues) {
          const played = !finalSet.has(value);
          const el = createCardEl(value, suit, { mini: true });
          if (played) el.classList.add('played');
          if (`${value} ${suit}` === s.partnerCard) el.classList.add('card-partner-glow');
          cards.appendChild(makeWrap(el, false));
        }
      }
    }

    row.appendChild(cards);
    container.appendChild(row);
  }
}

async function renderGameoverEloSection(s) {
  const el = $('gameover-group-lb');
  if (!el) return;
  el.innerHTML = '';

  if (!s.isPractice && s.gameId) {
    try {
      const res = await fetch(`/api/elo-deltas?gameId=${encodeURIComponent(s.gameId)}`);
      if (res.ok) {
        const deltas = await res.json();
        if (deltas.length > 0) {
          const rows = deltas.map((d) => {
            const sign = d.delta > 0 ? '+' : '';
            const cls = d.delta > 0 ? 'positive' : d.delta < 0 ? 'negative' : 'zero';
            return `<div class="elo-delta-row">
              <span class="elo-name">${esc(d.name)}</span>
              <span class="elo-change ${cls}">${sign}${d.delta} <span style="font-weight:400;font-size:0.8em;color:var(--text-dimmer)">${d.eloAfter}</span></span>
            </div>`;
          }).join('');
          el.innerHTML = `<div class="elo-delta-section"><div class="section-label">Elo this game</div>${rows}</div>`;
          return;
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: group leaderboard (or nothing for practice)
  if (!s.isPractice && s.groupId) {
    renderGroupLeaderboard(s.groupId);
  }
}

function renderGameOver(s) {
  // If this player already pressed "Play Again", show the lobby waiting screen instead
  const iAmReady = !s.isSpectator && s.readySeats && s.readySeats.includes(s.mySeat);
  if (iAmReady) {
    showScreen('screen-lobby');
    renderLobby(s);
    return;
  }

  renderPlayerStatusBar($('gameover-players'), s.players);
  renderSpectatorBar(s);
  const title = $('gameover-title');
  const detail = $('gameover-detail');
  const scores = $('gameover-scores');

  const bidderName = s.bidder >= 0 ? s.players[s.bidder].name : '?';
  const bidStr = s.bid >= 0 ? getBidFromNum(s.bid) : '?';

  const container = $('gameover-container');
  if (lastGameOver) {
    const myName = s.mySeat >= 0 ? s.players[s.mySeat].name : '';
    const iWon = lastGameOver.winnerNames.includes(myName);
    if (lastGameOver._soundPlayed !== true) {
      lastGameOver._soundPlayed = true;
      iWon ? playWinSound() : playLoseSound();
    }
    if (container) {
      container.classList.remove('outcome-win', 'outcome-loss');
      container.classList.add(iWon ? 'outcome-win' : 'outcome-loss');
    }
    const winnersStr = lastGameOver.winnerNames.join(' & ');
    title.textContent = s.isSpectator
      ? `${winnersStr} Won!`
      : iWon ? 'You Won!' : 'Game Over';
    detail.innerHTML = lastGameOver.bidderWon
      ? `${esc(winnersStr)} won the bid of ${esc(bidStr)}<br><span style="font-size:0.82em">(needed ${s.setsNeeded} sets)</span>`
      : `${esc(winnersStr)} defeated the bid of ${esc(bidStr)}`;
  } else {
    if (container) container.classList.remove('outcome-win', 'outcome-loss');
    title.textContent = 'Game Over';
    detail.innerHTML = `Bid: ${esc(bidderName)} — ${esc(bidStr)}<br><span style="font-size:0.82em">(needed ${s.setsNeeded} sets)</span>`;
  }

  togglePractice('gameover-practice-notice', s.isPractice);

  const partnerSeat = s.partnerSeat >= 0 ? s.partnerSeat : -1;
  const bidderTeamSeats = new Set(
    [s.bidder, partnerSeat].filter((seat) => seat >= 0),
  );

  scores.innerHTML = '';
  for (let i = 0; i < s.players.length; i++) {
    const item = document.createElement('div');
    const isBidderTeam = bidderTeamSeats.has(i);
    item.className = `score-item${isBidderTeam ? ' team-bidder' : ''}`;
    const roleBadge = i === s.bidder
      ? '<span class="role-badge">Bidder</span>'
      : i === partnerSeat
        ? '<span class="role-badge">Partner</span>'
        : '';
    item.innerHTML = `<span class="name">${esc(s.players[i].name)}${roleBadge}</span><span class="sets-won">${s.sets[i]} sets</span>`;
    scores.appendChild(item);
  }

  const groupLbEl = $('gameover-group-lb');
  if (groupLbEl) groupLbEl.innerHTML = '';
  renderGameoverEloSection(s);

  renderGameoverHands(s);

  // Ready list
  const readySeats = s.readySeats ?? [];
  const readyList = $('gameover-ready-list');
  if (readyList) {
    readyList.innerHTML = s.players.map((p) =>
      `<span class="gameover-ready-player${readySeats.includes(p.seat) ? ' ready' : ''}">
        ${readySeats.includes(p.seat) ? '✓' : '○'} ${esc(p.name)}
      </span>`
    ).join('');
  }

  // Play Again button state
  const playAgainBtn = $('btn-play-again');
  const iAmReadyBtn = !s.isSpectator && readySeats.includes(s.mySeat);
  if (playAgainBtn) {
    playAgainBtn.disabled = iAmReadyBtn || s.isSpectator;
    playAgainBtn.textContent = (iAmReadyBtn || s.isSpectator) ? 'Waiting...' : 'Play Again';
  }

  // Countdown (reuses same pattern as lobby)
  const countdownEl = $('gameover-countdown');
  if (countdownEl) {
    if (s.gameStartAt) {
      countdownEl.classList.remove('hidden');
      clearTimeout(gameoverCountdownTimer);
      const tick = () => {
        const rem = Math.ceil((s.gameStartAt - Date.now()) / 1000);
        if (rem <= 0) { countdownEl.textContent = 'Starting...'; return; }
        countdownEl.textContent = `Starting in ${rem}s...`;
        gameoverCountdownTimer = setTimeout(tick, 500);
      };
      tick();
    } else {
      countdownEl.classList.add('hidden');
      clearTimeout(gameoverCountdownTimer);
    }
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
    if (gameState && gameState.phase === 'lobby') {
      try { ws.send(JSON.stringify({ type: 'leave' })); } catch { /* ignore */ }
    }
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

// Show login section initially; initAuth will switch to game-section if already authed
document.getElementById('login-section').classList.remove('hidden');
document.getElementById('game-section').classList.add('hidden');

document.getElementById('btn-guest').addEventListener('click', () => {
  authToken = null;
  authDisplayName = null;
  showGameSection(null);
});

// Kick off auth check on page load
initAuth();
loadLeaderboard();

$('btn-create').addEventListener('click', async () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);
  if (authToken && authDisplayName && playerName !== authDisplayName) {
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ displayName: playerName }),
    }).catch(() => {});
    authDisplayName = playerName;
  }

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

$('btn-create-group').addEventListener('click', async () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);
  if (authToken && authDisplayName && playerName !== authDisplayName) {
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ displayName: playerName }),
    }).catch(() => {});
    authDisplayName = playerName;
  }

  const btn = $('btn-create-group');
  const groupId = btn.dataset.groupId;
  const groupName = btn.dataset.groupName;
  btn.disabled = true;
  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, groupName, sendInvite: true, fromName: playerName }),
    });
    const data = await res.json();
    setRoomCode(data.roomCode);
    showScreen('screen-lobby');
    $('lobby-room-code').textContent = roomCode;
    connect();
  } catch (err) {
    alert('Failed to create game');
  } finally {
    btn.disabled = false;
  }
});

$('btn-join').addEventListener('click', () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);
  if (authToken && authDisplayName && playerName !== authDisplayName) {
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ displayName: playerName }),
    }).catch(() => {});
    authDisplayName = playerName;
  }

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

$('btn-send-tg').addEventListener('click', async () => {
  if (!roomCode) return;
  const btn = $('btn-send-tg');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  try {
    await fetch('/api/send-group-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomCode }),
    });
    btn.textContent = 'Sent!';
    setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 2000);
  } catch {
    btn.disabled = false;
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
