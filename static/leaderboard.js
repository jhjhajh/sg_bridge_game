'use strict';

// One leaderboard card for every Fun Central page, with a Bridge | Regicide switch.
// Bridge's ELO and Regicide's rating are separate boards; this is just the shared entry point.
window.FunLeaderboard = (() => {
  const GAMES = {
    bridge: { label: 'Bridge', url: '/api/leaderboard', stats: (e) => `${e.wins}W / ${e.gamesPlayed}G` },
    regicide: { label: 'Regicide', url: '/api/regicide/leaderboard', stats: (e) => `${e.bestDefeated}/12 · ${e.gamesPlayed}G` },
  };
  const medals = ['🥇', '🥈', '🥉'];
  // On the Regicide page this opens its stats screen in place; elsewhere it navigates there.
  const REGICIDE_FOOTER = '<div class="lb-footer"><a class="btn-link" href="/regicide/?view=stats" onclick="if (window.showStats && location.pathname.startsWith(\'/regicide\')) { event.preventDefault(); showStats(); }">📊 Full stats →</a></div>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => { try { return localStorage.getItem('authToken'); } catch { return null; } };

  async function fetchBoard(game) {
    try {
      const t = token();
      const res = await fetch(GAMES[game].url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data?.top) ? data : null;
    } catch { return null; }
  }

  function rows(game, data) {
    if (!data?.top?.length) return `<div class="lb-empty">No rated ${GAMES[game].label} games yet</div>`;
    const row = (e, me) => `<div class="lb-row${me ? ' lb-me' : ''}">
      <span class="lb-rank">${me ? `#${e.rank}` : (medals[e.rank - 1] || `#${e.rank}`)}</span>
      <span class="lb-name">${me ? 'You' : esc(e.displayName)}</span>
      <span class="lb-elo">${e.elo}</span>
      <span class="lb-stats">${esc(GAMES[game].stats(e))}</span>
    </div>`;
    let html = data.top.map((e) => row(e, false)).join('');
    if (data.me) html += `<div class="lb-divider"></div>${row(data.me, true)}`;
    return html;
  }

  /**
   * Renders into `el`. `game` picks the starting tab; `bridgeData` lets Bridge pass what it
   * already fetched; `footer` is optional extra HTML (Bridge's "Full stats" link).
   * Renders nothing when neither board has entries, like Bridge always has.
   */
  async function mount(el, { game = 'bridge', bridgeData, footer = '' } = {}) {
    if (!el) return;
    const boards = {
      bridge: bridgeData !== undefined ? bridgeData : await fetchBoard('bridge'),
      regicide: await fetchBoard('regicide'),
    };
    if (!boards.bridge?.top?.length && !boards.regicide?.top?.length) { el.innerHTML = ''; return; }
    let current = game;
    const draw = () => {
      const tabs = Object.entries(GAMES).map(([key, g]) =>
        `<button type="button" class="lb-tab${key === current ? ' active' : ''}" data-game="${key}" aria-pressed="${key === current}">${g.label}</button>`).join('');
      el.innerHTML = `<div class="lb-card"><div class="lb-header">🏆 Leaderboard</div><div class="lb-tabs" role="group" aria-label="Leaderboard game">${tabs}</div>${rows(current, boards[current])}${current === 'bridge' ? (footer ? `<div class="lb-footer">${footer}</div>` : '') : REGICIDE_FOOTER}</div>`;
      for (const b of el.querySelectorAll('.lb-tab')) b.addEventListener('click', () => { current = b.dataset.game; draw(); });
    };
    draw();
  }

  return { mount };
})();
