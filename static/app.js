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
  // On localhost, prefix with tg_ to bypass the Telegram auth check on the server
  const prefix = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'tg_dev_' : '';
  playerId = prefix + crypto.randomUUID();
}
localStorage.setItem('playerId', playerId);

let playerName = localStorage.getItem('playerName') || '';
let roomCode = hashInfo.room || sessionStorage.getItem('roomCode') || null;
let roomCodeFromHash = hashInfo.room ? true : false;  // Track if room came from invite link
let joinAs = null;  // 'player' or 'spectator' for joining via invite
let reconnectTimer = null;
let reconnectDelay = 2000;
let gameState = null;
let pendingPlay = null;
let awaitingGameState = true;
let lastGameOver = null;
let prevTurn = -1;
let lobbyCountdownTimer = null;
let gameoverCountdownTimer = null;
let disconnectCountdownTimer = null;

// Stats state
let statsData = { players: [], pairs: [], betting: null };
let statsGroups = [];
let statsTab = 'players';
let statsMinGames = 3;
let statsSort = { col: 'winPct', dir: 'desc' };
let bettingSort = { col: 'bettingElo', dir: 'desc' };
let statsGroupId = null;

// Auth state
let authToken = localStorage.getItem('authToken') || null;
let authDisplayName = null; // name from /api/me, null for guests
let authNameRequired = false;
let identityReady = false;
let identityNeedsLogin = false;
let identitySubmission = false;

// Betting state
let myBet = null;
let myBetGameId = null;
let myBetFetching = false;

// Ping cooldown state (client-side for UI feedback)
let pingCooldowns = {}; // { seat: timestamp }

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
  // Shared Fun Central card with a Bridge | Regicide switch (static/leaderboard.js).
  if (window.FunLeaderboard) {
    window.FunLeaderboard.mount(section, { game: 'bridge', bridgeData: data, footer: '<button class="btn-link" onclick="showStats()">📊 Full stats →</button>' });
    return;
  }
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

// --- Game history / replay ---

let historyGames = [];
let replayData = null;
let replayTrickIdx = 0; // 0 = pre-play; 1..N = plays up to and including trick N

function formatBidLabel(bidLevel, bidSuit) {
  return `${bidLevel} ${bidSuit}`;
}

function ratingGlyph(rating) {
  switch (rating) {
    case 'best': return '★';
    case 'good': return '✓';
    case 'inaccuracy': return '?!';
    case 'mistake': return '?';
    case 'blunder': return '??';
    default: return '';
  }
}

function formatPlayedAt(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const datePart = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

async function showMatchHistory() {
  showScreen('screen-history');
  const list = $('history-list');
  const footer = $('history-footer');
  list.innerHTML = '<p class="status-text">Loading...</p>';
  footer.innerHTML = '';
  if (!authToken) {
    list.innerHTML = '<p class="status-text">Please log in to see your games.</p>';
    return;
  }
  try {
    const res = await fetch('/api/games/mine?limit=20', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      list.innerHTML = '<p class="status-text">Could not load history.</p>';
      return;
    }
    historyGames = await res.json();
    renderHistoryList();
  } catch {
    list.innerHTML = '<p class="status-text">Network error.</p>';
  }
}

function renderHistoryList() {
  const list = $('history-list');
  if (!historyGames || historyGames.length === 0) {
    list.innerHTML = '<p class="status-text">No completed games yet.</p>';
    return;
  }
  const rows = historyGames.map((g) => {
    const trump = g.trumpSuit ?? g.bidSuit;
    const bidderName = g.seatMap.find((s) => s.seat === g.bidderSeat)?.name ?? '?';
    const othersLine = g.seatMap
      .filter((s) => s.seat !== g.bidderSeat)
      .map((s) => esc(s.name))
      .join(', ');
    const resultCls = g.won ? 'history-row-won' : 'history-row-lost';
    const resultBadge = g.won ? 'Won' : 'Lost';
    const roleLabel = g.role === 'bidder' ? 'You bid' : g.role === 'partner' ? 'Partner' : 'Opposition';
    const practiceBadge = g.isPractice ? '<span class="history-practice">Practice</span>' : '';
    return `
      <div class="history-row ${resultCls}" data-gameid="${esc(g.gameId)}">
        <div class="history-row-main">
          <span class="history-bid">${formatBidLabel(g.bidLevel, trump)}</span>
          <span class="history-role">${roleLabel}</span>
          ${practiceBadge}
          <span class="history-result">${resultBadge} · ${g.tricksWon}/${g.setsNeeded} tricks</span>
        </div>
        <div class="history-row-sub">
          <span class="history-bidder">Bidder: ${esc(bidderName)}</span>
          <span class="history-others">${othersLine}</span>
          <span class="history-date">${formatPlayedAt(g.playedAt)}</span>
        </div>
      </div>`;
  }).join('');
  $('history-list').innerHTML = rows;
  document.querySelectorAll('#history-list .history-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.getAttribute('data-gameid');
      if (id) showReplay(id);
    });
  });
  const footer = $('history-footer');
  if (historyGames.length >= 20) {
    footer.innerHTML = '<button id="history-load-more" class="btn btn-secondary btn-small">Load more</button>';
    $('history-load-more').addEventListener('click', loadMoreHistory);
  } else {
    footer.innerHTML = '';
  }
}

