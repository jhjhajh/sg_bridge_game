/* Display preference only: never reconnect, render a game, or send a move here. */
'use strict';

(() => {
  const storageKey = 'bridge.tableView';
  const buttons = document.querySelectorAll('[data-table-view]');
  const playHand = document.getElementById('play-hand');

  function applyTableView(view) {
    const mode = view === '25d' ? '25d' : 'classic';
    document.body.dataset.tableView = mode;
    buttons.forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.tableView === mode));
    });
    updateHandAccessibility();
  }

  // Enhance the original card nodes, retaining their single existing click handler.
  // Never touch semantics supplied by another renderer (including the hand update).
  function updateHandAccessibility() {
    const canPlay = document.body.dataset.tableView === '25d' && gameState &&
      !gameState.isSpectator && gameState.phase === 'play' && gameState.turn === gameState.mySeat;
    const suitNames = { '\u2663': 'clubs', '\u2666': 'diamonds', '\u2665': 'hearts', '\u2660': 'spades' };
    playHand.querySelectorAll('.card').forEach(card => {
      if (!card.hasAttribute('data-view-keyboard') &&
          (card.matches('button, a, input, select, textarea, [role], [tabindex]'))) return;
      if (canPlay && !card.classList.contains('disabled')) {
        card.dataset.viewKeyboard = 'true';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        const rank = card.querySelector('.card-value')?.textContent;
        const suit = card.querySelector('.card-suit')?.textContent;
        card.setAttribute('aria-label', `Play ${rank} of ${suitNames[suit] || suit}`);
      } else if (card.hasAttribute('data-view-keyboard')) {
        card.removeAttribute('data-view-keyboard');
        card.removeAttribute('role');
        card.removeAttribute('tabindex');
        card.removeAttribute('aria-label');
      }
    });
  }

  new MutationObserver(updateHandAccessibility).observe(playHand, { childList: true, subtree: true });
  playHand.addEventListener('keydown', event => {
    const card = event.target.closest('[data-view-keyboard]');
    if (!card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) card.click();
  });

  let savedView;
  try { savedView = localStorage.getItem(storageKey); } catch { /* Storage may be unavailable. */ }
  applyTableView(savedView);

  buttons.forEach(button => button.addEventListener('click', () => {
    applyTableView(button.dataset.tableView);
    try { localStorage.setItem(storageKey, button.dataset.tableView); } catch { /* Session still works. */ }
  }));
})();
