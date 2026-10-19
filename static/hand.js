/* global ResizeObserver */
'use strict';

// Input follows the actual pointer type, including on hybrid laptops.
window.CardHand = (() => {
  const hands = new Set();
  const names = { '♣': 'clubs', '♦': 'diamonds', '♥': 'hearts', '♠': 'spades' };
  const ranks = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };
  const DRAG_START = 6;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
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
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && [...hands].some(hand => hand.gesture)) { event.preventDefault(); cancelAll(); }
  });
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
    hands.forEach(hand => {
      if (!hand.container.isConnected) hand.dispose();
      else if (hand.gesture && !hand.container.getClientRects().length) hand.cancel();
    });
  }).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(cancelAll).observe(document.body, { attributes: true, attributeFilter: ['data-table-view'] });

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
      this.table = container.id === 'play-hand' ? document.getElementById('play-table') : null;
      this.dragVisual = null;
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
      container.appendChild(this.hint);
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
      // Keep browser scrolling out of card gestures from their first contact.
      // Use scoped, non-passive Touch Event fallbacks for browser scrolling;
      // Pointer Events remain the only path that selects or plays a card.
      container.addEventListener('touchstart', event => {
        if (this.indexOf(event.target) >= 0 && event.cancelable) event.preventDefault();
      }, { passive: false, signal: this.abort.signal });
      container.addEventListener('touchmove', event => {
        if (this.gesture?.touch && event.cancelable) event.preventDefault();
      }, { passive: false, signal: this.abort.signal });
      this.resize = new ResizeObserver(() => this.layout());
      this.resize.observe(container);
      hands.add(this);
      this.layout();
      this.updateHint();
    }

    update(validSuits, onPlay) {
      const legalityChanged = this.cards.some(card => card.classList.contains('disabled')
        !== (!!validSuits && !validSuits.includes(card.dataset.suit)));
      const availabilityChanged = !!this.onPlay !== !!onPlay;
      const pendingCleared = !!onPlay && this.pending;
      if (legalityChanged || availabilityChanged) this.cancel();
      this.onPlay = onPlay;
      // The app only re-enables play after authoritative state or an error.
      // Unrelated updates while a request is pending must keep that lock.
      if (onPlay && this.pending) this.pending = false;
      this.container.dataset.interactive = String(!!onPlay);
      this.container.setAttribute('aria-busy', String(this.pending));
      for (const card of this.cards) {
        const invalid = !!validSuits && !validSuits.includes(card.dataset.suit);
        card.classList.toggle('disabled', invalid);
        card.setAttribute('aria-disabled', String(invalid || !onPlay || this.pending));
      }
      if (legalityChanged || availabilityChanged || pendingCleared) this.updateHint();
    }

    dispose() {
      this.cancel();
      this.clearDrag();
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
      // A nested panel can be narrower than the viewport. Reduce decorative
      // gutters and index insets there before reducing readable type or cards.
      const compact = width < 290;
      const available = Math.max(1, width - (compact ? 4 : 16));
      this.cardWidth = Math.min(76, Math.max(52, available * 0.18));
      const count = this.cards.length;
      const height = this.cardWidth * 1.4;
      const angle = Math.min(24, Math.max(0, count - 1) * 2) * Math.PI / 180;
      const delta = count > 1 ? 2 * angle / (count - 1) : 0;
      const halfWidth = this.cardWidth * Math.cos(angle) / 2 + height * Math.sin(angle) / 2;
      // Fit the outer rotated corners, not just the unrotated card widths.
      const radius = delta ? Math.max(0, Math.min((this.cardWidth + 6) / (2 * Math.sin(delta / 2)),
        (available / 2 - halfWidth) / Math.sin(angle))) : 0;
      const raw = this.cards.map((card, i) => {
        const theta = count > 1 ? -angle + i * delta : 0;
        const halfHeight = height * Math.cos(theta) / 2 + this.cardWidth * Math.abs(Math.sin(theta)) / 2;
        return { x: radius * Math.sin(theta), y: radius * (1 - Math.cos(theta)), theta, halfHeight };
      });
      const top = count ? Math.min(...raw.map(card => card.y - card.halfHeight)) : 0;
      const bottom = count ? Math.max(...raw.map(card => card.y + card.halfHeight)) : 0;
      this.positions = raw.map(card => ({ x: width / 2 + card.x, y: 18 + card.y - top, angle: card.theta * 180 / Math.PI }));
      this.fanBottom = 18 + bottom - top;
      const cornerStep = delta ? radius * Math.sin(delta) + (this.cardWidth / 2 - 2) * (1 - Math.cos(delta))
        + (height / 2 - 2) * Math.sin(delta) : this.cardWidth;
      const originalFont = count ? parseFloat(getComputedStyle(this.cards[0]).fontSize) : 16;
      this.container.style.setProperty('--hand-card-width', `${this.cardWidth}px`);
      this.container.style.setProperty('--corner-inset', compact ? '1px' : '2px');
      this.container.style.setProperty('--hand-lift', compact ? '4px' : '8px');
      // Leave room for the border, inset and both digits of "10" as the next
      // card's slanted edge approaches the lower part of the index.
      this.container.style.setProperty('--corner-font', `${Math.min(originalFont, Math.max(11.8, (cornerStep - 5) / 1.3))}px`);
      this.container.style.height = `${count ? this.fanBottom + 30 : 64}px`;
      this.container.dataset.fanShape = 'arc';
      this.cards.forEach((card, i) => {
        card.style.left = `${this.positions[i].x - this.cardWidth / 2}px`;
        card.style.top = `${this.positions[i].y - height / 2}px`;
        card.style.setProperty('--card-angle', `${this.positions[i].angle}deg`);
        card.style.setProperty('--card-order', i);
      });
    }

    select(index) {
      if (index === this.selected && index >= 0) { this.updateHint(); return; }
      this.selected = index;
      this.cards.forEach((card, i) => card.classList.toggle('is-selected', i === index));
      this.updateHint();
    }

    updateHint(ready = false) {
      const card = this.cards[this.selected];
      this.container.classList.toggle('drop-ready', ready);
      const text = !this.cards.length ? 'Your hand is empty' : this.pending ? 'Playing…'
        : !this.onPlay ? 'Drag or hover to inspect your cards'
          : card?.classList.contains('disabled') ? 'This card cannot be played'
            : ready ? 'Release on the table to play'
              : this.container.dataset.input === 'touch' ? 'Drag a card onto the table to play'
                : this.container.dataset.input === 'keyboard' ? '← → to choose · Enter or Space to play'
                  : 'Hover to inspect · click to play';
      if (this.hint.textContent !== text) this.hint.textContent = text;
    }

    at(x, y, nearby = false) {
      // Native hit testing follows rotation, overlap, rounded corners and any
      // outer visual transform. Pointer capture does not change this result.
      const hit = document.elementFromPoint(x, y)?.closest('.hand-card');
      const index = this.cards.indexOf(hit);
      if (index >= 0 || !nearby || hit) return index;
      let nearest = -1;
      let distance = 12;
      for (let i = this.cards.length - 1; i >= 0; i--) {
        const box = this.cards[i].getBoundingClientRect();
        const d = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
        if (d < distance) { nearest = i; distance = d; }
      }
      return nearest;
    }

    down(event) {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) { this.cancel(); return; }
      const index = this.indexOf(event.target);
      if (index < 0) return;
      const touch = event.pointerType !== 'mouse';
      this.clearDrag();
      this.container.dataset.input = touch ? 'touch' : 'mouse';
      this.mouseClick = -1;
      if (touch) { event.preventDefault(); this.ignoreTouchClickUntil = performance.now() + 1000; }
      const card = this.cards[index];
      const box = card.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(card).transform);
      const angle = Math.atan2(matrix.b, matrix.a);
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      this.gesture = { id: event.pointerId, touch, index, x: event.clientX, y: event.clientY, moved: false,
        anchor: { x: card.offsetWidth / 2 + dx * Math.cos(angle) + dy * Math.sin(angle),
          y: card.offsetHeight / 2 - dx * Math.sin(angle) + dy * Math.cos(angle) }, angle: angle * 180 / Math.PI };
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
      if (!gesture.dragging && Math.hypot(x - gesture.x, y - gesture.y) < DRAG_START) return;
      if (!gesture.dragging) { gesture.dragging = true; this.startDrag(gesture); }
      const visual = this.dragVisual;
      const now = performance.now();
      const dt = Math.max(8, now - visual.lastMove);
      visual.tilt = visual.reduced ? 0 : clamp((x - visual.x) / dt * 7, -12, 12);
      visual.vx = clamp((x - visual.x) / dt, -2, 2);
      visual.vy = clamp((y - visual.y) / dt, -2, 2);
      visual.x = x; visual.y = y; visual.lastMove = now;
      // Position follows the finger directly; only the decorative tilt springs.
      this.paintDrag(visual);
      const ready = this.ready(x, y);
      this.table?.classList.toggle('card-drop-ready', ready);
      this.updateHint(ready);
    }

    ready(x, y) {
      const gesture = this.gesture;
      const hit = document.elementFromPoint(x, y);
      return !!(gesture?.touch && gesture.dragging && this.onPlay && !this.pending
        && !this.cards[gesture.index]?.classList.contains('disabled')
        && this.table?.getClientRects().length && hit?.closest('#play-table') === this.table
        && document.elementsFromPoint(x, y).includes(this.table.querySelector('.card-drop-zone'))
        && !hit.closest('button, a, input, select'));
    }

    startDrag(gesture) {
      const source = this.cards[gesture.index];
      const root = document.createElement('div');
      root.className = 'card-hand card-drag-layer';
      root.setAttribute('aria-hidden', 'true'); root.inert = true;
      for (const name of ['--hand-card-width', '--corner-font', '--corner-inset']) {
        root.style.setProperty(name, this.container.style.getPropertyValue(name));
      }
      const style = getComputedStyle(source);
      const proxy = source.cloneNode(true);
      proxy.classList.remove('is-selected'); proxy.classList.add('drag-proxy');
      proxy.style.cssText = '';
      proxy.style.fontFamily = style.fontFamily; proxy.style.fontSize = style.fontSize; proxy.style.color = style.color;
      proxy.style.transformOrigin = `${gesture.anchor.x}px ${gesture.anchor.y}px`; proxy.tabIndex = -1;
      root.append(proxy); document.body.append(root); source.classList.add('is-drag-source');
      const visual = this.dragVisual = { root, proxy, source, anchor: gesture.anchor,
        x: gesture.x, y: gesture.y, angle: gesture.angle, spin: 0, tilt: 0, vx: 0, vy: 0,
        lastFrame: performance.now(), lastMove: performance.now(),
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
      if (this.table && this.onPlay && !this.pending && !source.classList.contains('disabled')) {
        if (!this.table.querySelector('.card-drop-zone')) {
          const zone = document.createElement('div'); zone.className = 'card-drop-zone'; zone.setAttribute('aria-hidden', 'true');
          const hint = document.createElement('span'); hint.textContent = 'Drop to play'; zone.append(hint); this.table.append(zone);
        }
        this.table.classList.add('card-drop-available');
      }
      if (!visual.reduced) {
        const frame = now => {
          if (this.dragVisual !== visual || visual.returning) return;
          const dt = Math.max(0, Math.min(0.032, (now - visual.lastFrame) / 1000)); visual.lastFrame = now;
          const target = visual.tilt * Math.exp(-(now - visual.lastMove) / 90);
          visual.spin += ((target - visual.angle) * 200 - visual.spin * 24) * dt;
          visual.angle += visual.spin * dt;
          this.paintDrag(visual); visual.raf = requestAnimationFrame(frame);
        };
        visual.raf = requestAnimationFrame(frame);
      }
    }

    dragTransform(visual, x = visual.x, y = visual.y, angle = visual.angle, scale = 1.035) {
      return `translate3d(${x - visual.anchor.x}px, ${y - visual.anchor.y}px, 0) rotate(${angle}deg) scale(${visual.reduced ? 1 : scale})`;
    }

    paintDrag(visual) {
      visual.proxy.style.transform = this.dragTransform(visual, visual.x, visual.y, visual.reduced ? 0 : visual.angle);
    }

    finishDrag(played = false) {
      const visual = this.dragVisual;
      this.table?.classList.remove('card-drop-available', 'card-drop-ready'); this.container.classList.remove('drop-ready');
      if (!visual || visual.returning) return;
      visual.returning = true; cancelAnimationFrame(visual.raf);
      if (visual.reduced || !visual.source.isConnected || !visual.source.getClientRects().length) { this.clearDrag(); return; }
      const from = visual.proxy.style.transform;
      let frames;
      if (played) {
        frames = [{ transform: from, opacity: 1 }, {
          transform: this.dragTransform(visual, visual.x + visual.vx * 4, visual.y + visual.vy * 4, visual.angle / 2, 0.98), opacity: 0,
        }];
      } else {
        const box = visual.source.getBoundingClientRect();
        const matrix = new DOMMatrix(getComputedStyle(visual.source).transform);
        const angle = Math.atan2(matrix.b, matrix.a);
        const dx = visual.anchor.x - visual.source.offsetWidth / 2; const dy = visual.anchor.y - visual.source.offsetHeight / 2;
        const x = box.left + box.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle);
        const y = box.top + box.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle);
        frames = [{ transform: from }, { offset: 0.8,
          transform: this.dragTransform(visual, x + clamp((x - visual.x) * 0.035, -7, 7),
            y + clamp((y - visual.y) * 0.035, -7, 7), angle * 180 / Math.PI, 1),
        }, { transform: this.dragTransform(visual, x, y, angle * 180 / Math.PI, 1) }];
      }
      visual.animation = visual.proxy.animate(frames, { duration: played ? 140 : 240, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
      visual.animation.onfinish = () => { if (this.dragVisual === visual) this.clearDrag(); };
    }

    clearDrag() {
      const visual = this.dragVisual;
      if (!visual) return;
      this.dragVisual = null; cancelAnimationFrame(visual.raf); visual.animation?.cancel();
      visual.source.classList.remove('is-drag-source'); visual.root.remove();
      this.table?.classList.remove('card-drop-available', 'card-drop-ready');
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
        if (shouldPlay) this.activate(gesture.index);
        if (this.dragVisual) { this.select(-1); this.finishDrag(shouldPlay && this.pending); }
      } else {
        const bounds = this.cards[gesture.index].getBoundingClientRect();
        this.mouseClick = !gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8
          && this.at(event.clientX, event.clientY) === gesture.index && event.clientY >= bounds.top && event.clientY <= bounds.bottom
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
      this.finishDrag();
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
    const values = suits.flatMap(suit => (hand?.[suit] || []).map(value => ({ value, suit })));
    const existing = [...hands].find(controller => controller.container === container);
    if (existing && existing.cards.length === values.length
      && existing.hint.parentNode === container
      && existing.cards.every((card, i) => card.parentNode === container
        && card.dataset.value === values[i].value && card.dataset.suit === values[i].suit)) {
      // Connection, bidding and other metadata updates do not redeal a hand.
      // Preserve card nodes, settled positions, focus and an active gesture.
      existing.update(validSuits, onPlay);
      return;
    }
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
      button.appendChild(corner);
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