async function loadMoreHistory() {
  if (!authToken || historyGames.length === 0) return;
  const oldest = historyGames[historyGames.length - 1].playedAt;
  try {
    const res = await fetch(`/api/games/mine?limit=20&before=${oldest}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const more = await res.json();
    historyGames = historyGames.concat(more);
    renderHistoryList();
  } catch { /* silent */ }
}

async function showReplay(gameId) {
  showScreen('screen-replay');
  $('replay-header').innerHTML = '<p class="status-text">Loading...</p>';
  $('replay-hands').innerHTML = '';
  $('replay-progress').textContent = '';
  if (!authToken) return;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      $('replay-header').innerHTML = '<p class="status-text">Could not load this game.</p>';
      return;
    }
    replayData = await res.json();
    replayTrickIdx = 0;
    renderReplay();
  } catch {
    $('replay-header').innerHTML = '<p class="status-text">Network error.</p>';
  }
}

const RATING_LABELS = [
  ['best', 'best'],
  ['good', 'good'],
  ['inaccuracy', 'inaccuracy'],
  ['mistake', 'mistake'],
  ['blunder', 'blunder'],
];

function countRatingsBySeat(ratings, seats) {
  const set = new Set(seats);
  const counts = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const r of (ratings || [])) {
    if (set.has(r.seat)) counts[r.rating] = (counts[r.rating] || 0) + 1;
  }
  return counts;
}

function findPartnerSeatFromHands(initialHands, partnerCard) {
  if (!partnerCard) return -1;
  const i = partnerCard.lastIndexOf(' ');
  if (i <= 0) return -1;
  const value = partnerCard.slice(0, i);
  const suit = partnerCard.slice(i + 1);
  for (let seat = 0; seat < (initialHands || []).length; seat++) {
    const h = initialHands[seat];
    if (h && (h[suit] || []).includes(value)) return seat;
  }
  return -1;
}

function totalTricks() {
  if (!replayData) return 0;
  let max = 0;
  for (const e of replayData.trickLog) if (e.trickNum > max) max = e.trickNum;
  return max;
}

function renderReplay() {
  if (!replayData) return;
  const r = replayData;
  const n = totalTricks();
  const trump = r.trumpSuit ?? r.bidSuit;
  const bidderName = r.seatMap.find((s) => s.seat === r.bidderSeat)?.name ?? '?';
  const tricksByTeam = `Bidder team ${r.tricksWon[r.bidderSeat]}${
    r.winningTeam === 'bidder' ? ' ✓' : ''
  }`;
  const sum = r.ratingSummary || { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  const pill = (cls, n, label) =>
    `<span class="rating-pill rating-${cls}" title="${label}"><span class="rating-dot"></span>${n} ${label}</span>`;
  const compactPill = (cls, n, label) =>
    `<span class="rating-pill rating-${cls}" title="${label}"><span class="rating-dot"></span>${n}</span>`;
  const pillsFor = (counts) => RATING_LABELS
    .map(([cls, label]) => compactPill(cls, counts[cls] || 0, label))
    .join('');
  const summaryRow = `
    <div class="replay-summary">
      ${pill('best', sum.best, 'best')}
      ${pill('good', sum.good, 'good')}
      ${pill('inaccuracy', sum.inaccuracy, 'inaccuracy')}
      ${pill('mistake', sum.mistake, 'mistake')}
      ${pill('blunder', sum.blunder, 'blunder')}
    </div>`;

  // Per-seat and per-team breakdown
  const partnerSeat = findPartnerSeatFromHands(r.initialHands, r.partnerCard);
  const isSolo = partnerSeat < 0 || partnerSeat === r.bidderSeat;
  const bidderTeamSeats = isSolo ? [r.bidderSeat] : [r.bidderSeat, partnerSeat];
  const oppositionSeats = [0, 1, 2, 3].filter((s) => !bidderTeamSeats.includes(s));
  const roleOf = (seat) =>
    seat === r.bidderSeat ? 'bidder'
    : seat === partnerSeat ? 'partner'
    : 'opposition';
  const roleLabel = { bidder: 'Bidder', partner: 'Partner', opposition: 'Opposition' };
  const teamRow = (label, seats) => `
    <div class="replay-breakdown-row">
      <span class="replay-breakdown-label">${esc(label)}</span>
      <div class="replay-breakdown-pills">${pillsFor(countRatingsBySeat(r.ratings, seats))}</div>
    </div>`;
  const playerRow = (seat) => {
    const name = r.seatMap.find((s) => s.seat === seat)?.name ?? `Seat ${seat}`;
    const role = roleOf(seat);
    return `
    <div class="replay-breakdown-row">
      <span class="replay-breakdown-label">
        ${esc(name)}
        <span class="replay-breakdown-role role-${role}">${roleLabel[role]}</span>
      </span>
      <div class="replay-breakdown-pills">${pillsFor(countRatingsBySeat(r.ratings, [seat]))}</div>
    </div>`;
  };
  const breakdown = `
    <div class="replay-breakdown">
      <div class="replay-breakdown-section">
        ${teamRow(isSolo ? 'Bidder (solo)' : 'Bidder team', bidderTeamSeats)}
        ${teamRow('Opposition', oppositionSeats)}
      </div>
      <div class="replay-breakdown-section">
        ${[0, 1, 2, 3].map(playerRow).join('')}
      </div>
    </div>`;

  const practiceBadge = r.isPractice ? '<span class="replay-practice">Practice · unrated</span>' : '';
  $('replay-header').innerHTML = `
    <div class="replay-header-row">
      <span class="replay-bid">${formatBidLabel(r.bidLevel, trump)}</span>
      <span class="replay-bidder">Bidder: ${esc(bidderName)}</span>
      <span class="replay-partner-card">Partner card: ${esc(r.partnerCard)}</span>
      ${practiceBadge}
    </div>
    <div class="replay-header-row">
      <span class="replay-result">${r.winningTeam === 'bidder' ? '🏆 Bidder team won' : '🛡 Opposition won'}</span>
      <span class="replay-sets">Bidder tricks ${r.tricksWon[r.bidderSeat]} / ${r.bidLevel + 6} needed</span>
    </div>
    ${summaryRow}
    ${breakdown}`;

  // Progress label and button states
  const label = replayTrickIdx === 0
    ? `Deal · 0/${n} tricks played`
    : `Trick ${replayTrickIdx}/${n}`;
  $('replay-progress').textContent = label;
  $('replay-prev').disabled = replayTrickIdx === 0;
  $('replay-next').disabled = replayTrickIdx >= n;

  renderReplayHands();
}

function renderReplayHands() {
  const container = $('replay-hands');
  container.innerHTML = '';
  if (!replayData) return;
  const r = replayData;

  // Build a synthetic PlayerGameView-like object to reuse the rendering semantics
  // from renderGameoverHands (but we slice trickLog up to replayTrickIdx).
  const shownLog = r.trickLog.filter((e) => e.trickNum <= replayTrickIdx);

  // partnerCard glow should only appear once the partner card has actually been played
  const partnerCardRevealed = shownLog.some((e) => e.card === r.partnerCard);

  // Derive partnerSeat for label (seat that played the partner card, if revealed)
  const partnerPlay = shownLog.find((e) => e.card === r.partnerCard);
  const partnerSeat = partnerPlay ? partnerPlay.seat : -1;

  for (let seat = 0; seat < NUM_PLAYERS; seat++) {
    const initial = r.initialHands[seat];
    if (!initial) continue;
    const seatName = r.seatMap.find((s) => s.seat === seat)?.name ?? `Seat ${seat}`;

    const row = document.createElement('div');
    row.className = 'gameover-hand-row';

    const label = document.createElement('div');
    label.className = 'hand-label';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = seatName;
    label.appendChild(nameSpan);
    const pts = calcHandPoints(initial);
    const ptsSpan = document.createElement('span');
    ptsSpan.className = 'hand-pts';
    ptsSpan.textContent = `(${pts} points)`;
    label.appendChild(ptsSpan);
    if (seat === r.bidderSeat) {
      const role = document.createElement('span');
      role.className = 'hand-role bidder';
      role.textContent = 'Bidder';
      label.appendChild(role);
    } else if (seat === partnerSeat && partnerSeat >= 0) {
      const role = document.createElement('span');
      role.className = 'hand-role partner';
      role.textContent = 'Partner';
      label.appendChild(role);
    }
    row.appendChild(label);

    const cards = document.createElement('div');
    cards.className = 'gameover-hand-cards';

    // Played cards (up to current trickIdx) in trick order
    const seatPlays = shownLog
      .filter((e) => e.seat === seat)
      .sort((a, b) => a.trickNum - b.trickNum || a.playOrder - b.playOrder);
    const playedCardStrings = new Set(seatPlays.map((e) => e.card));

    for (const e of seatPlays) {
      const parsed = parseLoggedCard(e.card);
      if (!parsed) continue;
      const isTrump = r.trumpSuit && parsed.suit === r.trumpSuit && r.trumpSuit !== '🚫';
      const isPartnerCard = e.card === r.partnerCard && partnerCardRevealed;
      const isTrickWinner = r.trickWinners[e.trickNum - 1] === e.seat;
      const el = createCardEl(parsed.value, parsed.suit, { mini: true });
      el.classList.add(`po-${e.playOrder}`);
      if (isTrump) el.classList.add('card-trump-fire');
      if (isPartnerCard) el.classList.add('card-partner-glow');
      const wrap = document.createElement('div');
      wrap.className = 'card-win-wrap';
      wrap.appendChild(el);
      if (isTrickWinner) {
        const star = document.createElement('span');
        star.className = 'trick-star';
        star.textContent = '✦';
        wrap.appendChild(star);
      }
      const rating = (r.ratings || []).find(
        (x) => x.trickNum === e.trickNum && x.seat === e.seat,
      );
      if (rating) {
        const badge = document.createElement('span');
        badge.className = `rating-badge rating-${rating.rating}`;
        badge.title = rating.reason;
        badge.textContent = ratingGlyph(rating.rating);
        wrap.appendChild(badge);
      }
      cards.appendChild(wrap);
    }

    // Unplayed cards: show from the initial hand, excluding anything already played
    for (const suit of CARD_SUITS) {
      for (const value of (initial[suit] || [])) {
        const cardStr = `${value} ${suit}`;
        if (playedCardStrings.has(cardStr)) continue;
        const el = createCardEl(value, suit, { mini: true });
        // Faded style for unplayed at end (reuses .played styling)
        el.classList.add('played');
        if (cardStr === r.partnerCard && partnerCardRevealed) el.classList.add('card-partner-glow');
        const wrap = document.createElement('div');
        wrap.className = 'card-win-wrap';
        wrap.appendChild(el);
        cards.appendChild(wrap);
      }
    }
    row.appendChild(cards);
    container.appendChild(row);
  }
}

function replayStep(delta) {
  if (!replayData) return;
  const n = totalTricks();
  replayTrickIdx = Math.max(0, Math.min(n, replayTrickIdx + delta));
  renderReplay();
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
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const [playersRes, pairsRes, groupsRes, bettingRes] = await Promise.all([
      fetch(`/api/stats${groupParam}`),
      fetch(`/api/stats/pairs${groupParam}`),
      fetch('/api/groups'),
      fetch('/api/betting/leaderboard', { headers }),
    ]);
    if (playersRes.ok) statsData.players = await playersRes.json();
    if (pairsRes.ok) statsData.pairs = await pairsRes.json();
    if (groupsRes.ok) {
      statsGroups = await groupsRes.json();
      renderStatsGroupDropdown();
    }
    if (bettingRes.ok) statsData.betting = await bettingRes.json();
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
  $('stats-tab-betting')?.classList.toggle('active', tab === 'betting');
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
  } else if (statsTab === 'betting') {
    renderBettingTab(statsData.betting);
  } else {
    renderPairsTab(statsData.pairs, statsMinGames, statsSort);
  }
}

function sortBetting(col) {
  if (bettingSort.col === col) {
    bettingSort.dir = bettingSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    bettingSort.col = col;
    bettingSort.dir = 'desc';
  }
  renderBettingTab(statsData.betting);
}

function renderBettingTab(data) {
  const content = $('stats-content');
  if (!content) return;

  const top = data?.top ?? [];
  const me = data?.me ?? null;

  if (top.length === 0) {
    content.innerHTML = '<p class="betting-tab-desc">Predict game outcomes during bidding to earn Bet ELO.</p><div class="betting-empty"><p class="stats-empty">No bettors on the leaderboard yet.</p></div>';
    return;
  }

  const sortFns = {
    bettingElo:  (r) => r.bettingElo,
    totalBets:   (r) => r.totalBets,
    correctBets: (r) => r.correctBets,
    accuracyPct: (r) => r.accuracyPct,
    displayName: (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[bettingSort.col] ?? sortFns.bettingElo;
  const sorted = [...top].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return bettingSort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });

  const arrow = (col) => {
    if (bettingSort.col !== col) return '<span class="sort-arrow">⇅</span>';
    return `<span class="sort-arrow active">${bettingSort.dir === 'desc' ? '▼' : '▲'}</span>`;
  };
  const th = (col, label, left) =>
    `<th class="stats-th${left ? ' stats-th-left' : ''}" onclick="sortBetting('${col}')">${label}${arrow(col)}</th>`;

  let rows = sorted.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const rank = medals[i] || `#${r.rank}`;
    return `<tr>
      <td class="stats-td stats-td-left">${rank} ${esc(r.displayName)}</td>
      <td class="stats-td">${r.bettingElo}</td>
      <td class="stats-td">${r.totalBets}</td>
      <td class="stats-td">${r.correctBets}</td>
      <td class="stats-td">${r.accuracyPct}%</td>
    </tr>`;
  }).join('');

  if (me) {
    rows += `<tr class="lb-me-row"><td class="stats-td stats-td-left">You (#${me.rank})</td><td class="stats-td">${me.bettingElo}</td><td class="stats-td">${me.totalBets}</td><td class="stats-td">${me.correctBets}</td><td class="stats-td">${me.accuracyPct}%</td></tr>`;
  }

  content.innerHTML = `
    <p class="betting-tab-desc">Predict game outcomes during bidding to earn Bet ELO.</p>
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead><tr>
          ${th('displayName', 'Bettor', true)}
          ${th('bettingElo', 'Bet ELO')}
          ${th('totalBets', 'Bets')}
          ${th('correctBets', 'Correct')}
          ${th('accuracyPct', 'Acc%')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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

function normalizePlayerName(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(clean) ? Array.from(clean).slice(0, 64).join('') : '';
}

function identityStatus(text, retry = false) {
  const status = $('identity-status');
  if (status) status.textContent = text;
  $('btn-retry-identity')?.classList.toggle('hidden', !retry);
}

function useVerifiedProfile(profile) {
  authDisplayName = normalizePlayerName(profile.displayName);
  authNameRequired = profile.nameRequired === true || !authDisplayName;
  // Only a successful server-auth/profile response may supply this ID. Raw
  // Telegram SDK fields, launch fragments and display names are not proof.
  if (Number.isSafeInteger(profile.telegramId) && profile.telegramId > 0) {
    const verifiedId = `tg_${profile.telegramId}`;
    if (playerId !== verifiedId && ws) {
      ws.onclose = null; ws.close(); ws = null;
      gameState = null; pendingPlay = null; awaitingGameState = true;
    }
    playerId = verifiedId;
    localStorage.setItem('playerId', playerId);
  }
  playerName = authNameRequired ? '' : authDisplayName;
  localStorage.setItem('playerName', playerName);
  showGameSection(playerName);
  identityStatus(authNameRequired ? 'Your Telegram login is verified. Enter a display name to join.' : '');
}

function requestPlayerName() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  playerName = '';
  showScreen('screen-home');
  $('input-room').value = roomCode || '';
  $('overlay-reconnect').classList.add('hidden');
  if (authToken) {
    authNameRequired = true;
    showGameSection('');
    identityStatus('Please enter a display name before joining. Your room and login are preserved.', true);
    $('input-name').focus();
  } else {
    showLoginSection();
    identityStatus('Sign in with Telegram to recover your name, then join this room.');
  }
}

async function preparePlayerName() {
  if (!identityReady || identitySubmission) return false;
  const name = normalizePlayerName($('input-name').value);
  if (!name) { identityStatus('Please enter a name.'); $('input-name').focus(); return false; }
  if (authToken && (authNameRequired || name !== authDisplayName)) {
    identitySubmission = true;
    try {
      const res = await fetch('/api/me', { method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ displayName: name }) });
      if (!res.ok) throw new Error('Name not saved');
    } catch {
      identityStatus('Could not save your name. Please try again.'); return false;
    } finally {
      identitySubmission = false;
    }
    authDisplayName = name; authNameRequired = false;
  }
  playerName = name;
  localStorage.setItem('playerName', name);
  identityStatus('');
  return true;
}

function resumeSavedRoom() {
  if (!roomCode) return;
  if (identityNeedsLogin) { requestPlayerName(); return; }
  playerName = normalizePlayerName(playerName);
  if (!playerName) { requestPlayerName(); return; }
  history.replaceState(null, '', buildHashWithId(roomCode));
  if (roomCodeFromHash && !joinAs) showScreen('screen-role-choice');
  else { showScreen('screen-lobby'); $('lobby-room-code').textContent = roomCode; connect(); }
}

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
    const profile = await res.json();
    if (typeof profile.token !== 'string' || !profile.token) throw new Error('Auth failed');
    authToken = profile.token;
    identityNeedsLogin = false;
    localStorage.setItem('authToken', authToken);
    useVerifiedProfile(profile);
    identityReady = true;
    resumeSavedRoom();
    loadLeaderboard();
  } catch {
    alert('Telegram login failed. Please try again.');
  }
};

async function initAuth() {
  if (authToken) {
    const checkedToken = authToken;
    identityStatus('Checking your saved Telegram login...');
    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${checkedToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (authToken !== checkedToken) return;
      if (res.ok) {
        const profile = await res.json();
        if (authToken !== checkedToken) return;
        useVerifiedProfile(profile);
        return;
      }
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) throw new Error('Profile unavailable');
    } catch {
      if (authToken !== checkedToken) return;
      // A transient outage does not revoke a valid credential or change IDs.
      playerName = normalizePlayerName(playerName);
      authDisplayName = playerName || null;
      authNameRequired = !playerName;
      showGameSection(playerName);
      identityStatus('Your profile is temporarily unavailable. Your saved login is preserved.', true);
      return;
    }
    // Only a definitive authentication/profile failure clears the credential.
    authToken = null;
    identityNeedsLogin = true;
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
  maybeShowDevLogin();
  identityStatus('Sign in with Telegram. Opening a chat link alone does not verify your identity.');
}

function maybeShowDevLogin() {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const devSection = document.getElementById('dev-login-section');
  if (!devSection) return;
  if (!isLocal) { devSection.classList.add('hidden'); return; }
  devSection.classList.remove('hidden');
  const btn = document.getElementById('btn-dev-login');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', devLogin);
  }
}

async function devLogin() {
  const name = (document.getElementById('input-dev-name').value || '').trim() || 'Dev User';
  try {
    const res = await fetch('/api/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    if (!res.ok) throw new Error('Dev login unavailable');
    const profile = await res.json();
    authToken = profile.token;
    identityNeedsLogin = false;
    localStorage.setItem('authToken', authToken);
    useVerifiedProfile(profile);
    identityReady = true;
    resumeSavedRoom();
    loadLeaderboard();
  } catch (e) {
    alert('Dev login failed — is the server running with ALLOW_DEV_LOGIN=1?');
  }
}

function showGameSection(name) {
  document.getElementById('login-section').classList.add('hidden');
  document.getElementById('game-section').classList.remove('hidden');
  const nameInput = document.getElementById('input-name');
  const nameLabel = document.querySelector('label[for="input-name"]');
  if (authDisplayName && !authNameRequired) {
    // Telegram user — name is authoritative from Telegram, not editable
    nameInput.value = authDisplayName;
    nameInput.readOnly = true;
    nameInput.classList.add('input-readonly');
    if (nameLabel) nameLabel.textContent = 'Your Name';
  } else {
    nameInput.readOnly = false;
    nameInput.classList.remove('input-readonly');
    nameInput.value = authNameRequired ? '' : normalizePlayerName(name || playerName);
    if (nameLabel) nameLabel.textContent = 'Your Name';
  }
  // "Match History" only for logged-in users (the history endpoint requires a JWT)
  const matchHistoryBtn = document.getElementById('btn-match-history');
  if (matchHistoryBtn) matchHistoryBtn.classList.toggle('hidden', !authDisplayName);

  const authStatus = document.getElementById('auth-status');
  if (authDisplayName) {
    authStatus.innerHTML = `Logged in as <strong>${esc(authDisplayName)}</strong> · <a href="#" id="btn-logout">Logout</a>`;
    document.getElementById('btn-logout').addEventListener('click', (e) => {
      e.preventDefault();
      authToken = null;
      authDisplayName = null;
      identityNeedsLogin = true;
      authNameRequired = false;
      localStorage.removeItem('authToken');
      showLoginSection();
      loadLeaderboard();
    });
  } else {
    authStatus.textContent = '';
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
  const changed = !$(id).classList.contains('active');
  if (id !== 'screen-bidding' && id !== 'screen-play') stopDisconnectCountdown();
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
  if (changed) requestAnimationFrame(() => {
    for (const log of el.querySelectorAll('.inline-chat-log')) {
      log.scrollTop = log.dataset.follow !== 'false' ? log.scrollHeight : Number(log.dataset.scrollTop || 0);
    }
  });
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
  CardHand.render(container, hand, CARD_SUITS, validSuits, onClick);
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
  if (!identityReady) return;
  if (identityNeedsLogin) { requestPlayerName(); return; }
  playerName = normalizePlayerName(playerName);
  if (!playerName) { requestPlayerName(); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const joinName = playerName;

  // A new socket begins a fresh input session. A card held across reconnect
  // must return to the hand and wait for authoritative state before playing.
  awaitingGameState = true;
  pendingPlay = null;
  CardHand.cancelAll();
  if (gameState) renderState();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = authToken ? `&token=${encodeURIComponent(authToken)}` : '';
  const socket = new WebSocket(`${proto}//${location.host}/api/ws?room=${roomCode}&playerId=${playerId}${tokenParam}`);
  const socketRoom = roomCode;
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket || roomCode !== socketRoom) return;
    reconnectDelay = 2000;
    $('overlay-reconnect').classList.add('hidden');
    const joinMsg = { type: 'join', name: joinName };
    if (joinAs) joinMsg.joinAs = joinAs;
    socket.send(JSON.stringify(joinMsg));
  };

  socket.onmessage = (e) => {
    if (ws !== socket || roomCode !== socketRoom) return;
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  socket.onclose = () => {
    if (ws !== socket || roomCode !== socketRoom) return;
    awaitingGameState = true;
    pendingPlay = null;
    CardHand.cancelAll();
    if (roomCode) {
      $('overlay-reconnect').classList.remove('hidden');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        connect();
      }, reconnectDelay);
    }
  };

  socket.onerror = () => {};
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
      awaitingGameState = false;
      if (pendingPlay && (msg.state.phase !== 'play' || msg.state.gameId !== pendingPlay.gameId
        || msg.state.mySeat !== pendingPlay.seat || msg.state.turn !== pendingPlay.seat
        || !msg.state.hand?.[pendingPlay.suit]?.includes(pendingPlay.value))) pendingPlay = null;
      gameState = msg.state;
      renderState();
      break;
    case 'error':
      if (msg.code === 'NAME_REQUIRED') { requestPlayerName(); break; }
      pendingPlay = null;
      CardHand.cancelAll();
      renderState();
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
    case 'chat':
      appendChatMessage(msg.name, msg.seat, msg.text, msg);
      break;
    case 'chatHistory':
      restoreChatHistory(msg);
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
    case 'playerPinged':
      // Show notification when someone is pinged
      showConnectionToast(`${msg.pinger} pinged ${gameState?.players.find(p => p.seat === msg.seat)?.name || 'a player'}`);
      break;
    case 'abandonVoteStarted':
      showConnectionToast(`${msg.initiatorName} initiated an abandon vote`);
      break;
    case 'abandonVotePrompt':
      showAbandonVotePrompt(msg.timeoutSeconds);
      break;
    case 'abandonVotePassed':
      showConnectionToast('Game abandoned by vote - returning to lobby');
      if (gameState) {
        gameState.phase = 'lobby';
        renderState();
      }
      break;
    case 'abandonVoteFailed':
      const rejectName = msg.rejectSeat >= 0 ? gameState?.players[msg.rejectSeat]?.name : msg.rejectName;
      showConnectionToast(`${rejectName} rejected the abandon vote`);
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

