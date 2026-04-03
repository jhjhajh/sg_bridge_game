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
      <span class="lb-stats">${e.wins}W / ${e.gamesPlayed}G</span>
    </div>`
  ).join('');
  if (data.me) {
    rows += `<div class="lb-divider"></div>
    <div class="lb-row lb-me">
      <span class="lb-rank">#${data.me.rank}</span>
      <span class="lb-name">You</span>
      <span class="lb-stats">${data.me.wins}W / ${data.me.gamesPlayed}G</span>
    </div>`;
  }
  section.innerHTML = `<div class="lb-card"><div class="lb-header">🏆 Leaderboard</div>${rows}</div>`;
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
        <span class="lb-stats">${e.wins}W / ${e.gamesPlayed}G</span>
      </div>`
    ).join('');
    if (data.me) {
      rows += `<div class="lb-divider"></div>
      <div class="lb-row lb-me">
        <span class="lb-rank">#${data.me.rank}</span>
        <span class="lb-name">You</span>
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
  statsSort = { col: 'winPct', dir: 'desc' };
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
  if (name) nameInput.value = name; // prefer auth name over localStorage
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

  // Spectator hasn't chosen a player yet — show selection screen
  if (s.isSpectator && s.watchingSeat < 0) {
    showScreen('screen-spectator');
    renderSpectatorChoose(s);
    return;
  }

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
  $('lobby-room-code').textContent = s.roomCode;
  const list = $('lobby-players');
  list.innerHTML = '';
  const isHost = s.mySeat === 0 && !s.isSpectator;
  for (const p of s.players) {
    const item = document.createElement('div');
    item.className = 'player-item';
    const botIcon = p.isBot ? '<span class="bot-icon">🤖</span>' : '';
    const statsHtml = (!p.isBot && p.gamesPlayed)
      ? `<span class="lobby-stats">${p.wins}W / ${p.gamesPlayed}G</span>`
      : '';
    const notRankedBadge = (s.groupId && p.isGroupMember === false && !p.isBot)
      ? '<span class="not-ranked-badge">⚠️ not ranked</span>'
      : '';
    const isLastBot = p.isBot && p.seat === s.players.length - 1;
    const removeBtn = (isHost && isLastBot)
      ? `<button class="bot-remove-btn" onclick="send({type:'removeBot'})">✕</button>`
      : '';
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span>${statusDot(p.connected)}${botIcon}<span class="lobby-player-name">${esc(p.name)}</span>${statsHtml}${notRankedBadge}${removeBtn}`;
    list.appendChild(item);
  }
  const remaining = NUM_PLAYERS - s.players.length;
  $('lobby-status').textContent = remaining > 0
    ? `Waiting for ${remaining} more player(s)...`
    : 'Game starting...';

  const addBotBtn = $('lobby-add-bot');
  if (addBotBtn) {
    if (isHost && remaining > 0) {
      addBotBtn.classList.remove('hidden');
    } else {
      addBotBtn.classList.add('hidden');
    }
  }
}

// --- Bidding ---
function renderBidding(s) {
  renderPlayerStatusBar($('bidding-players'), s.players);
  const isMyTurn = s.turn === s.mySeat;
  $('bid-status').textContent = s.isSpectator
    ? `👁 Watching: ${s.players[s.watchingSeat]?.name || '?'}`
    : isMyTurn
      ? "It's your turn to bid!"
      : `Waiting for ${s.players[s.turn]?.name || '?'} to bid...`;

  if (s.bid >= 0 && s.bidder >= 0) {
    $('bid-current').textContent = `Current bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  } else {
    $('bid-current').textContent = 'No bids yet';
  }

  const histEl = $('bid-history');
  if (histEl && s.bidHistory && s.bidHistory.length > 0) {
    histEl.innerHTML = s.bidHistory.slice().reverse().map(e =>
      e.bidNum === null
        ? `<div class="bid-hist-row bid-hist-pass"><span class="bid-hist-name">${esc(e.name)}</span><span class="bid-hist-val">Pass</span></div>`
        : `<div class="bid-hist-row"><span class="bid-hist-name">${esc(e.name)}</span><span class="bid-hist-val">${getBidFromNum(e.bidNum)}</span></div>`
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
  renderHand($('bidding-hand'), s.hand, null, null);
}

// --- Partner selection ---
function renderPartner(s) {
  renderPlayerStatusBar($('partner-players'), s.players);
  const isBidder = s.mySeat === s.bidder;
  $('partner-title').textContent = isBidder ? 'Select Partner Card' : 'Partner Selection';
  $('partner-status').textContent = isBidder
    ? 'Choose a card to call as your partner:'
    : `Waiting for ${s.players[s.bidder]?.name || '?'} to select partner...`;

  const grid = $('partner-grid');
  grid.innerHTML = '';

  if (isBidder && !s.isSpectator) {
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

  const table = $('play-table');
  const activeSeatClasses = ['active-seat-bottom','active-seat-top','active-seat-left','active-seat-right'];
  if (table) activeSeatClasses.forEach((c) => table.classList.remove(c));

  for (let i = 0; i < 4; i++) {
    const seat = seatOrder[i];
    const pos = positions[i];
    const player = s.players[seat];
    const label = $(`seat-${pos}-label`);

    if (player) {
      let text = player.name;
      if (seat === s.bidder) text += ' ★';
      const sets = s.sets?.[seat] ?? 0;
      label.innerHTML = `<span class="seat-name-row">${statusDot(player.connected)}<span class="seat-name">${esc(text)}</span></span><span class="seat-sets">${sets}</span>`;
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
      wrapper.appendChild(createCardEl(parts[0], parts[1], { mini: true }));
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
  grid.innerHTML = s.players.map((p) =>
    `<button class="btn spectator-player-btn" onclick="sendWatchSeat(${p.seat})">
      <span class="spectator-seat-num">Seat ${p.seat + 1}</span>
      <span class="spectator-player-name">${esc(p.name)}</span>
    </button>`
  ).join('');
}

function sendWatchSeat(seat) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'watchSeat', seat }));
  }
}

// --- Game Over ---
function renderGameOver(s) {
  renderPlayerStatusBar($('gameover-players'), s.players);
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
    title.textContent = iWon ? 'You Won!' : 'Game Over';
    const winnersStr = lastGameOver.winnerNames.join(' & ');
    detail.textContent = lastGameOver.bidderWon
      ? `${winnersStr} won the bid of ${bidStr} (needed ${s.setsNeeded} sets)`
      : `${winnersStr} defeated the bid of ${bidStr}`;
  } else {
    if (container) container.classList.remove('outcome-win', 'outcome-loss');
    title.textContent = 'Game Over';
    detail.textContent = `Bid: ${bidderName} - ${bidStr} (needed ${s.setsNeeded} sets)`;
  }

  // Determine which players are on the bidder's team
  let bidderTeamNames = null;
  if (lastGameOver && s.bidder >= 0) {
    bidderTeamNames = new Set(
      lastGameOver.bidderWon
        ? lastGameOver.winnerNames
        : s.players.map((p) => p.name).filter((n) => !lastGameOver.winnerNames.includes(n)),
    );
  }
  const partnerSeat = bidderTeamNames
    ? s.players.findIndex((p, idx) => idx !== s.bidder && bidderTeamNames.has(p.name))
    : -1;

  scores.innerHTML = '';
  for (let i = 0; i < s.players.length; i++) {
    const item = document.createElement('div');
    const isBidderTeam = bidderTeamNames && bidderTeamNames.has(s.players[i].name);
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
  if (s.groupId) {
    renderGroupLeaderboard(s.groupId);
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
