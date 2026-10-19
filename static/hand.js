/* global ResizeObserver */
'use strict';

// Input follows the actual pointer type, including on hybrid laptops.
window.CardHand = (() => {
  const hands = new Set();
  const names = { '♣': 'clubs', '♦': 'diamonds', '♥': 'hearts', '♠': 'spades' };
  const ranks = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };
  const SWIPE_DISTANCE = 56;
  const SWIPE_START = 14;
  let nextId = 0;
  let touchClickBlockedUntil = 0;
  // Compatibility clicks may arrive after an authoritative state replaced the
  // hand, so suppression belongs to the input session rather than a DOM card.
  for (const name of ['pointerdown', 'pointerup', 'pointercancel']) {
    document.addEventListener(name, event => {
      if (event.pointerType !== 'mouse') touchClickBlockedUntil = performance.now() + 1000;
    }, true);
  }

  function cancelAll() { hands.forEach(hand => hand.cancel()); }
  window.addEventListener('blur', cancelAll);
  window.addEventListener('resize', cancelAll);
  window.addEventListener('scroll', cancelAll, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); });
  document.addEventListener('pointerdown', event => {
    hands.forEach(hand => {
      if (!hand.container.contains(event.target) || (hand.gesture && hand.gesture.id !== event.pointerId)) hand.cancel();
    });
  }, true);
  new MutationObserver(() => {
    hands.forEach(hand => { if (!hand.container.isConnected) hand.dispose(); });
  }).observe(document.body, { childList: true, subtree: true });

  class Hand {
    constructor(container, cards, onPlay) {
      this.container = container;
      this.cards = cards;
      this.onPlay = onPlay;
      this.selected = -1;
      this.gesture = null;
      this.mouseClick = -1;
      this.ignoreTouchClickUntil = 0;
      this.pending = false;
      this.abort = new AbortController();
      container.classList.add('hand-fan');
      container.dataset.input = matchMedia('(hover: none)').matches ? 'touch' : 'mouse';
      container.dataset.interactive = String(!!onPlay);
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', 'Cards in hand');
      container.setAttribute('aria-busy', 'false');
      const id = container.id || `card-hand-${++nextId}`;
      this.hint = document.createElement('p');
      this.hint.id = `${id}-help`;
      this.hint.className = 'hand-help';
      container.setAttribute('aria-describedby', this.hint.id);
      this.preview = document.createElement('div');
      this.preview.className = 'hand-preview hidden';
      this.preview.setAttribute('aria-hidden', 'true');
      container.append(this.preview, this.hint);
      for (const [name, handler] of Object.entries({
        pointerdown: event => this.down(event), pointermove: event => this.move(event),
        pointerup: event => this.up(event), pointercancel: () => this.cancel(),
        lostpointercapture: event => { if (this.gesture?.id === event.pointerId) this.cancel(); },
        pointerleave: () => { if (!this.gesture && container.dataset.input === 'mouse') this.select(-1); },
        click: event => this.click(event), keydown: event => this.key(event),
        focusin: event => {
          if (event.target.matches(':focus-visible')) container.dataset.input = 'keyboard';
          const i = this.indexOf(event.target); if (i >= 0) this.select(i);
        },
        focusout: event => { if (!container.contains(event.relatedTarget) && !this.gesture) this.select(-1); },
        contextmenu: event => event.preventDefault(),
      })) container.addEventListener(name, handler, { signal: this.abort.signal });
      this.resize = new ResizeObserver(() => this.layout());
      this.resize.observe(container);
      hands.add(this);
      this.layout();
      this.updateHint();
    }

    dispose() {
      this.cancel();
      this.resize.disconnect();
      this.abort.abort();
      hands.delete(this);
    }

    indexOf(target) { return this.cards.findIndex(card => card === target || card.contains(target)); }

    layout() {
      if (!this.container.isConnected) return;
      const width = this.container.clientWidth;
      if (width === this.width) return;
      this.cancel();
      this.width = width;
      if (!width) return;
      const available = Math.max(1, width - 16);
      this.cardWidth = Math.min(76, Math.max(52, available * 0.18));
      this.step = this.cards.length > 1 ? Math.min(this.cardWidth + 6, (available - this.cardWidth) / (this.cards.length - 1)) : 0;
      this.start = (width - this.cardWidth - this.step * Math.max(0, this.cards.length - 1)) / 2;
      this.container.style.setProperty('--hand-card-width', `${this.cardWidth}px`);
      this.container.style.setProperty('--corner-font', `${Math.min(16, Math.max(10, (this.step > 0 ? this.step - 5 : 20) / 1.2))}px`);
      this.container.style.height = `${this.cards.length ? this.cardWidth * 1.4 + 48 : 64}px`;
      this.cards.forEach((card, i) => {
        card.style.left = `${this.start + this.step * i}px`;
        card.style.setProperty('--card-order', i);
      });
    }

    select(index) {
      if (index === this.selected && index >= 0) { this.updateHint(); return; }
      this.selected = index;
      this.cards.forEach((card, i) => card.classList.toggle('is-selected', i === index));
      this.preview.classList.toggle('hidden', index < 0);
      if (index >= 0) {
        const card = this.cards[index];
        this.preview.classList.toggle('red', card.classList.contains('red'));
        this.preview.classList.toggle('black', card.classList.contains('black'));
        this.preview.replaceChildren(...[...card.children].map(child => child.cloneNode(true)));
        const bounds = this.container.getBoundingClientRect();
        const above = bounds.top + 18;
        const below = innerHeight - (bounds.top + 18 + this.cardWidth * 1.4);
        const previewWidth = Math.min(90, Math.max(56, (Math.max(above, below) - 12) / 1.4));
        this.preview.style.setProperty('--preview-width', `${previewWidth}px`);
        this.preview.style.top = `${above >= previewWidth * 1.4 + 8 ? 10 - previewWidth * 1.4 : 26 + this.cardWidth * 1.4}px`;
        const left = Math.max(4, Math.min(this.width - previewWidth - 4, this.start + this.step * index + this.cardWidth / 2 - previewWidth / 2));
        this.preview.style.left = `${left}px`;
      }
      this.updateHint();
    }

    updateHint(ready = false) {
      const card = this.cards[this.selected];
      this.container.classList.toggle('swipe-ready', ready);
      this.hint.textContent = !this.cards.length ? 'Your hand is empty' : this.pending ? 'Playing…'
        : !this.onPlay ? 'Slide or hover to inspect your cards'
          : card?.classList.contains('disabled') ? 'This card cannot be played'
            : ready ? 'Release to play'
              : this.container.dataset.input === 'touch' ? 'Slide to choose · swipe up to play'
                : this.container.dataset.input === 'keyboard' ? '← → to choose · Enter or Space to play'
                  : 'Hover to inspect · click to play';
    }

    at(x) {
      const local = x - this.container.getBoundingClientRect().left;
      if (local < this.start - 16 || local > this.start + this.step * Math.max(0, this.cards.length - 1) + this.cardWidth + 16) return -1;
      return this.step ? Math.max(0, Math.min(this.cards.length - 1, Math.floor((local - this.start) / this.step))) : 0;
    }

    down(event) {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) { this.cancel(); return; }
      const index = this.indexOf(event.target);
      if (index < 0) return;
      const touch = event.pointerType !== 'mouse';
      this.container.dataset.input = touch ? 'touch' : 'mouse';
      this.mouseClick = -1;
      if (touch) { event.preventDefault(); this.ignoreTouchClickUntil = performance.now() + 1000; }
      this.gesture = { id: event.pointerId, touch, index, x: event.clientX, y: event.clientY, stage: 'choosing', moved: false };
      this.select(index);
      this.container.setPointerCapture(event.pointerId);
    }

    move(event) {
      const gesture = this.gesture;
      if (!gesture) {
        if (event.pointerType === 'mouse' && !event.buttons) {
          this.container.dataset.input = 'mouse';
          this.select(this.indexOf(event.target));
        }
        return;
      }
      if (event.pointerId !== gesture.id) return;
      if (!gesture.touch) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) gesture.moved = true;
        return;
      }
      event.preventDefault();
      this.track(event.clientX, event.clientY);
    }

    track(x, y) {
      const gesture = this.gesture;
      if (!gesture) return;
      const up = gesture.y - y;
      const across = x - gesture.x;
      if (up < -18 || this.at(x) < 0 || (gesture.stage === 'swiping' && Math.abs(across) > Math.max(36, this.cardWidth * 0.6))) {
        this.cancel();
        return;
      }
      if (gesture.stage === 'choosing') {
        if (up >= SWIPE_START && up > Math.abs(across) * 1.2) {
          gesture.stage = 'swiping'; // Freeze selection once the deliberate upward motion begins.
        } else {
          const index = this.at(x);
          if (index !== this.selected) {
            gesture.x = x;
            gesture.y = y; // A horizontal browse starts a fresh swipe from the newly selected card.
            this.select(index);
          } else if (Math.abs(up) < 10) gesture.x = x;
        }
      }
      this.updateHint(this.ready(x, y));
    }

    ready(x, y) {
      const gesture = this.gesture;
      return !!(gesture?.touch && gesture.stage === 'swiping'
        && gesture.y - y >= SWIPE_DISTANCE
        && gesture.y - y >= Math.abs(x - gesture.x) * 1.5
        && Math.abs(x - gesture.x) <= Math.max(36, this.cardWidth * 0.6)
        && this.onPlay && !this.cards[this.selected]?.classList.contains('disabled'));
    }

    up(event) {
      const gesture = this.gesture;
      if (!gesture || event.pointerId !== gesture.id) return;
      if (gesture.touch) {
        event.preventDefault();
        this.ignoreTouchClickUntil = performance.now() + 1000;
        this.track(event.clientX, event.clientY);
        const shouldPlay = this.ready(event.clientX, event.clientY);
        this.finishCapture();
        if (shouldPlay) this.activate(this.selected);
      } else {
        const bounds = this.cards[gesture.index].getBoundingClientRect();
        this.mouseClick = !gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8
          && this.at(event.clientX) === gesture.index && event.clientY >= bounds.top && event.clientY <= bounds.bottom
          ? gesture.index : -1;
        this.finishCapture();
      }
      this.updateHint();
    }

    finishCapture() {
      const id = this.gesture?.id;
      this.gesture = null;
      if (id !== undefined && this.container.hasPointerCapture(id)) this.container.releasePointerCapture(id);
    }

    cancel() {
      this.finishCapture();
      this.mouseClick = -1;
      this.select(-1);
    }

    click(event) {
      event.preventDefault();
      const targetIndex = this.indexOf(event.target);
      const index = targetIndex < 0 && event.pointerType === 'mouse' ? this.mouseClick : targetIndex;
      const fromMouse = event.pointerType === 'mouse' && this.mouseClick === index;
      const accessible = event.detail === 0 && !event.pointerType
        && performance.now() >= Math.max(this.ignoreTouchClickUntil, touchClickBlockedUntil);
      if (fromMouse || accessible) this.activate(index);
      this.mouseClick = -1;
    }

    activate(index) {
      const card = this.cards[index];
      if (!card || this.pending || !this.onPlay || card.classList.contains('disabled')) return;
      if (this.onPlay(card.dataset.value, card.dataset.suit) === true) {
        this.pending = true;
        this.container.setAttribute('aria-busy', 'true');
        this.cards.forEach(button => button.setAttribute('aria-disabled', 'true'));
        this.select(-1);
      }
    }

    key(event) {
      const index = this.indexOf(event.target);
      if (index < 0) return;
      this.container.dataset.input = 'keyboard';
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.cards.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + this.cards.length) % this.cards.length;
        this.cards.forEach((card, i) => { card.tabIndex = i === next ? 0 : -1; });
        this.cards[next].focus({ preventScroll: true });
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) this.activate(index);
      } else if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
      this.updateHint();
    }
  }

  function render(container, hand, suits, validSuits, onPlay) {
    let focused;
    if (container.contains(document.activeElement)) focused = document.activeElement.dataset;
    hands.forEach(controller => { if (controller.container === container || !controller.container.isConnected) controller.dispose(); });
    container.replaceChildren();
    const cards = [];
    for (const suit of suits) for (const value of hand?.[suit] || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `card hand-card ${suit === '♥' || suit === '♦' ? 'red' : 'black'}`;
      const invalid = !!validSuits && !validSuits.includes(suit);
      button.classList.toggle('disabled', invalid);
      button.setAttribute('aria-disabled', String(invalid || !onPlay));
      button.setAttribute('aria-label', `${ranks[value] || value} of ${names[suit]}`);
      button.dataset.value = value;
      button.dataset.suit = suit;
      button.tabIndex = cards.length ? -1 : 0;
      const corner = document.createElement('span');
      corner.className = 'card-corner';
      for (const [className, text] of [['card-value', value], ['card-suit', suit]]) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        corner.appendChild(span);
      }
      const center = document.createElement('span');
      center.className = 'card-center';
      center.textContent = suit;
      button.append(corner, center);
      container.appendChild(button);
      cards.push(button);
    }
    const controller = new Hand(container, cards, onPlay);
    if (focused) {
      const target = cards.find(card => card.dataset.value === focused.value && card.dataset.suit === focused.suit) || cards[0];
      cards.forEach(card => { card.tabIndex = card === target ? 0 : -1; });
      target?.focus({ preventScroll: true });
      controller.select(cards.indexOf(target));
    }
  }
  return { render, cancelAll };
})();