function showAbandonVotePrompt(timeoutSeconds) {
  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:rgba(20,10,40,0.95);border:1px solid rgba(139,92,246,0.5);border-radius:12px;padding:2rem;text-align:center;max-width:400px;color:#d4a843;';

  modal.innerHTML = `
    <h3 style="margin:0 0 1rem 0;color:#d4a843;">Abandon Game?</h3>
    <p style="margin:0 0 1.5rem 0;color:rgba(255,255,255,0.8);">Vote to end the current deal and return to lobby<br>(${timeoutSeconds}s timeout)</p>
    <div style="display:flex;gap:1rem;justify-content:center;">
      <button class="btn btn-primary" id="vote-yes" style="flex:1;">Yes, Abandon</button>
      <button class="btn btn-secondary" id="vote-no" style="flex:1;">No, Continue</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let responded = false;

  const yesBtn = modal.querySelector('#vote-yes');
  const noBtn = modal.querySelector('#vote-no');

  const cleanup = () => {
    if (overlay.parentNode) overlay.remove();
  };

  const respond = (accept) => {
    if (responded) return;
    responded = true;
    send({ type: 'respondAbandon', accept });
    cleanup();
  };

  yesBtn.addEventListener('click', () => respond(true));
  noBtn.addEventListener('click', () => respond(false));

  // Auto-close after timeout + 2 seconds (server handles auto-accept)
  setTimeout(() => {
    if (!responded) {
      responded = true;
      cleanup();
    }
  }, (timeoutSeconds + 2) * 1000);
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

function renderLastTrickPanel(s) {
  const panel = $('last-trick-panel');
  if (!panel) return;
  if (!s.lastTrick) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const lt = s.lastTrick;
  const mySeat = s.mySeat ?? 0;
  const seatOrder = [mySeat, (mySeat+1)%4, (mySeat+2)%4, (mySeat+3)%4];
  // visual positions: bot=me, left, top=across, right
  const positions = ['bot', 'left', 'top', 'right'];

  panel.innerHTML = '';
  const lbl = document.createElement('div');
  lbl.className = 'ltp-label';
  lbl.textContent = 'Last Trick';
  panel.appendChild(lbl);

  const grid = document.createElement('div');
  grid.className = 'ltp-grid';

  for (let i = 0; i < 4; i++) {
    const seat = seatOrder[i];
    const pos = positions[i];
    const card = lt.cards[seat];
    const item = document.createElement('div');
    item.className = `ltp-item ltp-${pos}`;
    if (seat === lt.winner) item.classList.add('ltp-winner');
    if (card) {
      const parts = card.split(' ');
      const trumpFire = isTrumpPlaySuit(parts[1], s.trumpSuit);
      item.appendChild(createCardEl(parts[0], parts[1], { mini: true, trumpFire }));
    }
    grid.appendChild(item);
  }

  panel.appendChild(grid);
}

// --- Betting widget ---
async function updateBettingWidget(s) {
  const widget = $('betting-widget');
  if (!widget) return;
  const show = s.isSpectator && !!authToken && s.phase === 'bidding';
  if (!show) {
    widget.classList.add('hidden');
    document.body.classList.remove('has-betting-widget');
    return;
  }
  widget.classList.remove('hidden');
  document.body.classList.add('has-betting-widget');

  // Reset bet state when gameId changes
  if (s.gameId && s.gameId !== myBetGameId) {
    myBet = null;
    myBetGameId = s.gameId;
    myBetFetching = false;
  }

  renderBettingWidgetContent(s);

  // Fetch existing bet once per game
  if (!myBet && !myBetFetching && roomCode) {
    myBetFetching = true;
    try {
      const res = await fetch(`/api/betting/my-bet?room=${encodeURIComponent(roomCode)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.bet) {
          myBet = data.bet;
          renderBettingWidgetContent(s);
        }
      }
    } catch { /* silent */ } finally {
      myBetFetching = false;
    }
  }
}

