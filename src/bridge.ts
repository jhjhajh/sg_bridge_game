import { type Suit, type BidSuit, type Hand, CARD_SUITS, BID_SUITS, NUM_PLAYERS, POINTS_TO_WASH } from './types';

const DECK_SIZE = 52;
const HAND_SIZE = 13;

interface Card {
  value: string;
  suit: Suit;
}

const DECK_OF_52: Card[] = (() => {
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck: Card[] = [];
  for (const value of values) {
    for (const suit of CARD_SUITS) {
      deck.push({ value, suit });
    }
  }
  return deck;
})();

export function getValueFromNum(num: number): string {
  if (num === 14) return 'A';
  if (num === 13) return 'K';
  if (num === 12) return 'Q';
  if (num === 11) return 'J';
  return String(num);
}

export function getNumFromValue(val: string): number {
  if (val === 'A') return 14;
  if (val === 'K') return 13;
  if (val === 'Q') return 12;
  if (val === 'J') return 11;
  return parseInt(val, 10);
}

export function getBidFromNum(num: number): string {
  const suitNum = num % 5;
  const suit = BID_SUITS[suitNum];
  const value = Math.floor(num / 5) + 1;
  return `${value} ${suit}`;
}

export function getNumFromBid(bid: string): number {
  const parts = bid.split(' ');
  const level = parseInt(parts[0], 10);
  const suit = parts[1];
  return (level - 1) * 5 + BID_SUITS.indexOf(suit as BidSuit);
}

function shuffle(deck: Card[]): void {
  const arr = new Uint32Array(deck.length);
  crypto.getRandomValues(arr);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = arr[i] % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

export function getPoints(hand: Card[]): number {
  let points = 0;
  const count: Record<Suit, number> = { '♣': 0, '♦': 0, '♥': 0, '♠': 0 };
  for (const card of hand) {
    count[card.suit]++;
    if (card.value === 'A') points += 4;
    else if (card.value === 'K') points += 3;
    else if (card.value === 'Q') points += 2;
    else if (card.value === 'J') points += 1;
  }
  for (const suit of CARD_SUITS) {
    if (count[suit] >= 5) {
      points += count[suit] - 4;
    }
  }
  return points;
}

function washRequired(hands: Card[][]): boolean {
  for (const hand of hands) {
    if (getPoints(hand) <= POINTS_TO_WASH) return true;
  }
  return false;
}

export function generateHands(): Hand[] {
  const deck = [...DECK_OF_52];
  let tempHands: Card[][];

  shuffle(deck);
  tempHands = [];
  for (let i = 0; i < DECK_SIZE; i += HAND_SIZE) {
    tempHands.push(deck.slice(i, i + HAND_SIZE));
  }

  while (washRequired(tempHands)) {
    shuffle(deck);
    tempHands = [];
    for (let i = 0; i < DECK_SIZE; i += HAND_SIZE) {
      tempHands.push(deck.slice(i, i + HAND_SIZE));
    }
  }

  const hands: Hand[] = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const hand: Hand = { '♣': [], '♦': [], '♥': [], '♠': [] };
    for (const card of tempHands[i]) {
      hand[card.suit].push(card.value);
    }
    for (const suit of CARD_SUITS) {
      hand[suit].sort((a, b) => getNumFromValue(b) - getNumFromValue(a));
    }
    hands.push(hand);
  }
  return hands;
}

export function generateHandString(hand: Hand): string {
  const lines: string[] = [];
  for (const suit of CARD_SUITS) {
    if (hand[suit].length) {
      lines.push(`${suit}  -  ${hand[suit].join(', ')}`);
    } else {
      lines.push(`${suit}  -  🚫`);
    }
  }
  return lines.join('\n');
}

export function getValidSuits(
  hand: Hand,
  trumpSuit: BidSuit | null = null,
  currentSuit: Suit | null = null,
  trumpBroken = false,
): Suit[] {
  let effectiveTrump: Suit | null = null;
  if (trumpSuit && trumpSuit !== '🚫') {
    effectiveTrump = trumpSuit;
  }

  const validSuits: Suit[] = [];

  if (currentSuit) {
    if (hand[currentSuit].length > 0) {
      return [currentSuit];
    }
    for (const suit of CARD_SUITS) {
      if (hand[suit].length > 0) validSuits.push(suit);
    }
  } else {
    for (const suit of CARD_SUITS) {
      if (hand[suit].length > 0 && (suit !== effectiveTrump || trumpBroken)) {
        validSuits.push(suit);
      }
    }
    if (validSuits.length === 0 && effectiveTrump) {
      validSuits.push(effectiveTrump);
    }
  }
  return validSuits;
}

export function compareCards(
  playedCards: string[],
  currentSuit: Suit,
  trumpSuit: BidSuit | null = null,
): number {
  let effectiveTrump: Suit | null = null;
  if (trumpSuit && trumpSuit !== '🚫') {
    effectiveTrump = trumpSuit;
  }

  let topPlayer = 0;
  let topParts = playedCards[0].split(' ');

  for (let i = 1; i < playedCards.length; i++) {
    const currentParts = playedCards[i].split(' ');
    const currentCardSuit = currentParts[1];
    const topCardSuit = topParts[1];

    if (
      (currentCardSuit === effectiveTrump && topCardSuit !== effectiveTrump) ||
      (currentCardSuit === currentSuit && topCardSuit !== effectiveTrump && topCardSuit !== currentSuit) ||
      (currentCardSuit === topCardSuit && getNumFromValue(currentParts[0]) > getNumFromValue(topParts[0]))
    ) {
      topPlayer = i;
      topParts = currentParts;
    }
  }
  return topPlayer;
}