function renderBettingWidgetContent(s) {
  const buttonsDiv = $('betting-buttons');
  const resultDiv = $('betting-result');
  if (!buttonsDiv || !resultDiv) return;

  if (myBet) {
    buttonsDiv.classList.add('hidden');
    resultDiv.classList.remove('hidden');
    const label = myBet.prediction === 'win' ? 'Bidder Wins' : 'Bidder Loses';
    const correctLabel = myBet.correct === 1
      ? '<span class="bet-correct">✓ Correct!</span>'
      : myBet.correct === 0
        ? '<span class="bet-wrong">✗ Wrong</span>'
        : '<span class="bet-pending">Pending...</span>';
    resultDiv.innerHTML = `<span class="bet-placed-label">Your bet: <strong>${label}</strong></span> ${correctLabel}`;
  } else {
    buttonsDiv.classList.remove('hidden');
    resultDiv.classList.add('hidden');
    const winBtn = $('bet-win-btn');
    const loseBtn = $('bet-lose-btn');
    if (winBtn) winBtn.disabled = false;
    if (loseBtn) loseBtn.disabled = false;
  }
}

async function submitBet(prediction) {
  if (!authToken || !roomCode) return;
  const winBtn = $('bet-win-btn');
  const loseBtn = $('bet-lose-btn');
  if (winBtn) winBtn.disabled = true;
  if (loseBtn) loseBtn.disabled = true;

  try {
    const res = await fetch('/api/betting/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ room: roomCode, prediction, watchedSeat: gameState?.watchingSeat ?? -1 }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      myBet = { prediction, correct: null };
      myBetGameId = data.gameId || myBetGameId;
      renderBettingWidgetContent(gameState);
    } else {
      alert(data.error || 'Could not place bet.');
      if (winBtn) winBtn.disabled = false;
      if (loseBtn) loseBtn.disabled = false;
    }
  } catch {
    alert('Network error placing bet.');
    if (winBtn) winBtn.disabled = false;
    if (loseBtn) loseBtn.disabled = false;
  }
}

async function renderBetResult(s) {
  if (!myBet || myBet.correct !== null) return;
  if (!authToken || !roomCode) return;
  try {
    const res = await fetch(`/api/betting/my-bet?room=${encodeURIComponent(roomCode)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.bet && data.bet.correct !== null) {
        myBet = data.bet;
        const widget = $('betting-widget');
        if (widget) {
          widget.classList.remove('hidden');
          document.body.classList.add('has-betting-widget');
          renderBettingWidgetContent(s);
        }
      }
    }
  } catch { /* silent */ }
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'bet-win-btn') submitBet('win');
  if (e.target.id === 'bet-lose-btn') submitBet('lose');
});

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

function renderPlayerStatusBar(container, players, enablePing = false) {
  container.innerHTML = '';
  for (const p of players) {
    const item = document.createElement('span');
    item.className = 'player-status-chip';
    // Make names clickable for pinging in bidding if enabled and room is linked to Telegram
    const nameHtml = enablePing && gameState?.groupId && !gameState?.isSpectator && p.seat !== gameState?.mySeat && !p.isBot
      ? `<button class="ping-btn" onclick="pingPlayer(${p.seat})">${esc(p.name)}</button>`
      : esc(p.name);
    item.innerHTML = `${statusDot(p.connected)}${nameHtml}`;
    container.appendChild(item);
  }
}

function updateLeaveButtonLabel() {
  const btn = $('btn-leave-global');
  if (!btn || !gameState) return;

  if (gameState.phase === 'bidding' || gameState.phase === 'play') {
    btn.textContent = 'Abandon';
  } else {
    btn.textContent = 'Leave';
  }
}

function renderState() {
  const s = gameState;
  if (!s) return;

  updateBettingWidget(s);
  updateLeaveButtonLabel();

  // Spectator hasn't chosen a player yet — show selection screen (only during active gameplay)
  if (s.isSpectator && s.watchingSeat === -1 && s.phase !== 'lobby' && s.phase !== 'gameover') {
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
    const botIcon = p.isBot ? `<span class="bot-icon">${p.isGodBot ? '⚡' : p.botLevel === 'sophisticated' ? '🎓' : p.botLevel === 'advanced' ? '🧠' : p.botLevel === 'basic' ? '🎯' : '🤖'}</span>` : '';
    const eloStr = (!p.isBot && p.elo) ? `ELO ${p.elo} · ` : '';
    const statsHtml = (!p.isBot && p.gamesPlayed)
      ? `<span class="lobby-stats">${eloStr}${p.wins}W / ${p.gamesPlayed}G</span>`
      : '';
    const notRankedBadge = (s.groupId && p.isGroupMember === false && !p.isBot)
      ? '<span class="not-ranked-badge">⚠️ not ranked</span>'
      : '';
    const kickBtn = (!s.isSpectator && (s.phase === 'lobby' || s.phase === 'gameover') && p.seat !== s.mySeat)
      ? `<button class="kick-btn" onclick="send({type:'kickPlayer',seat:${p.seat}})">✕</button>`
      : '';
    // Make player name clickable for pinging if room is linked to Telegram and not self
    const canPing = s.groupId && !s.isSpectator && p.seat !== s.mySeat && !p.isBot;
    const nameHtml = canPing
      ? `<button class="lobby-player-name ping-btn" onclick="pingPlayer(${p.seat})">${esc(p.name)}</button>`
      : `<span class="lobby-player-name">${esc(p.name)}</span>`;
    item.innerHTML = `<span class="seat-num">${p.seat + 1}</span>${statusDot(p.connected)}<div class="lobby-identity">${botIcon}${nameHtml}</div><div class="lobby-meta">${statsHtml}${notRankedBadge}</div><div class="lobby-action">${kickBtn}</div>`;
    item.querySelector('.kick-btn')?.setAttribute('aria-label', `Remove ${p.name}`);
    item.querySelector('.ping-btn')?.setAttribute('aria-label', `Ping ${p.name}`);
    list.appendChild(item);
  }
  const remaining = NUM_PLAYERS - s.players.length;

  const countdownEl = $('lobby-countdown');
  const startBtn = $('lobby-start-btn');
  const statusEl = $('lobby-status');
  const joinAsPlayerBtn = $('lobby-join-as-player');

  // Show "Join as Player" button for spectators when a seat is open
  if (joinAsPlayerBtn) {
    if (s.isSpectator && s.players.length < NUM_PLAYERS) {
      joinAsPlayerBtn.classList.remove('hidden');
    } else {
      joinAsPlayerBtn.classList.add('hidden');
    }
  }

  // Waiting-for-others state: player pressed Play Again but not everyone has yet
  if (s.phase === 'gameover') {
    clearTimeout(lobbyCountdownTimer);
    const readyCount = (s.readySeats ?? []).length;
    countdownEl.classList.add('hidden');
    startBtn.classList.add('hidden');
    statusEl.classList.remove('hidden');
    statusEl.textContent = `Waiting for others to play again... (${readyCount}/${NUM_PLAYERS})`;
    for (const id of ['lobby-add-int-bot', 'lobby-add-adv-bot', 'lobby-add-soph-bot', 'lobby-add-god-bot']) {
      const btn = $(id); if (btn) btn.classList.add('hidden');
    }
    togglePractice('lobby-practice-notice', s.isPractice);
    return;
  }

  if (remaining === 0 && s.gameStartAt) {
    const secsLeft = Math.max(0, Math.ceil((s.gameStartAt - Date.now()) / 1000));
    const anyDisconnected = s.players.some((p) => !p.connected);

    if (anyDisconnected) {
      countdownEl.classList.add('hidden');
      statusEl.classList.remove('hidden');
      const disconnected = s.players.filter((p) => !p.connected);
      statusEl.textContent = `Waiting for reconnection: ${disconnected.map((p) => p.name).join(', ')}`;
      startBtn.classList.add('hidden');
    } else {
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
    }
  } else {
    clearTimeout(lobbyCountdownTimer);
    lobbyCountdownTimer = null;
    countdownEl.classList.add('hidden');
    startBtn.classList.add('hidden');
    statusEl.classList.remove('hidden');

    // Check for disconnected players
    const disconnected = s.players.filter((p) => !p.connected);
    if (disconnected.length > 0) {
      statusEl.textContent = `Waiting for ${disconnected.length} player(s) to reconnect: ${disconnected.map((p) => p.name).join(', ')}`;
    } else if (remaining > 0) {
      statusEl.textContent = `Waiting for ${remaining} more player(s)...`;
    } else {
      statusEl.textContent = 'Game starting...';
    }
  }

  for (const id of ['lobby-add-int-bot', 'lobby-add-adv-bot', 'lobby-add-soph-bot', 'lobby-add-god-bot']) {
    const btn = $(id); if (!btn) continue;
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

// --- Chat ---
const CHAT_MAX_MESSAGES = 50;
const chatMessages = [];
let chatRoom = null;
let chatEpoch = null;
let chatSequence = 0;
const CHAT_BUBBLE_MS = 4000;
const chatBubbleTimers = {};

function makeChatMsgEl(name, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="chat-name">${esc(name)}</span>${esc(text)}`;
  return div;
}

function mutateChatLog(log, mutate) {
  const visible = log.clientHeight > 0;
  const follow = visible ? log.scrollHeight - log.clientHeight - log.scrollTop < 32 : log.dataset.follow !== 'false';
  const top = log.getBoundingClientRect().top;
  const anchor = visible && [...log.children].find(child => child.getBoundingClientRect().bottom > top);
  const anchorTop = anchor && anchor.getBoundingClientRect().top;
  mutate();
  log.dataset.follow = String(follow);
  if (follow) log.scrollTop = log.scrollHeight;
  else if (visible && anchor) {
    const replacement = anchor.isConnected ? anchor : [...log.children].find(child => child.dataset.messageId === anchor.dataset.messageId);
    if (replacement) log.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    else log.scrollTop = 0;
  }
  if (visible) log.dataset.scrollTop = log.scrollTop;
}

function appendToChatLog(logEl, name, text, entry = {}) {
  mutateChatLog(logEl, () => {
    const row = makeChatMsgEl(name, text);
    if (entry.id) row.dataset.messageId = entry.id;
    logEl.appendChild(row);
    while (logEl.children.length > CHAT_MAX_MESSAGES) logEl.firstChild.remove();
  });
}

function resetRoomChat(code = null, epoch = null) {
  chatRoom = code;
  chatEpoch = epoch;
  chatSequence = 0;
  chatMessages.length = 0;
  for (const log of document.querySelectorAll('.inline-chat-log')) {
    log.replaceChildren(); log.scrollTop = 0;
    log.dataset.follow = 'true'; log.dataset.scrollTop = '0';
  }
  for (const input of document.querySelectorAll('.chat-input-field')) input.value = '';
  for (const pos of Object.keys(chatBubbleTimers)) clearTimeout(chatBubbleTimers[pos]);
  for (const bubble of document.querySelectorAll('.chat-bubble')) bubble.classList.remove('visible');
}

function acceptChatRoom(message) {
  if (!roomCode || (message.roomCode && message.roomCode !== roomCode)) return false;
  if (chatRoom !== roomCode || (message.epoch && chatEpoch && message.epoch !== chatEpoch)) resetRoomChat(roomCode, message.epoch);
  if (message.epoch) chatEpoch = message.epoch;
  return true;
}

function replaceChatLogs() {
  for (const log of document.querySelectorAll('.inline-chat-log')) {
    // Replaying history should not announce fifty old messages as live chat.
    log.setAttribute('aria-live', 'off');
    mutateChatLog(log, () => log.replaceChildren(...chatMessages.map(entry => {
      const row = makeChatMsgEl(entry.name, entry.text);
      if (entry.id) row.dataset.messageId = entry.id;
      return row;
    })));
    requestAnimationFrame(() => log.setAttribute('aria-live', 'polite'));
  }
}

function restoreChatHistory(message) {
  if (!acceptChatRoom(message)) return;
  // A live message may arrive while a join snapshot is being read. Keep only
  // newer live entries beyond that snapshot's watermark, then sort/deduplicate.
  const entries = [...message.messages, ...chatMessages.filter(entry => entry.sequence > message.sequence)];
  const next = [...new Map(entries.map(entry => [entry.id, entry])).values()]
    .sort((a, b) => a.sequence - b.sequence).slice(-CHAT_MAX_MESSAGES);
  const unchanged = next.length === chatMessages.length && next.every((entry, i) => entry.id === chatMessages[i].id);
  chatSequence = Math.max(chatSequence, message.sequence);
  if (unchanged) return;
  chatMessages.splice(0, chatMessages.length, ...next);
  replaceChatLogs();
}

function showChatBubble(seat, text) {
  if (!gameState) return;
  const rel = (seat - gameState.mySeat + 4) % 4;
  const positions = ['bottom', 'left', 'top', 'right'];
  const pos = positions[rel];
  const bubble = $(`chat-bubble-${pos}`);
  if (!bubble) return;
  bubble.textContent = text;
  bubble.classList.add('visible');
  clearTimeout(chatBubbleTimers[pos]);
  chatBubbleTimers[pos] = setTimeout(() => bubble.classList.remove('visible'), CHAT_BUBBLE_MS);
}

function appendChatMessage(name, seat, text, message = {}) {
  if (!acceptChatRoom(message)) return;
  if (message.id && (chatMessages.some(entry => entry.id === message.id)
    || message.sequence <= chatSequence - CHAT_MAX_MESSAGES)) return;
  const entry = { name, text, seat, id: message.id, sequence: message.sequence };
  chatMessages.push(entry);
  if (message.id) {
    chatSequence = Math.max(chatSequence, message.sequence);
    chatMessages.sort((a, b) => a.sequence - b.sequence);
  }
  if (chatMessages.length > CHAT_MAX_MESSAGES) chatMessages.shift();
  if (chatMessages.at(-1) === entry) {
    for (const log of document.querySelectorAll('.inline-chat-log')) appendToChatLog(log, name, text, entry);
  } else replaceChatLogs();

  // Show bubble on play screen
  if (seat >= 0 && $('screen-play') && $('screen-play').classList.contains('active')) {
    showChatBubble(seat, text);
  }
}

function sendChatFrom(input) {
  if (!input) return;
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  send({ type: 'chat', text });
  input.value = '';
}

// Event delegation for all chat inputs and send buttons
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chat-send-btn')) {
    const row = e.target.closest('.chat-input-row');
    if (row) sendChatFrom(row.querySelector('.chat-input-field'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('chat-input-field')) {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!e.repeat) sendChatFrom(e.target);
  }
});

for (const log of document.querySelectorAll('.inline-chat-log')) {
  log.addEventListener('scroll', () => {
    if (!log.clientHeight) return;
    log.dataset.follow = String(log.scrollHeight - log.clientHeight - log.scrollTop < 32);
    log.dataset.scrollTop = log.scrollTop;
  }, { passive: true });
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

const BOT_TAKEOVER_MS = 90000;

function disconnectCountdownText(disconnectedAt) {
  if (!disconnectedAt) return '';
  const elapsed = Math.floor((Date.now() - disconnectedAt) / 1000);
  const remaining = Math.max(0, Math.ceil((BOT_TAKEOVER_MS - (Date.now() - disconnectedAt)) / 1000));
  return ` (away ${elapsed}s, bot in ${remaining}s)`;
}

function startDisconnectCountdown(renderFn) {
  clearInterval(disconnectCountdownTimer);
  disconnectCountdownTimer = setInterval(() => {
    if (gameState) renderFn(gameState);
    else clearInterval(disconnectCountdownTimer);
  }, 1000);
}

function stopDisconnectCountdown() {
  clearInterval(disconnectCountdownTimer);
  disconnectCountdownTimer = null;
}

// --- Bidding ---
function renderBidding(s) {
  renderPlayerStatusBar($('bidding-players'), s.players, true);
  renderSpectatorBar(s);
  renderSpectatorSwitcher(s, 'bidding-spectator-switcher');
  renderFullBoardInto(s, 'bidding-fullboard', ['bidding-hand-section']);

  const isFullBoard = s.isSpectator && s.watchingSeat === -2;
  const isMyTurn = s.turn === s.mySeat;

  if (isFullBoard) {
    $('bid-status').textContent = '👁 Viewing all hands';
    stopDisconnectCountdown();
  } else {
    const turnPlayer = s.players[s.turn];
    const turnDisconnected = turnPlayer && !turnPlayer.connected && turnPlayer.disconnectedAt;
    if (turnDisconnected) {
      $('bid-status').textContent = `Waiting for ${turnPlayer.name} to reconnect...${disconnectCountdownText(turnPlayer.disconnectedAt)}`;
      startDisconnectCountdown(renderBidding);
    } else {
      stopDisconnectCountdown();
      $('bid-status').textContent = s.isSpectator
        ? `👁 Watching: ${s.players[s.watchingSeat]?.name || '?'}`
        : isMyTurn
          ? "It's your turn to bid!"
          : `Waiting for ${turnPlayer?.name || '?'} to bid...`;
    }
  }

  if (s.bid >= 0 && s.bidder >= 0) {
    $('bid-current').textContent = `Current bid: ${s.players[s.bidder].name} - ${getBidFromNum(s.bid)}`;
  } else {
    $('bid-current').textContent = 'No bids yet';
  }

  const histEl = $('bid-history');
  if (histEl && s.bidHistory && s.bidHistory.length > 0) {
    const startIdx = Math.max(0, s.players.findIndex(p => p.seat === s.bidHistory[0].seat));
    const cols = [];
    for (let i = 0; i < 4; i++) {
      cols.push(s.players[(startIdx + i) % s.players.length]);
    }

    let html = '<table class="bid-table"><thead><tr>';
    for (const p of cols) {
      html += `<th>${esc(p.name)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 0; i < s.bidHistory.length; i += 4) {
      html += '<tr>';
      const rowEnd = Math.min(i + 4, s.bidHistory.length);
      for (let j = i; j < rowEnd; j++) {
        const entry = s.bidHistory[j];
        if (entry.bidNum === null) {
          html += `<td class="bt-pass">—</td>`;
        } else {
          const suitClass = getSuitClass(BID_SUITS[entry.bidNum % 5]);
          const isCurrent = entry.bidNum === s.bid;
          html += `<td class="bt-bid ${suitClass}${isCurrent ? ' bt-current' : ''}">${getBidFromNum(entry.bidNum)}</td>`;
        }
      }
      for (let k = rowEnd; k < i + 4; k++) html += '<td></td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
    histEl.innerHTML = html;
    histEl.scrollTop = histEl.scrollHeight;
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

  const partnerHistEl = $('partner-bid-history');
  if (partnerHistEl && s.bidHistory && s.bidHistory.length > 0) {
    const startIdx = Math.max(0, s.players.findIndex(p => p.seat === s.bidHistory[0].seat));
    const cols = [];
    for (let i = 0; i < 4; i++) {
      cols.push(s.players[(startIdx + i) % s.players.length]);
    }

    let html = '<table class="bid-table"><thead><tr>';
    for (const p of cols) {
      html += `<th>${esc(p.name)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 0; i < s.bidHistory.length; i += 4) {
      html += '<tr>';
      const rowEnd = Math.min(i + 4, s.bidHistory.length);
      for (let j = i; j < rowEnd; j++) {
        const entry = s.bidHistory[j];
        if (entry.bidNum === null) {
          html += `<td class="bt-pass">—</td>`;
        } else {
          const suitClass = getSuitClass(BID_SUITS[entry.bidNum % 5]);
          const isCurrent = entry.bidNum === s.bid;
          html += `<td class="bt-bid ${suitClass}${isCurrent ? ' bt-current' : ''}">${getBidFromNum(entry.bidNum)}</td>`;
        }
      }
      for (let k = rowEnd; k < i + 4; k++) html += '<td></td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
    partnerHistEl.innerHTML = html;
  } else if (partnerHistEl) {
    partnerHistEl.innerHTML = '';
  }

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
      const countdownStr = (seat === s.turn && !player.connected && player.disconnectedAt)
        ? `<span class="disconnect-countdown">${disconnectCountdownText(player.disconnectedAt)}</span>`
        : '';
      label.innerHTML = `<span class="seat-name-row">${bidderStar}${partnerStar}${statusDot(player.connected)}<span class="seat-name">${esc(player.name)}</span>${eyeIcons}</span><span class="seat-sets">${sets}</span>${countdownStr}`;
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

  // Start/stop live disconnect countdown for the turn player
  const turnPlayer = s.players[s.turn];
  if (turnPlayer && !turnPlayer.connected && turnPlayer.disconnectedAt) {
    startDisconnectCountdown(renderPlay);
  } else {
    stopDisconnectCountdown();
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

  // Last trick mini panel (bottom-right of table)
  renderLastTrickPanel(s);

  // Hand
  const isMyTurn = !s.isSpectator && s.turn === s.mySeat;
  if (isMyTurn && prevTurn !== s.mySeat) playDingSound();
  prevTurn = s.turn;
  let validSuits = null;
  if (isMyTurn && s.hand) {
    validSuits = getValidSuitsClient(s.hand, s.trumpSuit, s.currentSuit, s.trumpBroken);
  }
  // A completed four-card trick stays on the table until its winner leads.
  // The server clears those old cards on that next accepted play.
  const tableReady = !s.trickComplete || s.playedCards.every(Boolean);
  renderHand($('play-hand'), s.hand, isMyTurn ? validSuits : CARD_SUITS,
    isMyTurn && !pendingPlay && !awaitingGameState && tableReady ? onPlayCard : null);
}

function onPlayCard(value, suit) {
  const s = gameState;
  const completedTrick = s?.trickComplete && s.playedCards.every(Boolean);
  if (!s || s.phase !== 'play' || s.isSpectator || s.turn !== s.mySeat || (s.trickComplete && !completedTrick)
    || pendingPlay || awaitingGameState || ws?.readyState !== WebSocket.OPEN
    || (s.playedCards[s.mySeat] && !completedTrick) || !s.hand?.[suit]?.includes(value)
    || !getValidSuitsClient(s.hand, s.trumpSuit, s.currentSuit, s.trumpBroken).includes(suit)) return false;
  pendingPlay = { value, suit, seat: s.mySeat, gameId: s.gameId };
  try {
    ws.send(JSON.stringify({ type: 'playCard', card: `${value} ${suit}` }));
    return true;
  } catch {
    pendingPlay = null;
    return false;
  }
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

function formatPlayTime(totalSeconds) {
  const totalMins = Math.ceil(totalSeconds / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins || 1}m`;
}

async function renderPlayTimeToday(s) {
  const el = $('gameover-play-time');
  if (!el || !authToken) { if (el) el.classList.add('hidden'); return; }
  const tgIds = s.players.filter((p) => p.telegramId && !p.isBot).map((p) => p.telegramId);
  if (tgIds.length === 0) { el.classList.add('hidden'); return; }
  try {
    const res = await fetch(`/api/play-time-today?players=${tgIds.join(',')}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) { el.classList.add('hidden'); return; }
    const times = await res.json();
    const rows = s.players
      .filter((p) => p.telegramId && !p.isBot && (times[String(p.telegramId)] ?? 0) > 0)
      .map((p) => {
        const secs = times[String(p.telegramId)] ?? 0;
        return `<div class="play-time-row"><span class="play-time-name">${esc(p.name)}</span><span class="play-time-value">${formatPlayTime(secs)}</span></div>`;
      }).join('');
    if (!rows) { el.classList.add('hidden'); return; }
    el.innerHTML = `<div class="play-time-header">Today's play time</div>${rows}`;
    el.classList.remove('hidden');
  } catch { el.classList.add('hidden'); }
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

  // Show "Join as Player" button and hide "Play Again" for spectators when seat open
  const gameoverJoinBtn = $('gameover-join-as-player');
  const playAgainBtnEarly = $('btn-play-again');
  if (s.isSpectator) {
    if (playAgainBtnEarly) playAgainBtnEarly.classList.add('hidden');
    if (gameoverJoinBtn) {
      if (s.players.length < NUM_PLAYERS) gameoverJoinBtn.classList.remove('hidden');
      else gameoverJoinBtn.classList.add('hidden');
    }
  } else {
    if (playAgainBtnEarly) playAgainBtnEarly.classList.remove('hidden');
    if (gameoverJoinBtn) gameoverJoinBtn.classList.add('hidden');
  }

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
  renderPlayTimeToday(s);
  renderBetResult(s);

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
  if (roomCode !== code) resetRoomChat(code);
  roomCode = code;
  sessionStorage.setItem('roomCode', code);
  history.replaceState(null, '', buildHashWithId(code));
}

// The player/spectator choice belongs to one room. It is persisted so reconnects
// keep it, so it must be replaced whenever the player creates or leaves a room.
function setJoinRole(role) {
  joinAs = role;
  if (role) sessionStorage.setItem('joinRole', role);
  else sessionStorage.removeItem('joinRole');
}

function buildHashWithId(room) {
  return '#' + room + ':' + playerId;
}

function leaveGame() {
  resetRoomChat();
  pendingPlay = null;
  awaitingGameState = true;
  CardHand.cancelAll();
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
  myBet = null;
  myBetGameId = null;
  myBetFetching = false;
  const widget = $('betting-widget');
  if (widget) widget.classList.add('hidden');
  document.body.classList.remove('has-betting-widget');
  sessionStorage.removeItem('roomCode');
  setJoinRole(null);
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

initAuth().finally(() => { identityReady = true; resumeSavedRoom(); });
loadLeaderboard();
$('btn-retry-identity')?.addEventListener('click', async () => {
  identityReady = false;
  try { await initAuth(); } finally { identityReady = true; resumeSavedRoom(); }
});

$('btn-create').addEventListener('click', async () => {
  if (!await preparePlayerName()) return;

  $('btn-create').disabled = true;
  try {
    const res = await fetch('/api/create', { method: 'POST' });
    const data = await res.json();
    setRoomCode(data.roomCode);
    setJoinRole('player');
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
  if (!await preparePlayerName()) return;

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
    setJoinRole('player');
    showScreen('screen-lobby');
    $('lobby-room-code').textContent = roomCode;
    connect();
  } catch (err) {
    alert('Failed to create game');
  } finally {
    btn.disabled = false;
  }
});

$('replay-prev')?.addEventListener('click', () => replayStep(-1));
$('replay-next')?.addEventListener('click', () => replayStep(1));

$('btn-join').addEventListener('click', async () => {
  if (!await preparePlayerName()) return;

  const code = $('input-room').value.trim().toUpperCase();
  if (!code || code.length < 3) { alert('Please enter a valid room code'); return; }
  setRoomCode(code);

  // If joining via invite link (and haven't chosen role yet), show role choice screen
  if (code === hashInfo.room && hashInfo.room && !joinAs) {
    showScreen('screen-role-choice');
  } else {
    showScreen('screen-lobby');
    $('lobby-room-code').textContent = roomCode;
    connect();
  }
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
  if (gameState && gameState.isSpectator) {
    if (confirm('Stop spectating and return to home?')) {
      try { ws && ws.send(JSON.stringify({ type: 'leaveSpectator' })); } catch { /* ignore */ }
      leaveGame();
    }
  } else if (gameState && (gameState.phase === 'bidding' || gameState.phase === 'play')) {
    // Initiate abandon vote during bidding/play
    send({ type: 'initiateAbandon' });
  } else {
    // Direct leave in lobby, partner, gameover phases
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

// Ping a player for Telegram
function pingPlayer(seat) {
  if (!gameState || !gameState.groupId) return;
  const now = Date.now();
  const lastPingTime = pingCooldowns[seat] ?? 0;
  const cooldownRemaining = Math.max(0, 10000 - (now - lastPingTime));

  if (cooldownRemaining > 0) {
    const secondsLeft = Math.ceil(cooldownRemaining / 1000);
    alert(`Please wait ${secondsLeft}s before pinging this player again.`);
    return;
  }

  send({ type: 'pingPlayer', seat });
  pingCooldowns[seat] = now;
}

// Add role choice button handlers
$('btn-join-player').addEventListener('click', () => {
  setJoinRole('player');
  showScreen('screen-lobby');
  $('lobby-room-code').textContent = roomCode;
  connect();
});

$('btn-join-spectator').addEventListener('click', () => {
  setJoinRole('spectator');
  showScreen('screen-lobby');
  $('lobby-room-code').textContent = roomCode;
  connect();
});

// Restore join role from session storage if available
if (!joinAs && sessionStorage.getItem('joinRole')) {
  joinAs = sessionStorage.getItem('joinRole');
}

// Profile loading finishes before any automatic room connection. The async
// continuation above runs after role restoration and event wiring complete.
if (roomCode) $('input-room').value = roomCode;
